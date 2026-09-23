import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Repository } from '../src/git/repository.js';
import { Reviews } from '../src/core/reviews.js';
import { createServer } from '../src/server/app.js';
import { resolveIdentifier, shortIdentifier } from '../src/core/identifiers.js';
import { commentBody, isDeleted, isThreadResolved, recordVersion, reviewTitle, threadRoot, threadStatus, threadVersion } from '../src/core/changes.js';

const execute = promisify(execFile);

test('threads resolve and reopen with history, stale-reply protection, and independent thread state', async t => {
  const { directory, engine } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const review = await engine.createReview({ title: 'Thread lifecycle', base: 'HEAD', head: 'HEAD' });
  const root = await engine.addReviewComment(review.id, { body: 'Please explain this design' });
  const oldThread = threadVersion((await engine.review(review.id)).comments, root.id);
  const reply = await engine.addReviewComment(review.id, { body: 'Explanation', replyTo: root.id });
  const nested = await engine.addReviewComment(review.id, { body: 'Follow-up', replyTo: reply.id });
  const other = await engine.addReviewComment(review.id, { body: 'Separate question' });
  await assert.rejects(engine.changeReviewComment(review.id, root.id, {
    kind: 'resolve', expectedVersion: root.id, expectedThread: oldThread,
  }), /thread changed/);
  let state = await engine.review(review.id);
  assert.equal(threadRoot(state.comments, nested.id)?.id, root.id);
  await assert.rejects(engine.changeReviewComment(review.id, reply.id, {
    kind: 'resolve', expectedVersion: reply.id, expectedThread: threadVersion(state.comments, reply.id),
  }), /first comment/);
  state = await engine.changeReviewComment(review.id, root.id, {
    kind: 'resolve', expectedVersion: root.id, expectedThread: threadVersion(state.comments, root.id),
  });
  assert.ok(isThreadResolved(state.comments[0], state.comments));
  assert.equal(threadStatus(state.comments[0])?.author.name, 'Review Tester');
  assert.equal(state.comments[0].body, root.body);
  assert.equal(isThreadResolved(state.comments.find(item => item.id === other.id)!, state.comments), false);
  await engine.addReviewComment(review.id, { body: 'Another thread can continue', replyTo: other.id });
  state = await engine.review(review.id);
  assert.ok(isThreadResolved(state.comments[0], state.comments), 'Activity in another thread must not reopen this one');
  await assert.rejects(engine.addReviewComment(review.id, { body: 'Must reopen first', replyTo: nested.id }), /thread is resolved/);
  await assert.rejects(engine.changeReviewComment(review.id, root.id, {
    kind: 'reopen', expectedVersion: root.id, expectedThread: threadVersion(state.comments, root.id),
  }), /changed since/);
  state = await engine.changeReviewComment(review.id, root.id, {
    kind: 'reopen', expectedVersion: recordVersion(state.comments[0]), expectedThread: threadVersion(state.comments, root.id),
  });
  assert.equal(isThreadResolved(state.comments[0], state.comments), false);
  assert.deepEqual(state.comments[0].changes?.map(item => item.kind), ['resolve', 'reopen']);
  await engine.addReviewComment(review.id, { body: 'Reply after reopening', replyTo: nested.id });
  state = await engine.review(review.id);
  state = await engine.changeReviewComment(review.id, root.id, {
    kind: 'resolve', expectedVersion: recordVersion(state.comments[0]), expectedThread: threadVersion(state.comments, root.id),
  });
  state = await engine.changeReviewComment(review.id, reply.id, { kind: 'edit', body: 'Revised explanation', expectedVersion: reply.id });
  assert.equal(isThreadResolved(state.comments[0], state.comments), false, 'An edited reply must not remain hidden as resolved');
  state = await engine.changeReviewComment(review.id, root.id, { kind: 'delete', expectedVersion: recordVersion(state.comments[0]) });
  state = await engine.changeReviewComment(review.id, root.id, {
    kind: 'resolve', expectedVersion: recordVersion(state.comments[0]), expectedThread: threadVersion(state.comments, root.id),
  });
  assert.ok(isDeleted(state.comments[0]));
  assert.ok(isThreadResolved(state.comments[0], state.comments));
  assert.equal(commentBody(state.comments.find(item => item.id === reply.id)!), 'Revised explanation');
  const reopened = new Reviews(await Repository.open(directory));
  assert.deepEqual(await reopened.review(review.id), state);
});

