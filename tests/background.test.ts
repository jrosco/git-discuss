import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { BackgroundUpdates } from '../src/server/background-updates.js';
import type { Synchronization } from '../src/core/sync.js';
import type { ReceiveResult } from '../src/core/models.js';

async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Background state did not settle.');
    await delay(5);
  }
}

function fake(receive: (input: { remote?: string }, signal?: AbortSignal) => Promise<ReceiveResult>) {
  return { repository: { remotes: async () => ['origin'] }, receive } as unknown as Synchronization;
}

test('metadata-only ref updates do not advertise nonexistent feedback changes', async t => {
  const worker = new BackgroundUpdates(fake(async () => ({
    remote: 'origin', updatedRefs: ['refs/notes/git-discuss'], updatedReviewIds: [], updatedNoteCommits: [],
  })), 10000);
  t.after(() => worker.close());
  await worker.configure({ enabled: true, remote: 'origin' });
  await until(() => Boolean(worker.status().lastSuccessAt));
  assert.equal(worker.status().revision, 0);
  assert.equal(worker.status().latestChangeSummary, null);
});

test('automatic polling never overlaps, reports actual changes, and stops when disabled', async t => {
  let calls = 0;
  const releases: ((result: ReceiveResult) => void)[] = [];
  const worker = new BackgroundUpdates(fake(async (_input, signal) => {
    calls++;
    return new Promise((resolve, reject) => {
      releases.push(resolve);
      signal!.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
    });
  }), 100);
  t.after(() => worker.close());
  assert.equal(worker.status().enabled, false);
  await worker.configure({ enabled: true, remote: 'origin' });
  await until(() => calls === 1);
  worker.checkNow(); worker.checkNow();
  assert.equal(calls, 1);
  releases[0]({ remote: 'origin', updatedRefs: [] });
  await until(() => !worker.status().running);
  assert.equal(worker.status().revision, 0);
  await until(() => calls === 2);
  releases[1]({ remote: 'origin', updatedRefs: ['refs/notes/git-discuss'] });
  await until(() => worker.status().revision === 1);
  assert.equal(worker.status().latestChangeSummary?.remote, 'origin');
  assert.equal(worker.status().latestChangeSummary?.notesUpdated, true);
  await worker.configure({ enabled: false, remote: 'origin' });
  assert.equal(worker.status().latestChangeSummary?.notesUpdated, true, 'Disabling checks must not erase an unapplied update summary');
  const stopped = calls;
  await delay(150);
  assert.equal(calls, stopped);
  assert.equal(worker.status().nextCheckAt, null);
});

test('foreground operations and server shutdown cancel an active receive without reporting a connection error', async t => {
  const signals: AbortSignal[] = [];
  const worker = new BackgroundUpdates(fake(async (_input, signal) => new Promise((_resolve, reject) => {
    signals.push(signal!);
    signal!.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
  })), 10000);
  t.after(() => worker.close());
  await worker.configure({ enabled: true, remote: 'origin' });
  await until(() => worker.status().running);
  let foregroundRan = false;
  await worker.withForeground(async () => {
    foregroundRan = true;
    assert.equal(worker.status().paused, true);
    assert.equal(worker.status().running, false);
  });
  assert.ok(foregroundRan);
  assert.ok(signals[0].aborted);
  assert.equal(worker.status().error, null);
  worker.checkNow();
  await until(() => signals.length === 2);
  await worker.close();
  assert.ok(signals[1].aborted);
  assert.equal(worker.status().nextCheckAt, null);
  assert.equal(worker.status().running, false);
  worker.checkNow();
  assert.equal(signals.length, 2);
});

test('failed checks remain nonblocking and a subsequent receive clears the retry status', async t => {
  let calls = 0;
  const worker = new BackgroundUpdates(fake(async () => {
    if (++calls === 1) throw new Error('Network unavailable');
    return { remote: 'origin', updatedRefs: ['refs/notes/git-discuss'] };
  }), 10000);
  t.after(() => worker.close());
  await assert.rejects(worker.configure({ enabled: true, remote: '--all' }), /configured Git remote/);
  await worker.configure({ enabled: true, remote: 'origin' });
  await until(() => Boolean(worker.status().error));
  assert.equal(worker.status().error, 'Network unavailable');
  assert.equal(worker.status().enabled, true);
  assert.equal(worker.status().revision, 0);
  assert.ok(worker.status().nextCheckAt);
  worker.checkNow();
  await until(() => worker.status().revision === 1);
  assert.equal(worker.status().error, null);
  assert.ok(worker.status().lastSuccessAt);
});
