import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Repository } from '../src/git/repository.js';
import { Reviews } from '../src/core/reviews.js';
import { Synchronization } from '../src/core/sync.js';
import { canonical, mergeReviews } from '../src/core/reconciliation.js';
import { createServer } from '../src/server/app.js';
import { isDeleted, isThreadResolved, recordVersion, reviewTitle, threadVersion } from '../src/core/changes.js';

const execute = promisify(execFile);

test('thread resolution syncs, but concurrent offline replies reopen the thread without losing status history', async t => {
  const { a, b, sa, sb } = await fixture(t);
  const review = await a.createReview({ title: 'Resolve across clones', base: 'HEAD', head: 'HEAD' });
  const root = await a.addReviewComment(review.id, { body: 'Question' });
  await sa.sync(); await sb.sync();
  let local = await a.review(review.id);
  await a.changeReviewComment(review.id, root.id, { kind: 'resolve', expectedVersion: root.id, expectedThread: threadVersion(local.comments, root.id) });
  // Bob has not received Alice's resolution and can still reply to his open copy.
  const incoming = await b.addReviewComment(review.id, { body: 'Offline follow-up', replyTo: root.id });
  await sa.sync(); await sb.sync(); await sa.receive();
  local = await a.review(review.id);
  assert.deepEqual(local, await b.review(review.id));
  assert.equal(isThreadResolved(local.comments[0], local.comments), false);
  assert.equal(local.comments[1].id, incoming.id);
  assert.equal(local.comments[0].changes?.[0].kind, 'resolve');
  await a.changeReviewComment(review.id, root.id, {
    kind: 'resolve', expectedVersion: recordVersion(local.comments[0]), expectedThread: threadVersion(local.comments, root.id),
  });
  await sa.sync(); await sb.receive();
  let remote = await b.review(review.id);
  assert.ok(isThreadResolved(remote.comments[0], remote.comments));
  await b.changeReviewComment(review.id, root.id, {
    kind: 'reopen', expectedVersion: recordVersion(remote.comments[0]), expectedThread: threadVersion(remote.comments, root.id),
  });
  await sb.sync(); await sa.receive();
  local = await a.review(review.id); remote = await b.review(review.id);
  assert.deepEqual(local, remote);
  assert.equal(isThreadResolved(local.comments[0], local.comments), false);
  assert.deepEqual(local.comments[0].changes?.map(item => item.kind), ['resolve', 'resolve', 'reopen']);
  assert.deepEqual((await sa.receive()).updatedRefs, []);
});

test('git-discuss.remote selects the default sync remote', async t => {
  const { a, sa, origin } = await fixture(t);
  await a.repository.git('remote', 'add', 'team', origin);
  await a.repository.setDiscussRemote('team');
  assert.equal(await a.repository.discussRemote(), 'team');
  assert.equal((await sa.sync()).remote, 'team');
});

test('divergent notes on different commits are both retained during sync', async t => {
  const { a, b, sa, sb } = await fixture(t);
  const first = await a.repository.resolve('HEAD');
  await b.repository.git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Bob code');
  const second = await b.repository.resolve('HEAD');
  await a.addComment({ commit: first, body: 'Alice note' });
  await b.addComment({ commit: second, body: 'Bob private note' });
  await sa.sync(); await sb.sync(); await sa.receive();
  for (const engine of [b, a]) {
    assert.equal((await engine.conversation(first)).note, 'Alice note');
    assert.equal((await engine.conversation(second)).note, 'Bob private note');
  }
});