test('Git details include code identities, original timestamps, and all parent SHAs independently of note authors', async t => {
  const { directory, engine } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = await engine.conversation('HEAD');
  assert.deepEqual(initial.commitDetails.parents, []);
  assert.equal(initial.commitDetails.author.name, 'Review Tester');
  const tree = initial.commitDetails.tree;
  const side = await engine.repository.gitInput('Side commit', 'commit-tree', tree, '-p', initial.commit);
  const authoredAt = '2020-01-02T03:04:05+02:30';
  const committedAt = '2021-02-03T04:05:06-04:00';
  const { stdout } = await execute('git', ['-C', directory, '-c', 'commit.gpgsign=false', 'commit-tree', tree,
    '-p', initial.commit, '-p', side, '-m', 'Merged code'], { env: { ...process.env,
    GIT_AUTHOR_NAME: 'Code Author', GIT_AUTHOR_EMAIL: 'author@example.test', GIT_AUTHOR_DATE: authoredAt,
    GIT_COMMITTER_NAME: 'Integrator', GIT_COMMITTER_EMAIL: 'integrator@example.test', GIT_COMMITTER_DATE: committedAt,
  } });
  const commit = stdout.trim();
  const before = await engine.conversation(commit);
  assert.deepEqual(before.commitDetails, {
    tree, parents: [initial.commit, side],
    author: { name: 'Code Author', email: 'author@example.test' }, authoredAt,
    committer: { name: 'Integrator', email: 'integrator@example.test' }, committedAt,
  });
  assert.equal(before.noteVersion, null);
  const saved = await engine.addComment({ commit, body: 'Note from a different person' });
  const after = await engine.conversation(commit);
  assert.equal(saved.author.name, 'Review Tester');
  assert.deepEqual(after.commitDetails, before.commitDetails);
  assert.equal(after.noteVersion, await engine.repository.git('notes', '--ref=git-discuss', 'list', commit));
});

test('raw notes preserve Markdown whitespace and reject stale or unversioned replacement', async t => {
  const { directory, engine } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const text = '    indented code\nline break  \nnext line\n\n';
  const saved = await engine.addComment({ commit: 'HEAD', body: text, action: 'add', expectedVersion: null });
  assert.equal(saved.note, text);
  assert.ok(saved.noteVersion);
  const first = await engine.conversation('HEAD');
  assert.equal(first.note, text);
  assert.equal(first.noteVersion, saved.noteVersion);
  const edited = await engine.addComment({ commit: 'HEAD', body: 'Changed by another writer', action: 'edit', expectedVersion: first.noteVersion });
  await assert.rejects(engine.addComment({ commit: 'HEAD', body: 'Stale edit', action: 'edit', expectedVersion: first.noteVersion }), /changed since/);
  await assert.rejects(engine.addComment({ commit: 'HEAD', action: 'delete', expectedVersion: first.noteVersion }), /changed since/);
  await assert.rejects(engine.addComment({ commit: 'HEAD', body: 'Unversioned overwrite' }), /version is required/);
  assert.equal((await engine.conversation('HEAD')).note, 'Changed by another writer');
  const deleted = await engine.addComment({ commit: 'HEAD', action: 'delete', expectedVersion: edited.noteVersion });
  assert.equal(deleted.note, null); assert.equal(deleted.noteVersion, null);
  await engine.repository.writeNote(first.commit, '');
  const empty = await engine.conversation(first.commit);
  assert.equal(empty.note, ''); assert.ok(empty.noteVersion);
  await engine.addComment({ commit: first.commit, action: 'delete', expectedVersion: empty.noteVersion });
  assert.equal((await engine.conversation(first.commit)).note, null);
});

test('notes built by appending can be edited as a whole and over-limit appends do not write', async t => {
  const { directory, engine } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await engine.addComment({ commit: 'HEAD', body: 'x'.repeat(20000) });
  const appended = await engine.addComment({ commit: 'HEAD', action: 'append', body: 'y'.repeat(20000) });
  const edited = await engine.addComment({ commit: 'HEAD', action: 'edit', body: appended.note!.replace('x', 'z'), expectedVersion: appended.noteVersion });
  assert.equal(edited.note?.length, 40002);
  assert.ok(edited.note?.startsWith('z'));
  await assert.rejects(engine.addComment({ commit: 'HEAD', action: 'append', body: 'a'.repeat(60000) }), /cannot exceed/);
  assert.equal((await engine.conversation('HEAD')).note, edited.note);
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'git-discuss-test-'));
  const git = (...args: string[]) => execute('git', ['-C', directory, ...args]);
  await git('init');
  await git('config', 'user.name', 'Review Tester');
  await git('config', 'user.email', 'tester@example.test');
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial revision');
  return { directory, git, engine: new Reviews(await Repository.open(directory)) };
}

