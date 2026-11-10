import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transitionAlarmState } from './alarmLifecycle';

test('allows only the scheduled-to-dismissed alarm sequence', () => {
  let state = transitionAlarmState('scheduled', 'ringing');
  state = transitionAlarmState(state, 'challenge_pending');
  state = transitionAlarmState(state, 'challenge_active');
  state = transitionAlarmState(state, 'challenge_completed');
  state = transitionAlarmState(state, 'dismissed');
  assert.equal(state, 'dismissed');
});

test('rejects dismissal before a challenge is active and duplicate completion', () => {
  assert.throws(() => transitionAlarmState('ringing', 'dismissed'), /Invalid alarm lifecycle transition/);
  assert.throws(() => transitionAlarmState('challenge_completed', 'challenge_completed'), /Invalid alarm lifecycle transition/);
  assert.throws(() => transitionAlarmState('dismissed', 'ringing'), /Invalid alarm lifecycle transition/);
});