test('conflicting raw note edits stop receive and sync without overwriting unpublished text', async t => {
  const { a, b, sa, sb, refs } = await fixture(t);
  const head = await a.repository.resolve('HEAD');
  await a.addComment({ commit: head, body: 'Shared starting note' });
  await sa.sync(); await sb.sync();
  await a.repository.writeNote(head, 'Alice replacement');
  await b.repository.writeNote(head, 'Bob unpublished replacement');
  await sa.sync();
  const before = await refs(b.repository);
  await assert.rejects(sb.receive(), /note conflict/i);
  await assert.rejects(sb.sync(), /note conflict/i);
  assert.equal(await refs(b.repository), before);
  assert.equal((await b.conversation(head)).note, 'Bob unpublished replacement');
  await b.repository.network('fetch', '--no-tags', '--refmap=', 'origin', 'refs/notes/git-discuss:refs/notes/git-discuss-incoming');
  await assert.rejects(b.repository.git('notes', '--ref=git-discuss', 'merge', '-s', 'manual', 'refs/notes/git-discuss-incoming'), /conflict|merge/i);
  const mergeDirectory = await b.repository.git('rev-parse', '--git-path', 'NOTES_MERGE_WORKTREE');
  await writeFile(path.resolve(b.repository.root, mergeDirectory, head), 'Alice replacement\n\nBob unpublished replacement');
  await b.repository.git('notes', '--ref=git-discuss', 'merge', '--commit');
  await sb.sync(); await sa.receive();
  assert.equal((await a.conversation(head)).note, 'Alice replacement\n\nBob unpublished replacement');
});