test('commit notes stay flat while retaining edit/delete history and code anchoring', async t => {
  const { directory, git, engine } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = await engine.conversation('HEAD');
  assert.deepEqual(initial.comments, []);
  assert.equal(initial.note, null);
  await engine.addComment({ commit: 'HEAD', body: 'Why this approach? 🌱' });
  await engine.addComment({ commit: 'HEAD', action: 'append', body: '\nPreserves offline context.' });
  // Exercises stdin storage beyond Windows command-line length limits.
  await engine.addComment({ commit: 'HEAD', action: 'append', body: `\n${'x'.repeat(19999)}` });
  await engine.addComment({ commit: 'HEAD', action: 'append', body: `\n${'y'.repeat(19999)}` });
  const reopened = new Reviews(await Repository.open(directory));
  const result = await reopened.conversation('HEAD');
  assert.equal(result.commit, initial.commit);
  assert.deepEqual(result.comments, []);
  assert.ok(result.note);
  assert.ok(result.note.length > 40000);
  assert.equal((await git('status', '--porcelain')).stdout, '');
  assert.equal((await git('rev-list', '--count', 'refs/notes/git-discuss')).stdout.trim(), '4');
});

test('edits retain history, reject stale versions, and deletions do not remove other notes', async t => {
  const { directory, engine, git } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = await engine.repository.resolve('HEAD');
  const note = await engine.addComment({ commit: 'HEAD', body: 'Original note' });
  assert.equal(note.author.name, 'Review Tester');
  await assert.rejects(engine.addComment({ commit: 'HEAD', action: 'add', body: 'Duplicate add' }), /already exists/);
  await assert.rejects(engine.addComment({ commit: 'HEAD', action: 'edit', body: '   ', expectedVersion: note.noteVersion }), /cannot be empty/);
  await engine.addComment({ commit: 'HEAD', action: 'edit', body: 'Updated note', expectedVersion: note.noteVersion });
  assert.equal((await engine.conversation(original)).note, 'Updated note');
  await engine.addComment({ commit: 'HEAD', action: 'delete', body: '', expectedVersion: (await engine.conversation('HEAD')).noteVersion });
  assert.equal((await engine.conversation(original)).note, null);
  await assert.rejects(engine.addComment({ commit: 'HEAD', action: 'append', body: 'Again' }), /before appending/);
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Another commit');
  await engine.addComment({ commit: 'HEAD', body: 'Second note remains' });
  assert.equal((await engine.conversation('HEAD')).note, 'Second note remains');
  assert.equal((await engine.conversation(original)).note, null);
  const reopened = new Reviews(await Repository.open(directory));
  assert.equal((await reopened.conversation('HEAD')).note, 'Second note remains');

  const review = await engine.createReview({ title: 'Original title', base: 'HEAD', head: 'HEAD' });
  const comment = await engine.addReviewComment(review.id, { body: 'Review comment' });
  const renamed = await engine.changeReview(review.id, { kind: 'rename', title: 'Updated title', expectedVersion: review.id });
  assert.equal(reviewTitle(renamed), 'Updated title');
  assert.equal(renamed.title, 'Original title');
  await assert.rejects(engine.changeReview(review.id, { kind: 'rename', title: 'Stale', expectedVersion: review.id }), /changed since/);
  const updated = await engine.changeReviewComment(review.id, comment.id, { kind: 'edit', body: 'New reasoning', expectedVersion: comment.id });
  assert.equal(commentBody(updated.comments[0]), 'New reasoning');
  await assert.rejects(engine.changeReviewComment(review.id, '11111111-1111-4111-8111-111111111111', { kind: 'delete', expectedVersion: '11111111-1111-4111-8111-111111111111' }), /Comment does not exist/);
  const removed = await engine.changeReview(review.id, { kind: 'delete', expectedVersion: recordVersion(renamed) });
  assert.ok(isDeleted(removed));
  assert.equal((await engine.listReviews()).length, 0);
  assert.ok(isDeleted(await reopened.review(review.id)));
  await assert.rejects(engine.addReviewComment(review.id, { body: 'New feedback' }), /was deleted/);
  await assert.rejects(engine.addRevision(review.id, { base: 'HEAD', head: 'HEAD' }), /was deleted/);
});

