import assert from 'node:assert/strict';
import test from 'node:test';
import { createPushUpState, updatePushUpState, type PushUpPose } from './pushUpMachine';

function pose(angle: 'extended' | 'bent', hipOffset = 0): PushUpPose {
  const side = {
    leftShoulder: { x: 0.2, y: 0.3, confidence: 0.95 },
    leftElbow: { x: 0.4, y: 0.3, confidence: 0.95 },
    leftWrist: angle === 'extended'
      ? { x: 0.6, y: 0.3, confidence: 0.95 }
      : { x: 0.4, y: 0.5, confidence: 0.95 },
    leftHip: { x: 0.5, y: 0.45 + hipOffset, confidence: 0.95 },
    leftAnkle: { x: 0.8, y: 0.6, confidence: 0.95 },
  };
  return side;
}

test('counts one valid down-and-up repetition, but not the initial extended pose', () => {
  let state = createPushUpState();
  state = updatePushUpState(state, pose('extended'), 1000);
  assert.equal(state.count, 0);
  state = updatePushUpState(state, pose('bent'), 1300);
  state = updatePushUpState(state, pose('extended'), 1800);
  assert.equal(state.count, 1);
});

test('does not count incomplete, poorly aligned, or low-confidence movement', () => {
  let state = createPushUpState();
  state = updatePushUpState(state, pose('bent'), 1000);
  state = updatePushUpState(state, null, 1500);
  state = updatePushUpState(state, pose('extended'), 2000);
  assert.equal(state.count, 0);

  state = updatePushUpState(state, pose('bent'), 2500);
  state = updatePushUpState(state, pose('extended', 0.3), 3000);
  assert.equal(state.count, 0);

  const obscured = pose('bent');
  if (obscured.leftWrist) obscured.leftWrist.confidence = 0.1;
  state = updatePushUpState(state, obscured, 3000);
  assert.equal(state.count, 0);
});

test('requires a new descent and a cooldown for each repetition', () => {
  let state = createPushUpState();
  state = updatePushUpState(state, pose('bent'), 1000);
  state = updatePushUpState(state, pose('extended'), 2000);
  state = updatePushUpState(state, pose('bent'), 2200);
  state = updatePushUpState(state, pose('extended'), 2500);
  assert.equal(state.count, 1);
  state = updatePushUpState(state, pose('bent'), 2900);
  state = updatePushUpState(state, pose('extended'), 3100);
  assert.equal(state.count, 2);
});
