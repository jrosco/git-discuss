import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitFeedback } from '../src/web/submission.js';
import type { SyncResult } from '../src/core/models.js';

const shared: SyncResult = { remote: 'team', downloaded: 0, merged: 0, uploaded: 1, unchanged: 0 };

test('local submissions acknowledge the saved comment without requesting a share', async () => {
  const received: string[] = [];
  const result = await submitFeedback(async () => 'comment-id', comment => received.push(comment));
  assert.deepEqual(received, ['comment-id']);
  assert.deepEqual(result, { kind: 'local' });
});

test('immediate sharing only starts after the browser acknowledges the successful save', async () => {
  const order: string[] = [];
  const result = await submitFeedback(async () => { order.push('saved'); return 'comment-id'; }, comment => {
    assert.equal(comment, 'comment-id'); order.push('acknowledged');
  }, async () => { order.push('sharing'); return shared; });
  assert.deepEqual(order, ['saved', 'acknowledged', 'sharing']);
  assert.deepEqual(result, { kind: 'shared', result: shared });
});

test('failed saves do not clear the draft or start sharing', async () => {
  await assert.rejects(submitFeedback(async () => { throw new Error('Save failed'); }, () => {
    assert.fail('A failed save must not be acknowledged.');
  }, async () => { assert.fail('A failed save must not trigger a share.'); }), /Save failed/);
});

test('upload failure retains the acknowledged save without reposting the comment', async () => {
  let saves = 0;
  let acknowledgements = 0;
  const result = await submitFeedback(async () => { saves++; return 'saved-comment'; }, () => { acknowledgements++; },
    async () => { throw new Error('Connection lost during upload'); });
  assert.equal(saves, 1);
  assert.equal(acknowledgements, 1);
  assert.deepEqual(result, { kind: 'saved-unshared', error: 'Connection lost during upload' });
});