test('mutation API requires authentication and validates edits and deletion targets', async t => {
  const { directory, engine } = await fixture();
  const { app, token } = await createServer(engine);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const review = await engine.createReview({ title: 'API edit', base: 'HEAD', head: 'HEAD' });
  const comment = await engine.addReviewComment(review.id, { body: 'Before' });
  const endpoint = `${address}/api/reviews/${review.id}/comments/${comment.id}/change`;
  const body = JSON.stringify({ kind: 'edit', body: 'After', expectedVersion: comment.id });
  assert.equal((await fetch(endpoint, { method: 'POST', body })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://example.test' }, body })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body })).status, 200);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body })).status, 400);
  const current = await engine.review(review.id);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({
    kind: 'resolve', expectedVersion: recordVersion(current.comments[0]),
  }) })).status, 400);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({
    kind: 'resolve', expectedVersion: recordVersion(current.comments[0]), expectedThread: threadVersion(current.comments, comment.id),
  }) })).status, 200);
  assert.ok(isThreadResolved((await engine.review(review.id)).comments[0], (await engine.review(review.id)).comments));
  assert.equal((await fetch(`${address}/api/reviews/${review.id}/change`, { method: 'POST', headers,
    body: JSON.stringify({ kind: 'delete', expectedVersion: review.id }) })).status, 200);
  assert.deepEqual(await (await fetch(`${address}/api/reviews`, { headers })).json(), []);
  const note = await engine.addComment({ commit: 'HEAD', body: 'Note to delete' });
  assert.equal((await fetch(`${address}/api/comments`, { method: 'POST', headers,
    body: JSON.stringify({ commit: note.commit, action: 'delete', body: '', expectedVersion: note.noteVersion }) })).status, 201);
  assert.equal((await engine.conversation('HEAD')).note, null);
});

test('validates note input; lock blocks concurrent writers and releases after failure', async t => {
  const { directory, engine } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(engine.addComment({ commit: 'HEAD', body: '   ' }));
  await assert.rejects(engine.addComment({ commit: '--all', body: 'test' }), /Cannot resolve/);
  await assert.rejects(
    engine.addComment({ commit: 'HEAD', body: 'reply', replyTo: '11111111-1111-4111-8111-111111111111' } as unknown as never),
    /Unrecognized key/
  );
  await mkdir(path.join(directory, '.git', 'git-discuss.lock'));
  await assert.rejects(engine.addComment({ commit: 'HEAD', body: 'blocked' }), /write is active/);
  await rm(path.join(directory, '.git', 'git-discuss.lock'), { recursive: true });
  await engine.addComment({ commit: 'HEAD', body: 'works' });
  assert.equal((await engine.conversation('HEAD')).note, 'works');
});

test('comments remain anchored to original commit after branch advances', async t => {
  const { directory, git, engine } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const comment = await engine.addComment({ commit: 'HEAD', body: 'Original revision' });
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Next revision');
  assert.equal((await engine.conversation('HEAD')).note, null);
  assert.equal((await engine.conversation(comment.commit)).note, 'Original revision');
});

test('commit note counts include notes, exclude deletions, and isolate each commit from review comments', async t => {
  const { directory, git, engine } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = await engine.repository.resolve('HEAD');
  assert.equal((await engine.repository.commits()).commits[0].noteCount, 0);
  await engine.addComment({ commit: original, body: 'Question' });
  await engine.addComment({ commit: original, action: 'edit', body: 'Answer', expectedVersion: (await engine.conversation(original)).noteVersion });
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Another change');
  const next = await engine.repository.resolve('HEAD');
  const review = await engine.createReview({ title: 'Independent review', base: original, head: next });
  await engine.addReviewComment(review.id, { body: 'Not a commit note' });
  assert.equal((await engine.repository.commits({ limit: 1 })).commits[0].noteCount, 0);
  assert.equal((await engine.repository.commits({ offset: 1 })).commits[0].noteCount, 1);
  await engine.addComment({ commit: original, action: 'edit', body: 'Edited question', expectedVersion: (await engine.conversation(original)).noteVersion });
  assert.deepEqual(await engine.repository.noteCounts([original, next]), { [original]: 1, [next]: 0 });
  await engine.addComment({ commit: original, action: 'delete', body: '', expectedVersion: (await engine.conversation(original)).noteVersion });
  assert.equal((await engine.repository.noteCounts([original]))[original], 0);
  await engine.repository.writeNote(next, 'Not a structured discussion');
  assert.deepEqual(await engine.repository.noteCounts([original, next]), { [original]: 0, [next]: 1 });
  assert.equal((await engine.repository.commits({ limit: 1 })).commits[0].noteCount, 1);
});

