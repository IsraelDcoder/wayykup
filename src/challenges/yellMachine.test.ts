import assert from 'node:assert/strict';
import test from 'node:test';
import { createYellState, powerScore, updateYellState, yellProgress } from './yellMachine';

test('Yell targets use ambient calibration plus a mode-specific vocal threshold', () => {
  const loud = createYellState('loud', -50, 0);
  const whisper = createYellState('whisper', -50, 0);
  assert.equal(loud.targetDbfs, -20);
  assert.equal(whisper.targetDbfs, -38);
  assert.equal(loud.targetReachable, true);
  assert.equal(createYellState('loud', -15, 0).targetReachable, false);
});

test('Yell ignores short spikes before accumulating progress', () => {
  let state = createYellState('loud', -50, 0);
  for (const now of [0, 100, 200]) state = updateYellState(state, -10, now, false);
  for (let now = 300; now <= 1_000; now += 100) state = updateYellState(state, -50, now, false);
  assert.equal(state.progressMs, 0);

  state = createYellState('loud', -50, 0);
  for (let now = 0; now <= 1_000; now += 100) state = updateYellState(state, -10, now, false);
  assert.ok(state.progressMs > 0);
});

test('Yell progress decays below target and pauses while alarm audio is audible', () => {
  let state = createYellState('loud', -50, 0);
  for (let now = 0; now <= 1_000; now += 100) state = updateYellState(state, -10, now, false);
  const earnedProgress = state.progressMs;
  for (let now = 1_100; now <= 1_500; now += 100) state = updateYellState(state, -50, now, false);
  assert.ok(state.progressMs < earnedProgress);

  const progressBeforeAudibleFrame = state.progressMs;
  const peakPowerBeforeAudibleFrame = state.peakPower;
  state = updateYellState(state, -10, 1_600, true);
  assert.equal(state.progressMs, progressBeforeAudibleFrame);
  assert.equal(state.peakPower, peakPowerBeforeAudibleFrame);
  assert.equal(yellProgress(state), Math.round((state.progressMs / 2_500) * 100));
});

test('Yell power score is bounded and does not expose microphone levels', () => {
  assert.equal(powerScore(-20, -50), 71);
  assert.equal(powerScore(-80, -50), 0);
  assert.equal(powerScore(0, -50), 100);
});
