import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Repository } from '../src/git/repository.js';
import { Reviews } from '../src/core/reviews.js';
import { Synchronization } from '../src/core/sync.js';
import { trackedBranchSchema } from '../src/core/models.js';
import { createServer } from '../src/server/app.js';
import { BranchTracking } from '../src/core/tracking.js';
import { mergeReviews } from '../src/core/reconciliation.js';

const execute = promisify(execFile);

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'git-discuss-tracking-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const origin = path.join(directory, 'origin.git');
  const first = path.join(directory, 'author');
  const second = path.join(directory, 'reviewer');
  await execute('git', ['init', '--bare', origin]);
  await execute('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  await execute('git', ['init', '-b', 'main', first]);
  const git = async (...args: string[]) => (await execute('git', ['-C', first, ...args])).stdout.trim();
  const remote = async (...args: string[]) => (await execute('git', ['-C', origin, ...args])).stdout.trim();
  await git('config', 'user.name', 'Code Author'); await git('config', 'user.email', 'author@example.test');
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Base code');
  const base = await git('rev-parse', 'HEAD');
  await git('remote', 'add', 'origin', origin); await git('push', 'origin', 'main');
  await git('checkout', '-b', 'feature/login');
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial login changes');
  const initial = await git('rev-parse', 'HEAD');
  await git('push', '-u', 'origin', 'feature/login');
  await execute('git', ['clone', origin, second]);
  const a = new Reviews(await Repository.open(first)); const b = new Reviews(await Repository.open(second));
  await b.repository.git('config', 'user.name', 'Reviewer'); await b.repository.git('config', 'user.email', 'reviewer@example.test');
  const sa = new Synchronization(a.repository); const sb = new Synchronization(b.repository);
  const review = await a.createReview({ title: 'Login review', base, head: 'HEAD', followBranch: true });
  const comment = await a.addReviewComment(review.id, { body: 'Please refine this code.' });
  await sa.sync(); await sb.receive();
  return { a, b, sa, sb, git, remote, base, initial, review, comment };
}

test('pushed branch commits update the same review on two clones with deterministic comparisons', async t => {
  const { a, b, sa, sb, git, remote, base, initial, review, comment } = await fixture(t);
  assert.equal(review.tracking?.branch, 'refs/heads/feature/login');
  assert.equal(review.schema, 3);
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Address requested changes');
  const pushed = await git('rev-parse', 'HEAD');
  await git('push', 'origin', 'feature/login');
  const remoteReviewBefore = await remote('rev-parse', `refs/git-discuss/reviews/${review.id}`);
  await sa.receive(); await sb.receive();
  const left = await a.review(review.id); const right = await b.review(review.id);
  const l = await a.view(left); const r = await b.view(right);
  assert.equal(l.revisions.find(item => item.id === l.currentRevisionId)?.head, pushed);
  assert.equal(r.revisions.find(item => item.id === r.currentRevisionId)?.head, pushed);
  assert.equal(l.currentRevisionId, r.currentRevisionId);
  assert.equal(l.revisions.length, 2); assert.equal(r.revisions.length, 2);
  assert.equal(l.trackingStatus?.state, 'following');
  assert.equal((await b.revisionDiff(review.id, comment.revisionId)).head, initial);
  assert.equal((await b.review(review.id)).comments[0].commit, initial);
  assert.equal(await b.repository.resolve('HEAD'), base);
  assert.equal(await b.repository.resolve('refs/remotes/origin/feature/login'), initial);
  assert.equal(await b.repository.git('status', '--porcelain'), '');
  assert.ok(await b.repository.git('log', '--all', '--oneline'), 'Private tracking refs must remain compatible with normal Git history commands');
  assert.equal(await remote('rev-parse', `refs/git-discuss/reviews/${review.id}`), remoteReviewBefore, 'Receiving code must not upload discussion refs');
  const reply = await b.addReviewComment(review.id, { body: 'Reviewed the new commit.', replyTo: comment.id });
  assert.equal(reply.commit, pushed);
  const older = await b.addReviewComment(review.id, { body: 'Context on the earlier commit', commit: initial });
  assert.equal(older.commit, initial); assert.equal(older.revisionId, comment.revisionId);
  await assert.rejects(b.addReviewComment(review.id, { body: 'Not reviewed', commit: base }), /not in the review/);
  await assert.rejects(b.addReviewComment(review.id, { body: 'Two selectors', commit: initial, revisionId: comment.revisionId }), /either/);
  await sb.sync(); await sa.receive();
  assert.deepEqual(await a.review(review.id), await b.review(review.id));
  assert.equal(await remote('for-each-ref', 'refs/git-discuss/tracking/'), '', 'Private observed branch pointers must not be shared');
  assert.deepEqual((await sb.receive()).updatedRefs, []);
  await assert.rejects(a.addRevision(review.id, { base, head: 'HEAD' }), /follows a branch/);
});