test('branch and commit browsing excludes metadata, supports stable pages, and handles detached HEAD', async t => {
  const { directory, git, engine } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = engine.repository;
  const original = await repository.resolve('HEAD');
  const currentRef = await repository.git('symbolic-ref', 'HEAD');
  await git('branch', 'feature/notes', original);
  await git('update-ref', 'refs/remotes/origin/main', original);
  await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Second revision · 🌱');
  const second = await repository.resolve('HEAD');
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Third revision');
  await engine.addComment({ commit: 'HEAD', body: 'Metadata is not code history' });
  await engine.createReview({ title: 'Metadata review', base: original, head: 'HEAD' });
  const branches = await repository.branches();
  assert.equal(branches.length, 3);
  assert.equal(branches.find(item => item.current)?.ref, currentRef);
  assert.equal(branches.find(item => item.name === 'feature/notes')?.commit, original);
  assert.equal(branches.find(item => item.name === 'origin/main')?.remote, true);
  assert.ok(!branches.some(item => item.ref.endsWith('/HEAD')));
  const firstPage = await repository.commits({ ref: currentRef, limit: 2 });
  assert.deepEqual(firstPage.commits.map(item => item.subject), ['Third revision', 'Second revision · 🌱']);
  assert.equal(firstPage.commits[1].commit, second);
  assert.equal(firstPage.commits[1].author, 'Review Tester');
  assert.ok(!Number.isNaN(Date.parse(firstPage.commits[1].authoredAt)));
  assert.equal(firstPage.nextOffset, 2);
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Branch advanced');
  const nextPage = await repository.commits({ ref: firstPage.tip, limit: 2, offset: firstPage.nextOffset! });
  assert.deepEqual(nextPage.commits.map(item => item.commit), [original]);
  assert.equal(nextPage.nextOffset, null);
  assert.equal((await repository.commits({ ref: currentRef })).commits.length, 4);
  assert.deepEqual((await repository.commits({ ref: firstPage.tip, offset: 20 })).commits, []);
  await assert.rejects(repository.commits({ ref: '--all' }), /Cannot resolve/);
  await assert.rejects(repository.commits({ limit: 101 }));
  await git('checkout', '--detach', original);
  assert.ok((await repository.branches()).every(item => !item.current));
  assert.deepEqual((await repository.commits()).commits.map(item => item.commit), [original]);
  assert.equal((await git('status', '--porcelain')).stdout, '');
});

