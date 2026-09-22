import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Repository } from '../src/git/repository.js';
import { Reviews } from '../src/core/reviews.js';
import { Synchronization } from '../src/core/sync.js';
import { canonical, mergeReviews } from '../src/core/reconciliation.js';
import { createServer } from '../src/server/app.js';
import { commentBody, isDeleted, recordVersion, reviewTitle } from '../src/core/changes.js';

const execute = promisify(execFile);

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

test('one sync shares notes and reviews, reconciles concurrent replies/revisions, and converges idempotently', async t => {
  const { a, b, sa, sb, refs } = await fixture(t);
  const head = await a.repository.resolve('HEAD');
  const note = await a.addComment({ commit: 'HEAD', body: 'Shared question' });
  const review = await a.createReview({ title: 'Shared review', base: 'HEAD', head: 'HEAD' });
  const question = await a.addReviewComment(review.id, { body: 'Why this design?' });
  assert.equal((await sa.sync()).uploaded, 2);
  assert.equal((await sb.sync()).downloaded, 2);
  assert.equal((await b.conversation('HEAD')).comments[0].id, note.id);
  assert.deepEqual(await a.review(review.id), await b.review(review.id));
  await a.addComment({ commit: 'HEAD', body: 'Alice reply', replyTo: note.id });
  await b.addComment({ commit: 'HEAD', body: 'Bob reply', replyTo: note.id });
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
  assert.deepEqual((await a.conversation(head)).comments, (await b.conversation(head)).comments);
  assert.equal((await a.conversation(head)).comments.length, 3);
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
  assert.equal((await b.conversation(orphan)).comments[0].id, comment.id);
  await b.deleteReview(review.id);
  await sb.sync();
  assert.equal((await b.review(review.id)).id, review.id);
});

test('conflicting immutable records stop all local publication and clean temporary refs', async t => {
  const { a, b, sa, sb, refs } = await fixture(t);
  const note = await a.addComment({ commit: 'HEAD', body: 'Original record' });
  await sa.sync(); await sb.sync();
  await b.repository.writeNote(note.commit, JSON.stringify([{ ...note, body: 'Changed the same ID' }]));
  const review = await a.createReview({ title: 'Must not be partially imported', base: 'HEAD', head: 'HEAD' });
  await sa.sync();
  const before = await refs(b.repository);
  await assert.rejects(sb.sync(), /Sync conflict: record/);
  assert.equal(await refs(b.repository), before);
  await assert.rejects(sb.receive(), /Sync conflict: record/);
  assert.equal(await refs(b.repository), before);
  await assert.rejects(b.review(review.id), /does not exist/);
  assert.equal((await a.conversation(note.commit)).comments[0].body, 'Original record');
});

test('a concurrent remote push rejects the whole upload and retry merges without losing local work', async t => {
  const { a, b, sa, sb, refs, origin } = await fixture(t);
  const note = await a.addComment({ commit: 'HEAD', body: 'Shared note' });
  await sa.sync(); await sb.sync();
  await a.addComment({ commit: 'HEAD', body: 'Alice pending', replyTo: note.id });
  const review = await a.createReview({ title: 'Atomic upload', base: 'HEAD', head: 'HEAD' });
  const network = a.repository.network.bind(a.repository);
  let raced = false;
  a.repository.network = async (...args: string[]) => {
    if (args[0] === 'push' && !raced) {
      raced = true;
      await b.addComment({ commit: 'HEAD', body: 'Bob concurrent', replyTo: note.id });
      await sb.sync();
    }
    return network(...args);
  };
  await assert.rejects(sa.sync(), /Sync upload failed.*saved locally/);
  assert.equal((await a.review(review.id)).id, review.id);
  const remoteRefs = await execute('git', ['-C', origin, 'for-each-ref', 'refs/git-discuss/reviews/']);
  assert.equal(remoteRefs.stdout, '');
  assert.ok(!(await refs(a.repository)).includes('refs/git-discuss/sync/'));
  await sa.sync(); await sb.sync();
  assert.equal((await b.conversation(note.commit)).comments.length, 3);
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
  assert.equal((await b.conversation('HEAD')).comments[0].body, 'API shared note');
  assert.equal((await b.review(review.id)).id, review.id);
});