test('raw note deletion merges with an unrelated addition and preserves exact text', async t => {
  const { a, b, sa, sb } = await fixture(t);
  const head = await a.repository.resolve('HEAD');
  const original = await a.addComment({ commit: head, body: 'To remove' });
  await sa.sync(); await sb.sync();
  await a.addComment({ commit: head, action: 'delete', expectedVersion: original.noteVersion });
  const tree = await b.repository.git('rev-parse', 'HEAD^{tree}');
  const other = await b.repository.gitInput('Other code', 'commit-tree', tree);
  const text = '    code\nkeeps a line break  \nand trailing lines\n\n';
  await b.addComment({ commit: other, body: text });
  await sa.sync(); await sb.sync(); await sa.receive();
  for (const engine of [a, b]) {
    assert.equal((await engine.conversation(head)).note, null);
    assert.equal((await engine.conversation(other)).note, text);
  }
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'git-discuss-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const origin = path.join(directory, 'origin.git');
  const first = path.join(directory, 'alice');
  const second = path.join(directory, 'bob');
  await execute('git', ['init', '--bare', origin]);
  await execute('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  await execute('git', ['init', first]);
  const git = (...args: string[]) => execute('git', ['-C', first, ...args]);
  await git('config', 'user.name', 'Alice');
  await git('config', 'user.email', 'alice@example.test');
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Shared code');
  await git('remote', 'add', 'origin', origin);
  await git('push', 'origin', 'HEAD:refs/heads/main');
  await execute('git', ['clone', origin, second]);
  const a = new Reviews(await Repository.open(first));
  const b = new Reviews(await Repository.open(second));
  await b.repository.git('config', 'user.name', 'Bob');
  await b.repository.git('config', 'user.email', 'bob@example.test');
  const sa = new Synchronization(a.repository);
  const sb = new Synchronization(b.repository);
  const refs = (repository: Repository) => repository.git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/notes/', 'refs/git-discuss/');
  return { a, b, sa, sb, refs, origin };
}

test('one sync shares notes and reviews, reconciles concurrent note additions/revisions, and converges idempotently', async t => {
  const { a, b, sa, sb, refs } = await fixture(t);
  const head = await a.repository.resolve('HEAD');
  const note = await a.addComment({ commit: 'HEAD', body: 'Shared question' });
  const review = await a.createReview({ title: 'Shared review', base: 'HEAD', head: 'HEAD' });
  const question = await a.addReviewComment(review.id, { body: 'Why this design?' });
  assert.equal((await sa.sync()).uploaded, 2);
  assert.equal((await sb.sync()).downloaded, 2);
  assert.equal(note.body, 'Shared question');
  assert.equal((await b.conversation('HEAD')).note, 'Shared question');
  assert.deepEqual(await a.review(review.id), await b.review(review.id));
  await a.addComment({ commit: 'HEAD', action: 'append', body: '\nAlice note' });
  await b.addComment({ commit: 'HEAD', action: 'append', body: '\nBob note' });
  const tree = await a.repository.git('rev-parse', 'HEAD^{tree}');
  const aliceHead = await a.repository.gitInput('Alice revised code', 'commit-tree', tree);
  const bobHead = await b.repository.gitInput('Bob revised code', 'commit-tree', tree);
  const ar = await a.addRevision(review.id, { base: head, head: aliceHead });
  const br = await b.addRevision(review.id, { base: head, head: bobHead });
  await a.addReviewComment(review.id, { body: 'Alice reasoning', revisionId: ar.revisions[1].id, replyTo: question.id });
  await b.addReviewComment(review.id, { body: 'Bob reasoning', revisionId: br.revisions[1].id, replyTo: question.id });
  const left = await a.review(review.id);
  const right = await b.review(review.id);
  assert.equal(canonical(mergeReviews(left, right)), canonical(mergeReviews(right, left)));
  const extra = await b.createReview({ title: 'Bob-only review', base: head, head: bobHead });
  await sa.sync();
  const merged = await sb.sync();
  assert.equal(merged.merged, 2);
  assert.equal(merged.uploaded, 3);
  await sa.sync();
  const saved = await a.review(review.id);
  assert.equal(saved.revisions.length, 3);
  assert.equal(saved.comments.length, 3);
  assert.deepEqual(saved, await b.review(review.id));
  assert.equal((await a.review(extra.id)).title, 'Bob-only review');
  const leftNote = (await a.conversation(head)).note;
  const rightNote = (await b.conversation(head)).note;
  assert.equal(leftNote, rightNote);
  assert.ok(leftNote?.includes('Shared question'));
  assert.ok(leftNote?.includes('Alice note') && leftNote?.includes('Bob note'));
  const before = await refs(a.repository);
  const noop = await sa.sync();
  assert.equal(noop.uploaded, 0);
  assert.equal(noop.downloaded, 0);
  assert.equal(noop.unchanged, 3);
  assert.equal(await refs(a.repository), before);
  assert.equal(await refs(b.repository), before);
  await b.repository.git('reflog', 'expire', '--expire=now', '--all');
  await b.repository.git('gc', '--prune=now');
  assert.equal(await b.repository.resolve(aliceHead), aliceHead);
  assert.equal(await a.repository.resolve(bobHead), bobHead);
  for (const engine of [a, b]) {
    assert.equal(await engine.repository.resolve('HEAD'), head);
    assert.equal(await engine.repository.git('status', '--porcelain'), '');
    assert.equal(await engine.repository.git('for-each-ref', 'refs/git-discuss/sync/'), '');
  }
});

test('sync transfers code retained only by a commit note and local deletion is not propagated', async t => {
  const { a, b, sa, sb } = await fixture(t);
  const tree = await a.repository.git('rev-parse', 'HEAD^{tree}');
  const orphan = await a.repository.gitInput('Unpushed code', 'commit-tree', tree);
  const comment = await a.addComment({ commit: orphan, body: 'Reasoning about unpushed code' });
  const review = await a.createReview({ title: 'Retained remote review', base: 'HEAD', head: 'HEAD' });
  await sa.sync();
  await sb.sync();
  assert.equal(comment.body, 'Reasoning about unpushed code');
  assert.equal((await b.conversation(orphan)).note, 'Reasoning about unpushed code');
  await b.deleteReview(review.id);
  await sb.sync();
  assert.equal((await b.review(review.id)).id, review.id);
});

test('a one-sided note edit is retained while importing unrelated review refs', async t => {
  const { a, b, sa, sb, refs } = await fixture(t);
  const note = await a.addComment({ commit: 'HEAD', body: 'Original record' });
  await sa.sync(); await sb.sync();
  await b.repository.writeNote(note.commit, 'Changed remotely');
  const review = await a.createReview({ title: 'Must not be partially imported', base: 'HEAD', head: 'HEAD' });
  await sa.sync();
  assert.equal((await b.conversation(note.commit)).note, 'Changed remotely');
  const merged = await sb.sync();
  assert.ok(merged.downloaded >= 1);
  const after = await refs(b.repository);
  assert.ok(after.includes('refs/notes/git-discuss'));
  assert.ok(after.includes(`refs/git-discuss/reviews/${review.id}`));
  assert.equal((await b.conversation(note.commit)).note, 'Changed remotely');
  const received = await sb.receive();
  assert.deepEqual(received.updatedRefs, []);
  assert.equal(await refs(b.repository), after);
  assert.equal((await b.review(review.id)).id, review.id);
  assert.equal((await a.conversation(note.commit)).note, 'Original record');
});

test('a concurrent remote push rejects the whole upload and retry merges without losing local work', async t => {
  const { a, b, sa, sb, refs, origin } = await fixture(t);
  const note = await a.addComment({ commit: 'HEAD', body: 'Shared note' });
  await sa.sync(); await sb.sync();
  await a.addComment({ commit: 'HEAD', action: 'append', body: '\nAlice pending' });
  const review = await a.createReview({ title: 'Atomic upload', base: 'HEAD', head: 'HEAD' });
  const network = a.repository.network.bind(a.repository);
  let raced = false;
  a.repository.network = async (...args: string[]) => {
    if (args[0] === 'push' && !raced) {
      raced = true;
      await b.addComment({ commit: 'HEAD', action: 'append', body: '\nBob concurrent' });
      await sb.sync();
    }
    return network(...args);
  };
  await assert.rejects(sa.sync(), /Sync upload failed.*saved locally/);
  assert.equal((await a.review(review.id)).id, review.id);
  const remoteRefs = await execute('git', ['-C', origin, 'for-each-ref', 'refs/git-discuss/reviews/']);
  assert.equal(remoteRefs.stdout, '');
  assert.equal(await a.repository.git('for-each-ref', 'refs/git-discuss/sync/'), '');
  await sa.sync(); await sb.sync();
  const noteText = (await b.conversation(note.commit)).note;
  assert.ok(noteText?.includes('Shared note'));
  assert.ok(noteText?.includes('Alice pending') && noteText?.includes('Bob concurrent'));
  assert.equal((await b.review(review.id)).title, 'Atomic upload');
});

test('sync validates remotes, reports connection failures, and shares the application lock', async t => {
  const { a, sa, refs } = await fixture(t);
  await assert.rejects(sa.sync({ remote: '--all' }), /not configured/);
  await assert.rejects(sa.sync({ remote: 'missing' }), /not configured/);
  await a.repository.withWriteLock(async () => {
    await assert.rejects(sa.sync(), /write is active/);
  });
  const before = await refs(a.repository);
  const network = a.repository.network.bind(a.repository);
  a.repository.network = async () => { throw new Error('Network unavailable'); };
  await assert.rejects(sa.sync(), /before changing local discussion refs.*\nNetwork unavailable/);
  assert.equal(await refs(a.repository), before);
  a.repository.network = network;
  assert.equal((await sa.sync()).uploaded, 0);
  const head = await a.repository.resolve('HEAD');
  await a.repository.git('symbolic-ref', 'refs/notes/git-discuss', await a.repository.git('symbolic-ref', 'HEAD'));
  await assert.rejects(sa.sync(), /Symbolic discussion ref/);
  assert.equal(await a.repository.resolve('HEAD'), head);
});

test('sync API authenticates requests and shares both discussion stores through the configured remote', async t => {
  const { a, b, sb } = await fixture(t);
  const { app, token } = await createServer(a);
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${address}/api/remotes`)).status, 401);
  assert.equal((await fetch(`${address}/api/sync`, { method: 'POST', body: '{}' })).status, 401);
  assert.deepEqual(await (await fetch(`${address}/api/remotes`, { headers })).json(), ['origin']);
  assert.equal((await fetch(`${address}/api/sync`, { method: 'POST', headers: { ...headers, Origin: 'https://example.test' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${address}/api/sync`, { method: 'POST', headers, body: '{"remote":"--all"}' })).status, 400);
  await a.addComment({ commit: 'HEAD', body: 'API shared note' });
  const review = await a.createReview({ title: 'API shared review', base: 'HEAD', head: 'HEAD' });
  const response = await fetch(`${address}/api/sync`, { method: 'POST', headers, body: '{"remote":"origin"}' });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { uploaded: number }).uploaded, 2);
  await sb.sync();
  assert.equal((await b.conversation('HEAD')).note, 'API shared note');
  assert.equal((await b.review(review.id)).id, review.id);
});