test('HTTP API authenticates, restricts origins, validates writes, and persists comments', async t => {
  const { directory, engine } = await fixture();
  const { app, token } = await createServer(engine);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${address}/api/repository`)).status, 401);
  assert.equal((await fetch(`${address}/api/branches`)).status, 401);
  assert.equal((await fetch(`${address}/api/commits`)).status, 401);
  const branchResponse = await fetch(`${address}/api/branches`, { headers });
  assert.equal(branchResponse.status, 200);
  assert.equal((await branchResponse.json() as { current: boolean }[])[0].current, true);
  const commitResponse = await fetch(`${address}/api/commits?ref=HEAD&limit=1`, { headers });
  assert.equal(commitResponse.status, 200);
  const commits = await commitResponse.json() as { commits: { subject: string; noteCount: number }[]; nextOffset: number | null };
  assert.equal(commits.commits[0].subject, 'Initial revision');
  assert.equal(commits.nextOffset, null);
  assert.equal(commits.commits[0].noteCount, 0);
  assert.equal((await fetch(`${address}/api/note-counts`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${address}/api/note-counts`, { method: 'POST', headers, body: JSON.stringify({ commits: ['HEAD'] }) })).status, 400);
  for (const query of ['limit=101', 'offset=-1', 'offset=1.5', 'offset=nope', 'ref=--all', 'ref=missing-branch']) {
    assert.equal((await fetch(`${address}/api/commits?${query}`, { headers })).status, 400);
  }
  assert.equal((await fetch(`${address}/api/branches`, { headers: { ...headers, Origin: 'https://example.test' } })).status, 403);
  assert.equal((await fetch(`${address}/api/repository`, { headers: { ...headers, Origin: 'https://example.test' } })).status, 403);
  const badHost = await app.inject({ url: '/api/repository', headers: { ...headers, host: 'evil.test' } });
  assert.equal(badHost.statusCode, 403);
  const invalid = await fetch(`${address}/api/comments`, { method: 'POST', headers, body: JSON.stringify({ commit: 'HEAD', body: '' }) });
  assert.equal(invalid.status, 400);
  const post = await fetch(`${address}/api/comments`, { method: 'POST', headers, body: JSON.stringify({ commit: 'HEAD', body: 'From the browser' }) });
  assert.equal(post.status, 201);
  const currentCommit = await engine.repository.resolve('HEAD');
  const countsResponse = await fetch(`${address}/api/note-counts`, { method: 'POST', headers, body: JSON.stringify({ commits: [currentCommit] }) });
  assert.equal(countsResponse.status, 200);
  assert.deepEqual(await countsResponse.json(), { [currentCommit]: 1 });
  const response = await fetch(`${address}/api/conversation?commit=HEAD`, { headers });
  assert.equal(response.status, 200);
  const data = await response.json() as { note: string | null; comments: unknown[] };
  assert.equal(data.note, 'From the browser');
  assert.deepEqual(data.comments, []);
  const created = await fetch(`${address}/api/reviews`, { method: 'POST', headers,
    body: JSON.stringify({ title: 'API review', base: 'HEAD', head: 'HEAD' }) });
  assert.equal(created.status, 201);
  const review = await created.json() as { id: string; revisions: { id: string }[] };
  assert.equal((await fetch(`${address}/api/reviews/${review.id}`)).status, 401);
  const reviewPost = await fetch(`${address}/api/reviews/${review.id}/comments`, { method: 'POST', headers,
    body: JSON.stringify({ revisionId: review.revisions[0].id, body: 'Retained reasoning' }) });
  assert.equal(reviewPost.status, 201);
  const badRevision = await fetch(`${address}/api/reviews/${review.id}/revisions`, { method: 'POST', headers,
    body: JSON.stringify({ base: 'HEAD', head: 'missing-branch' }) });
  assert.equal(badRevision.status, 400);
  assert.equal((await engine.review(review.id)).comments[0].body, 'Retained reasoning');
  const diffUrl = `${address}/api/reviews/${review.id}/revisions/${review.revisions[0].id}/diff`;
  assert.equal((await fetch(diffUrl)).status, 401);
  assert.equal((await fetch(diffUrl, { headers: { ...headers, Origin: 'https://example.test' } })).status, 403);
  const diffResponse = await fetch(diffUrl, { headers });
  assert.equal(diffResponse.status, 200);
  assert.equal((await diffResponse.json() as { patch: string }).patch, '');
  assert.equal((await fetch(`${address}/api/reviews/${review.id}/revisions/deadbeef/diff`, { headers })).status, 400);
});

test('short IDs resolve uniquely, latest comments resolve under lock, and deletion is scoped', async t => {
  const { directory, git, engine } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = await engine.addComment({ commit: 'HEAD', body: 'Keep this note' });
  const first = await engine.createReview({ title: 'First', base: 'HEAD', head: 'HEAD' });
  const second = await engine.createReview({ title: 'Second', base: 'HEAD', head: 'HEAD' });
  const prefix = first.id.slice(0, 8);
  assert.equal((await engine.review(prefix.toUpperCase())).id, first.id);
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'New version');
  const revised = await engine.addRevision(prefix, { base: first.revisions[0].base, head: 'HEAD' });
  const comment = await engine.addReviewComment(prefix, { body: 'Current revision' });
  assert.equal(comment.revisionId, revised.revisions[1].id);
  const reply = await engine.addReviewComment(prefix, {
    body: 'Old revision', revisionId: first.revisions[0].id.slice(0, 8), replyTo: comment.id.slice(0, 8),
  });
  assert.equal(reply.revisionId, first.revisions[0].id);
  assert.equal(reply.replyTo, comment.id);
  await engine.repository.withWriteLock(async () => {
    await assert.rejects(engine.deleteReview(prefix), /write is active/);
  });
  const head = await engine.repository.resolve('HEAD');
  assert.equal((await engine.deleteReview(prefix)).id, first.id);
  await assert.rejects(engine.review(prefix), /does not exist/);
  await assert.rejects(engine.deleteReview(prefix), /does not exist/);
  assert.equal((await engine.review(second.id)).id, second.id);
  assert.equal((await engine.conversation(legacy.commit)).note, 'Keep this note');
  assert.equal(await engine.repository.resolve('HEAD'), head);
  assert.equal((await git('status', '--porcelain')).stdout, '');
});