test('concurrent edits converge, deleted comments preserve replies, and deleted reviews never resurrect', async t => {
  const { a, b, sa, sb } = await fixture(t);
  const note = await a.addComment({ commit: 'HEAD', body: 'Original note' });
  await a.addComment({ commit: 'HEAD', body: 'Reply survives', replyTo: note.id });
  const review = await a.createReview({ title: 'Original review', base: 'HEAD', head: 'HEAD' });
  const comment = await a.addReviewComment(review.id, { body: 'Original review comment' });
  await sa.sync(); await sb.sync();
  await a.changeCommitComment('HEAD', note.id, { kind: 'edit', body: 'Alice edit', expectedVersion: note.id });
  await b.changeCommitComment('HEAD', note.id, { kind: 'edit', body: 'Bob edit', expectedVersion: note.id });
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
  const mergedNote = (await a.conversation('HEAD')).comments[0];
  assert.equal(mergedNote.changes?.length, 2);
  assert.equal(commentBody(mergedNote), commentBody((await b.conversation('HEAD')).comments[0]));
  await a.changeCommitComment('HEAD', note.id, { kind: 'delete', expectedVersion: recordVersion(mergedNote) });
  await a.changeReview(review.id, { kind: 'delete', expectedVersion: recordVersion(left) });
  await b.addReviewComment(review.id, { body: 'Offline feedback while Alice deletes' });
  await sa.sync(); await sb.sync(); await sa.sync();
  assert.deepEqual(await a.listReviews(), []);
  assert.deepEqual(await b.listReviews(), []);
  const tombstone = await b.review(review.id);
  assert.ok(isDeleted(tombstone));
  assert.equal(tombstone.comments.length, 2);
  const notes = (await b.conversation('HEAD')).comments;
  assert.ok(isDeleted(notes[0]));
  assert.equal(notes[1].replyTo, note.id);
  assert.equal(notes[1].body, 'Reply survives');
  assert.equal((await sb.sync()).uploaded, 0);
});

test('receive-only checks reconcile incoming work without uploading local feedback or changing code branches', async t => {
  const { a, b, sa, sb, origin, refs } = await fixture(t);
  const head = await b.repository.resolve('HEAD');
  const note = await a.addComment({ commit: head, body: 'Shared note' });
  await sa.sync(); await sb.receive();
  await a.addComment({ commit: head, body: 'Team update', replyTo: note.id });
  await b.addComment({ commit: head, body: 'Private local reply', replyTo: note.id });
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
  assert.equal((await b.conversation(head)).comments.length, 3);
  assert.equal((await b.review(review.id)).title, 'Incoming review');
  assert.equal((await a.conversation(head)).comments.length, 2);
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
  await a.addComment({ commit: 'HEAD', body: 'Remote addition' });
  await sa.sync();
  const git = b.repository.git.bind(b.repository);
  let raced = false;
  b.repository.git = async (...args) => {
    if (args[0] === 'cat-file' && args[1] === 'blob' && !raced) {
      raced = true;
      await b.addComment({ commit: 'HEAD', body: 'Foreground save during receive' });
    }
    return git(...args);
  };
  await assert.rejects(sb.receive(), /cannot lock ref|expected|is at/);
  assert.deepEqual((await b.conversation('HEAD')).comments.map(item => item.body), ['Shared starting note', 'Foreground save during receive']);
  await sb.receive();
  assert.equal((await b.conversation('HEAD')).comments.length, 3);
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
  const deadline = Date.now() + 15000;
  let status: { revision: number; running: boolean; error: string | null };
  do {
    status = await (await fetch(`${address}/api/background-updates`, { headers })).json() as typeof status;
    if (Date.now() > deadline) throw new Error(`Background receive timed out: ${status.error}`);
    if (!status.revision) await new Promise(resolve => setTimeout(resolve, 50));
  } while (!status.revision);
  assert.equal(status.error, null);
  assert.equal((await b.conversation('HEAD')).comments[0].body, 'Background feedback');
  assert.equal((await execute('git', ['-C', origin, 'for-each-ref', '--format=%(refname) %(objectname)'])).stdout, before);
  const disabled = await fetch(`${address}/api/background-updates`, { method: 'POST', headers, body: '{"enabled":false,"remote":"origin"}' });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json() as { nextCheckAt: null }).nextCheckAt, null);
});