test('rebases, rewinds, missing branches, and GC preserve discussions and the current commit', async t => {
  const { b, sb, git, remote, base, initial, review, comment } = await fixture(t);
  const tree = await b.repository.git('rev-parse', 'HEAD^{tree}');
  const rebased = await b.repository.gitInput('Rebased login code', 'commit-tree', tree);
  await b.repository.network('push', 'origin', `${rebased}:refs/heads/rebase-fixture`);
  await remote('update-ref', 'refs/heads/feature/login', rebased);
  await remote('update-ref', '-d', 'refs/heads/rebase-fixture');
  await sb.receive();
  let view = await b.view(await b.review(review.id));
  const rebasedId = view.currentRevisionId;
  assert.equal(view.revisions.find(item => item.id === rebasedId)?.head, rebased);
  await remote('update-ref', 'refs/heads/feature/login', initial);
  const rewind = await sb.receive();
  assert.ok(rewind.updatedReviewIds?.includes(review.id));
  view = await b.view(await b.review(review.id));
  assert.equal(view.currentRevisionId, comment.revisionId);
  assert.equal(view.revisions.length, 2, 'Revisiting a retained commit must not duplicate its comparison');
  await remote('update-ref', '-d', 'refs/heads/feature/login');
  await sb.receive(); view = await b.view(await b.review(review.id));
  assert.equal(view.trackingStatus?.state, 'missing');
  assert.equal(view.currentRevisionId, comment.revisionId);
  await remote('update-ref', 'refs/heads/feature/login', rebased);
  await sb.receive();
  assert.equal((await b.view(await b.review(review.id))).currentRevisionId, rebasedId);
  await b.repository.git('reflog', 'expire', '--expire=now', '--all');
  await b.repository.git('gc', '--prune=now');
  const reopened = new Reviews(await Repository.open(b.repository.root));
  assert.equal((await reopened.view(await reopened.review(review.id))).currentRevisionId, rebasedId);
  assert.equal(await b.repository.resolve(initial), initial);
  assert.equal(await b.repository.resolve(rebased), rebased);
  assert.equal(await b.repository.resolve('HEAD'), base);
  assert.equal(await b.repository.git('for-each-ref', 'refs/git-discuss/background/'), '');
  assert.equal(await git('rev-parse', 'HEAD'), initial);
  const third = await b.repository.gitInput('Another observed commit', 'commit-tree', tree);
  const tracker = new BranchTracking(b.repository);
  const forward = await tracker.retain(await tracker.retain(review, rebased), third);
  const backward = await tracker.retain(await tracker.retain(review, third), rebased);
  assert.deepEqual(mergeReviews(forward, backward), mergeReviews(backward, forward), 'Different observation order must not create revision-order conflicts');
});

test('a save during branch fetching wins over a stale tracking publication', async t => {
  const { a, b, sb, git, initial, review } = await fixture(t);
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'New pushed code');
  const pushed = await git('rev-parse', 'HEAD');
  await git('push', 'origin', 'feature/login');
  const network = b.repository.networkWithSignal.bind(b.repository);
  let saved = false;
  b.repository.networkWithSignal = async (signal, ...args) => {
    if (!saved && args[0] === 'fetch' && args.some(arg => arg.startsWith('refs/heads/feature/login:'))) {
      saved = true;
      await b.addReviewComment(review.id, { body: 'Saved while code was downloading' });
    }
    return network(signal, ...args);
  };
  await assert.rejects(sb.receive(), /cannot lock ref|expected|is at/);
  let state = await b.view(await b.review(review.id));
  assert.equal(state.revisions.find(item => item.id === state.currentRevisionId)?.head, initial);
  assert.ok(state.comments.some(item => item.body === 'Saved while code was downloading'));
  await sb.receive(); state = await b.view(await b.review(review.id));
  assert.equal(state.revisions.find(item => item.id === state.currentRevisionId)?.head, pushed);
  assert.ok(state.comments.some(item => item.body === 'Saved while code was downloading'));
  assert.equal(state.revisions.length, 2);
  assert.equal(await a.repository.resolve('HEAD'), pushed);
});