test('ambiguous prefixes never select a review implicitly', async t => {
  const { directory, engine } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = await engine.createReview({ title: 'Template', base: 'HEAD', head: 'HEAD' });
  const ids = ['abcdef12-1111-4111-8111-111111111111', 'abcdef12-2222-4222-8222-222222222222'];
  for (const id of ids) {
    await engine.repository.writeReviewSnapshot(`refs/git-discuss/reviews/${id}`, undefined,
      JSON.stringify({ ...original, id }), [original.revisions[0].head]);
  }
  await assert.rejects(engine.review('abcdef12'), /ambiguous/);
  await assert.rejects(engine.deleteReview('abcdef12'), /ambiguous/);
  await assert.rejects(engine.addReviewComment('abcdef12', { body: 'Ambiguous' }), /ambiguous/);
  assert.equal((await engine.review('abcdef12-1')).id, ids[0]);
  assert.equal(shortIdentifier(ids[0], ids), 'abcdef12-1');
  assert.throws(() => resolveIdentifier('abcdef12', ids, 'Revision'), /ambiguous/);
  assert.throws(() => resolveIdentifier('abc', ids, 'Review'), /at least 4/);
  assert.equal((await engine.review(ids[0])).comments.length, 0);
});

test('revision diffs use retained trees, preserve whitespace, and ignore external diff helpers', async t => {
  const { directory, git, engine } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codeCommit = async (files: Record<string, string>, message: string) => {
    const entries = [];
    for (const [name, contents] of Object.entries(files)) {
      const blob = await engine.repository.gitInput(contents, 'hash-object', '-w', '--stdin');
      entries.push(`100644 blob ${blob}\t${name}\n`);
    }
    const tree = await engine.repository.gitInput(entries.join(''), 'mktree');
    return engine.repository.gitInput(message, '-c', 'commit.gpgsign=false', 'commit-tree', tree);
  };
  const attributes = '*.txt diff=custom\n';
  const base = await codeCommit({ '.gitattributes': attributes, 'space name.txt': 'before\n', 'removed.txt': 'gone\n' }, 'Base');
  const head = await codeCommit({ '.gitattributes': attributes, 'space name.txt': 'after  \n', 'added.txt': '<script>alert(1)</script>\n', 'image.bin': 'binary\0data' }, 'Head');
  const review = await engine.createReview({ title: 'Diff review', base, head });
  await git('config', 'diff.external', 'nonexistent-external-diff');
  await git('config', 'diff.custom.textconv', 'nonexistent-textconv');
  await git('config', 'diff.relative', 'true');
  const diff = await engine.revisionDiff(review.id.slice(0, 8), review.revisions[0].id.slice(0, 8));
  assert.equal(diff.base, base);
  assert.equal(diff.head, head);
  assert.match(diff.patch, /-before\n\+after  \n/);
  assert.match(diff.patch, /deleted file mode/);
  assert.match(diff.patch, /\+<script>alert\(1\)<\/script>/);
  assert.match(diff.patch, /Binary files .* differ/);
  const second = await engine.addRevision(review.id, { base, head: base });
  assert.equal((await engine.revisionDiff(review.id, second.revisions[1].id)).patch, '');
  await git('reflog', 'expire', '--expire=now', '--all');
  await git('gc', '--prune=now');
  assert.equal((await engine.revisionDiff(review.id, review.revisions[0].id)).patch, diff.patch);
  await assert.rejects(engine.revisionDiff(review.id, 'deadbeef'), /Revision does not exist/);
  await assert.rejects(engine.repository.diff('--stat', head), /exact commit IDs/);
  const huge = await codeCommit({ 'large.txt': 'x'.repeat(2 * 1024 * 1024) }, 'Large change');
  const largeReview = await engine.createReview({ title: 'Large review', base, head: huge });
  await assert.rejects(engine.revisionDiff(largeReview.id, largeReview.revisions[0].id), /too large for the browser/);
});