test('review edits converge and note deletions propagate without resurrecting reviews', async t => {
  const { a, b, sa, sb } = await fixture(t);
  await a.addComment({ commit: 'HEAD', body: 'Original note' });
  const review = await a.createReview({ title: 'Original review', base: 'HEAD', head: 'HEAD' });
  const comment = await a.addReviewComment(review.id, { body: 'Original review comment' });
  await sa.sync(); await sb.sync();
  await a.addComment({ commit: 'HEAD', action: 'edit', body: 'Alice edit', expectedVersion: (await a.conversation('HEAD')).noteVersion });
  await a.changeReview(review.id, { kind: 'rename', title: 'Alice title', expectedVersion: review.id });
  await b.changeReview(review.id, { kind: 'rename', title: 'Bob title', expectedVersion: review.id });
  await a.changeReviewComment(review.id, comment.id, { kind: 'delete', expectedVersion: comment.id });
  await b.changeReviewComment(review.id, comment.id, { kind: 'edit', body: 'Concurrent with deletion', expectedVersion: comment.id });
  await sa.sync(); await sb.sync(); await sa.sync();
  const left = await a.review(review.id);
  const right = await b.review(review.id);
  assert.deepEqual(left, right);
  assert.equal(left.changes?.length, 2);
  assert.equal(reviewTitle(left), reviewTitle(right));
  assert.ok(isDeleted(left.comments[0]));
  assert.equal(left.comments[0].changes?.length, 2);
  const mergedNote = (await a.conversation('HEAD')).note;
  assert.equal(mergedNote, (await b.conversation('HEAD')).note);
  assert.equal(mergedNote, 'Alice edit');
  await a.addComment({ commit: 'HEAD', action: 'delete', body: '', expectedVersion: (await a.conversation('HEAD')).noteVersion });
  await a.changeReview(review.id, { kind: 'delete', expectedVersion: recordVersion(left) });
  await b.addReviewComment(review.id, { body: 'Offline feedback while Alice deletes' });
  await sa.sync(); await sb.sync(); await sa.sync();
  assert.deepEqual(await a.listReviews(), []);
  assert.deepEqual(await b.listReviews(), []);
  const tombstone = await b.review(review.id);
  assert.ok(isDeleted(tombstone));
  assert.equal(tombstone.comments.length, 2);
  assert.equal((await b.conversation('HEAD')).note, null);
  assert.equal((await sb.sync()).uploaded, 0);
});