test('an unpublished initial comparison is not replaced by the older pushed branch', async t => {
  const { a, b, sa, sb, git, remote, base } = await fixture(t);
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Unpushed draft code');
  const unpushed = await git('rev-parse', 'HEAD');
  const review = await a.createReview({ title: 'New unpublished review', base, head: 'HEAD', followBranch: true });
  await sa.sync(); await sb.receive();
  for (const engine of [a, b]) {
    const view = await engine.view(await engine.review(review.id));
    assert.equal(view.trackingStatus?.state, 'awaiting-push');
    assert.equal(view.revisions.find(item => item.id === view.currentRevisionId)?.head, unpushed);
  }
  assert.deepEqual((await sb.receive()).updatedRefs, []);
  await git('push', 'origin', 'feature/login');
  await sb.receive();
  const view = await b.view(await b.review(review.id));
  assert.equal(view.trackingStatus?.state, 'following');
  assert.equal(view.revisions.length, 1);
  const renamed = await b.changeReview(review.id, { kind: 'rename', title: 'Tracked and renamed', expectedVersion: review.id });
  assert.equal(renamed.schema, 3);
  assert.ok(renamed.tracking);
  const tree = await a.repository.git('rev-parse', 'HEAD^{tree}');
  const rebased = await a.repository.gitInput('Unpublished rebase', 'commit-tree', tree);
  await git('update-ref', 'refs/heads/feature/login', rebased);
  const rebasedReview = await a.createReview({ title: 'Unpublished rewritten work', base, head: 'HEAD', followBranch: true });
  assert.equal(rebasedReview.tracking?.initialRemoteHead, unpushed);
  await sa.sync(); await sb.receive();
  const waiting = await b.view(await b.review(rebasedReview.id));
  assert.equal(waiting.trackingStatus?.state, 'awaiting-push');
  assert.equal(waiting.revisions.find(item => item.id === waiting.currentRevisionId)?.head, rebased);
  // The review transfer retained the rewritten object; simulate publishing that branch tip.
  await remote('update-ref', 'refs/heads/feature/login', rebased);
  await sb.receive();
  assert.equal((await b.view(await b.review(rebasedReview.id))).trackingStatus?.state, 'following');
});

test('existing reviews can follow a branch and selected local names are not replaced by upstream main', async t => {
  const { a, b, sa, sb, git, base, initial } = await fixture(t);
  await git('branch', '--set-upstream-to=origin/main', 'feature/login');
  const tracked = await a.createReview({ title: 'Follow selected feature', base, head: 'HEAD', followBranch: true });
  assert.equal(tracked.tracking?.branch, 'refs/heads/feature/login');
  const legacy = await a.createReview({ title: 'Existing pinned review', base, head: initial });
  await sa.sync(); await sb.receive();
  assert.equal((await b.review(legacy.id)).tracking, undefined);
  await a.followBranch(legacy.id.slice(0, 8), { head: 'refs/remotes/origin/feature/login' });
  await sa.sync(); await sb.receive();
  assert.equal((await b.review(legacy.id)).tracking?.branch, 'refs/heads/feature/login');
  assert.equal((await b.review(legacy.id)).revisions[0].head, initial);
  await assert.rejects(a.followBranch(legacy.id, { head: 'main' }), /already follows/);
  const pinned = await a.createReview({ title: 'Exact commit', base, head: initial, followBranch: true });
  assert.equal(pinned.tracking, undefined);
  const { app, token } = await createServer(b);
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${address}/api/receive`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${address}/api/receive`, { method: 'POST', headers, body: '{"remote":"origin"}' })).status, 200);
  const data = await (await fetch(`${address}/api/reviews/${legacy.id}`, { headers })).json() as { currentRevisionId: string; trackingStatus: { state: string } };
  assert.ok(data.currentRevisionId); assert.equal(data.trackingStatus.state, 'following');
});

test('tracked branch names reject refspec injection and invalid Git names', () => {
  assert.ok(trackedBranchSchema.safeParse('refs/heads/feature/login').success);
  for (const ref of ['main', 'refs/tags/v1', 'refs/heads/x:y', 'refs/heads/x*', 'refs/heads/x[1]', 'refs/heads/x\\y', 'refs/heads/a..b', 'refs/heads/a//b', 'refs/heads/.hidden', 'refs/heads/a.lock', 'refs/heads/a@{b}']) {
    assert.equal(trackedBranchSchema.safeParse(ref).success, false, ref);
  }
});

test('creating a HEAD review freezes its source branch before another Git client checks out a different branch', async t => {
  const { a, git, base, initial } = await fixture(t);
  const resolve = a.repository.resolve.bind(a.repository);
  let switched = false;
  a.repository.resolve = async ref => {
    const commit = await resolve(ref);
    if (!switched && (ref === 'HEAD' || ref === 'refs/heads/feature/login')) {
      switched = true; await git('checkout', 'main');
    }
    return commit;
  };
  const review = await a.createReview({ title: 'Stable source selection', base, head: 'HEAD', followBranch: true });
  assert.equal(review.tracking?.branch, 'refs/heads/feature/login');
  assert.equal(review.tracking?.initialHead, initial);
  assert.equal(await git('branch', '--show-current'), 'main');
});

test('a review opened from an outdated local branch follows its already-newer remote commit', async t => {
  const { a, sa, git, base, initial } = await fixture(t);
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Already published newer code');
  const newer = await git('rev-parse', 'HEAD');
  await git('push', 'origin', 'feature/login');
  await git('update-ref', 'refs/heads/feature/login', initial);
  const review = await a.createReview({ title: 'Outdated local checkout', base, head: 'HEAD', followBranch: true });
  assert.equal(review.tracking?.initialRemoteHead, newer);
  await sa.receive();
  const view = await a.view(await a.review(review.id));
  assert.equal(view.trackingStatus?.state, 'following');
  assert.equal(view.revisions.find(item => item.id === view.currentRevisionId)?.head, newer);
  assert.equal(await git('rev-parse', 'HEAD'), initial);
});