test('stable reviews retain rewritten code and revision-scoped reasoning through garbage collection', async t => {
  const { directory, git, engine } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalHead = await engine.repository.resolve('HEAD');
  const tree = await engine.repository.git('rev-parse', 'HEAD^{tree}');
  // Parentless code commits model a rewritten branch with no shared ancestry.
  const oldHead = await engine.repository.gitInput('Old code\n', 'commit-tree', tree);
  const nextHead = await engine.repository.gitInput('Rewritten code\n', 'commit-tree', tree);
  const review = await engine.createReview({ title: 'Durable design', base: originalHead, head: oldHead });
  const first = await engine.addReviewComment(review.id, { revisionId: review.revisions[0].id, body: 'Why this design?' });
  const revised = await engine.addRevision(review.id, { base: originalHead, head: nextHead });
  const reply = await engine.addReviewComment(review.id, {
    revisionId: revised.revisions[1].id, body: 'Updated based on this feedback.', replyTo: first.id,
  });
  // A stale browser may explicitly discuss the old revision after a new one arrives.
  await engine.addReviewComment(review.id, { revisionId: review.revisions[0].id, body: 'Old revision context' });
  await git('reflog', 'expire', '--expire=now', '--all');
  await git('gc', '--prune=now');
  const reopened = new Reviews(await Repository.open(directory));
  const saved = await reopened.review(review.id);
  assert.deepEqual(saved.revisions, revised.revisions);
  assert.equal(saved.comments[0].commit, oldHead);
  assert.equal(saved.comments[1].commit, nextHead);
  assert.equal(saved.comments[1].replyTo, first.id);
  assert.equal(saved.comments[1].id, reply.id);
  assert.equal(saved.comments[2].revisionId, review.revisions[0].id);
  assert.equal(await reopened.repository.resolve(oldHead), oldHead);
  assert.equal(await reopened.repository.resolve(nextHead), nextHead);
  assert.equal(await reopened.repository.resolve('HEAD'), originalHead);
  assert.equal((await git('status', '--porcelain')).stdout, '');
  assert.equal((await reopened.listReviews())[0].id, review.id);
  assert.deepEqual((await reopened.conversation(originalHead)).comments, []);
});

test('review boundaries, validation, locking, and compare-and-swap prevent invalid updates', async t => {
  const { directory, engine } = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(engine.createReview({ title: ' ', base: 'HEAD', head: 'HEAD' }));
  await assert.rejects(engine.createReview({ title: 'Bad ref', base: '--all', head: 'HEAD' }), /Cannot resolve/);
  const one = await engine.createReview({ title: 'One', base: 'HEAD', head: 'HEAD' });
  const two = await engine.createReview({ title: 'Two', base: 'HEAD', head: 'HEAD' });
  const comment = await engine.addReviewComment(one.id, { revisionId: one.revisions[0].id, body: 'One only' });
  await assert.rejects(engine.addReviewComment(two.id, { revisionId: one.revisions[0].id, body: 'Wrong revision' }), /Revision does not exist/);
  await assert.rejects(engine.addReviewComment(two.id, { revisionId: two.revisions[0].id, replyTo: comment.id, body: 'Wrong review' }), /Reply target/);
  await assert.rejects(engine.addRevision(one.id, { base: 'HEAD', head: 'HEAD' }), /already has/);
  await assert.rejects(engine.review('../HEAD'));
  await engine.repository.withWriteLock(async () => {
    await assert.rejects(engine.addRevision(one.id, { base: 'HEAD', head: 'HEAD' }), /write is active/);
  });
  const ref = `refs/git-discuss/reviews/${one.id}`;
  const before = await engine.repository.resolve(ref);
  await assert.rejects(engine.repository.writeReviewSnapshot(ref, undefined, JSON.stringify(one), []));
  assert.equal(await engine.repository.resolve(ref), before);
  assert.equal((await engine.review(one.id)).comments.length, 1);
  // A corrupt imported snapshot must be rejected rather than silently overwritten.
  await engine.repository.writeReviewSnapshot(ref, before, JSON.stringify({ ...one, id: two.id }), []);
  await assert.rejects(engine.review(one.id), /does not match/);
});
