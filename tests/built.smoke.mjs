import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test('built CLI serves browser assets and shares persisted notes with the API', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'git-discuss-smoke-'));
  let server;
  t.after(async () => {
    if (server && server.exitCode === null) {
      await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
    }
    await rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => execute('git', ['-C', directory, ...args]);
  await git('init');
  await git('config', 'user.name', 'Smoke Tester');
  await git('config', 'user.email', 'smoke@example.test');
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Smoke revision');
  const originalHead = (await git('rev-parse', 'HEAD')).stdout.trim();
  await execute(process.execPath, [cli, '--repo', directory, 'comment', 'CLI comment']);
  const run = (...args) => execute(process.execPath, [cli, '--repo', directory, ...args]);
  const review = JSON.parse((await run('review', 'create', 'Smoke review', '--base', 'HEAD')).stdout);
  await run('review', 'comment', review.id, 'CLI review reasoning', '--revision', review.revisions[0].id);
  await git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Revised smoke code');
  const revised = JSON.parse((await run('review', 'revise', review.id, '--base', review.revisions[0].base)).stdout);
  assert.equal(revised.revisions.length, 2);
  assert.equal(JSON.parse((await run('review', 'list', '--json')).stdout)[0].id, review.id);
  const listing = (await run('review', 'list')).stdout;
  assert.match(listing, /REVIEW\s+LATEST REVISION\s+REVISIONS\s+COMMENTS\s+TITLE/);
  assert.match(listing, /Smoke review/);
  assert.ok(listing.includes(review.id.slice(0, 8)));
  const latestComment = await run('review', 'comment', review.id.slice(0, 8), 'Latest by default');
  assert.ok(latestComment.stdout.includes(`Revision: ${revised.revisions[1].id}`));
  await assert.rejects(run('review', 'comment', '--revision', review.id, '--revision', revised.revisions[1].id, 'test'),
    (error) => { assert.match(error.stderr, /Use --revision only once.*Usage:/); return true; });
  const origin = path.join(directory, '.git', 'smoke-origin.git');
  await git('init', '--bare', origin);
  await git('remote', 'add', 'origin', origin);
  assert.equal(JSON.parse((await run('sync', '--json')).stdout).uploaded, 2);
  assert.match((await run('sync')).stdout, /Synced discussions with origin/);

  server = spawn(process.execPath, [cli, '--repo', directory, 'serve', '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => reject(new Error(`Server launch timed out: ${errors}`)), 15000);
    server.stderr.on('data', chunk => { errors += chunk; });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${errors}`)); });
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Git Discuss: (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(new URL(match[1])); }
    });
  });
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Git Discuss/);
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await fetch(new URL(asset, url))).status, 200);
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const branchesResponse = await fetch(new URL('/api/branches', url), { headers });
  assert.equal(branchesResponse.status, 200);
  const branches = await branchesResponse.json();
  assert.ok(branches.some(branch => branch.current && !branch.remote));
  const commitsResponse = await fetch(new URL('/api/commits?ref=HEAD&limit=1', url), { headers });
  assert.equal(commitsResponse.status, 200);
  const page = await commitsResponse.json();
  assert.equal(page.commits[0].subject, 'Revised smoke code');
  assert.equal(page.nextOffset, 1);
  const olderPage = await (await fetch(new URL(`/api/commits?ref=${page.tip}&offset=${page.nextOffset}`, url), { headers })).json();
  assert.equal(olderPage.commits[0].commit, review.revisions[0].head);
  const discussion = await (await fetch(new URL(`/api/conversation?commit=${originalHead}`, url), { headers })).json();
  assert.equal(discussion.note, 'CLI comment');
  assert.deepEqual(discussion.comments, []);
  const reply = await fetch(new URL('/api/comments', url), { method: 'POST', headers,
    body: JSON.stringify({ commit: discussion.commit, body: 'Browser reply', action: 'append' }) });
  assert.equal(reply.status, 201);
  const shown = await run('show', '--commit', discussion.commit);
  assert.ok(JSON.parse(shown.stdout).note.includes('Browser reply'));
  const apiReview = await (await fetch(new URL(`/api/reviews/${review.id}`, url), { headers })).json();
  assert.equal(apiReview.comments[0].body, 'CLI review reasoning');
  const reviewReply = await fetch(new URL(`/api/reviews/${review.id}/comments`, url), { method: 'POST', headers,
    body: JSON.stringify({ revisionId: revised.revisions[1].id, body: 'Browser review reply', replyTo: apiReview.comments[0].id }) });
  assert.equal(reviewReply.status, 201);
  assert.equal(JSON.parse((await run('review', 'show', review.id.slice(0, 8))).stdout).comments[2].body, 'Browser review reply');
  const diffResponse = await fetch(new URL(`/api/reviews/${review.id}/revisions/${revised.revisions[1].id}/diff`, url), { headers });
  assert.equal(diffResponse.status, 200);
  assert.equal((await diffResponse.json()).patch, '');
  await run('review', 'comment', review.id.slice(0, 8), 'Explicit old revision', '--revision', review.revisions[0].id.slice(0, 8),
    '--reply-to', apiReview.comments[0].id.slice(0, 8));
  const oldComment = JSON.parse((await run('review', 'show', review.id)).stdout).comments[3];
  assert.equal(oldComment.revisionId, review.revisions[0].id);
  assert.equal(oldComment.replyTo, apiReview.comments[0].id);
  const syncResponse = await fetch(new URL('/api/sync', url), { method: 'POST', headers, body: '{"remote":"origin"}' });
  assert.equal(syncResponse.status, 200);
  assert.equal((await syncResponse.json()).uploaded, 2);
  await run('review', 'delete', review.id.slice(0, 8));
  assert.deepEqual(JSON.parse((await run('review', 'list', '--json')).stdout), []);
  assert.match((await run('review', 'list')).stdout, /No reviews yet/);
});