test('receive-only checks reconcile incoming work without uploading local feedback or changing code branches', async t => {
  const { a, b, sa, sb, origin, refs } = await fixture(t);
  const head = await b.repository.resolve('HEAD');
  await a.addComment({ commit: head, body: 'Shared note' });
  await sa.sync(); await sb.receive();
  await a.addComment({ commit: head, action: 'append', body: '\nTeam update' });
  await b.addComment({ commit: head, action: 'append', body: '\nPrivate local note' });
  const review = await a.createReview({ title: 'Incoming review', base: head, head });
  await sa.sync();
  const beforeRemote = (await execute('git', ['-C', origin, 'for-each-ref', '--format=%(refname) %(objectname)'])).stdout;
  const network = b.repository.networkWithSignal.bind(b.repository);
  b.repository.networkWithSignal = async (signal, ...args) => {
    assert.notEqual(args[0], 'push');
    return network(signal, ...args);
  };
  const result = await sb.receive();
  assert.equal(result.updatedRefs.length, 2);
  const mergedNote = (await b.conversation(head)).note;
  assert.ok(mergedNote?.includes('Shared note'));
  assert.ok(mergedNote?.includes('Team update') && mergedNote?.includes('Private local note'));
  assert.equal((await b.review(review.id)).title, 'Incoming review');
  assert.ok((await a.conversation(head)).note?.includes('Team update'));
  assert.equal((await execute('git', ['-C', origin, 'for-each-ref', '--format=%(refname) %(objectname)'])).stdout, beforeRemote);
  const before = await refs(b.repository);
  assert.deepEqual((await sb.receive()).updatedRefs, []);
  assert.equal(await refs(b.repository), before);
  assert.equal(await b.repository.resolve('HEAD'), head);
  assert.equal(await b.repository.git('status', '--porcelain'), '');
  assert.equal(await b.repository.git('for-each-ref', 'refs/git-discuss/background/'), '');
});

test('receive-only publication rejects stale local inputs and retries without losing foreground saves', async t => {
  const { a, b, sa, sb } = await fixture(t);
  await a.addComment({ commit: 'HEAD', body: 'Shared starting note' });
  await sa.sync(); await sb.receive();
  await a.addComment({ commit: 'HEAD', action: 'append', body: 'Remote addition' });
  await sa.sync();
  const git = b.repository.gitRaw.bind(b.repository);
  let raced = false;
  b.repository.gitRaw = async (...args) => {
    if (args[0] === 'cat-file' && args[1] === 'blob' && !raced) {
      raced = true;
      await b.addComment({ commit: 'HEAD', action: 'append', body: 'Foreground save during receive' });
    }
    return git(...args);
  };
  await assert.rejects(sb.receive(), /cannot lock ref|expected|is at/);
  assert.ok((await b.conversation('HEAD')).note?.includes('Foreground save during receive'));
  await sb.receive();
  assert.ok((await b.conversation('HEAD')).note?.includes('Remote addition'));
  assert.ok((await b.conversation('HEAD')).note?.includes('Foreground save during receive'));
  assert.equal(await b.repository.git('for-each-ref', 'refs/git-discuss/background/'), '');
});

test('background update APIs are authenticated and receive data while leaving remote refs untouched', async t => {
  const { a, b, sa, origin } = await fixture(t);
  await a.addComment({ commit: 'HEAD', body: 'Background feedback' });
  await sa.sync();
  const before = (await execute('git', ['-C', origin, 'for-each-ref', '--format=%(refname) %(objectname)'])).stdout;
  const { app, token } = await createServer(b);
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${address}/api/background-updates`)).status, 401);
  assert.equal((await fetch(`${address}/api/background-updates/check`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${address}/api/background-updates`, { method: 'POST', headers: { ...headers, Origin: 'https://example.test' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${address}/api/background-updates`, { method: 'POST', headers, body: '{"enabled":true,"remote":"missing"}' })).status, 400);
  assert.equal((await fetch(`${address}/api/background-updates`, { method: 'POST', headers, body: '{"enabled":true,"remote":"origin"}' })).status, 200);
  assert.equal(await b.repository.git('config', '--get', 'git-discuss.updates.enabled'), 'true');
  assert.equal(await b.repository.git('config', '--get', 'git-discuss.remote'), 'origin');
  const deadline = Date.now() + 15000;
  let status: { revision: number; running: boolean; error: string | null };
  do {
    status = await (await fetch(`${address}/api/background-updates`, { headers })).json() as typeof status;
    if (Date.now() > deadline) throw new Error(`Background receive timed out: ${status.error}`);
    if (!status.revision) await new Promise(resolve => setTimeout(resolve, 50));
  } while (!status.revision);
  assert.equal(status.error, null);
  assert.equal((await b.conversation('HEAD')).note, 'Background feedback');
  assert.equal((await execute('git', ['-C', origin, 'for-each-ref', '--format=%(refname) %(objectname)'])).stdout, before);
  const disabled = await fetch(`${address}/api/background-updates`, { method: 'POST', headers, body: '{"enabled":false,"remote":"origin"}' });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json() as { nextCheckAt: null }).nextCheckAt, null);
  assert.equal(await b.repository.git('config', '--get', 'git-discuss.updates.enabled'), 'false');
});

test('git-discuss.updates.enabled restores background checks when the server starts', async t => {
  const { a } = await fixture(t);
  await a.repository.setDiscussUpdatesEnabled(true);
  const { app, token } = await createServer(a);
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const status = await (await fetch(`${address}/api/background-updates`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json() as { enabled: boolean; remote: string | null };
  assert.equal(status.enabled, true);
  assert.equal(status.remote, 'origin');
});
