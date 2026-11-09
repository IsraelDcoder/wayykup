import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFaceState,
  shuffleFaceSequence,
  updateFaceState,
  type FaceGesture,
  type FaceSnapshot,
} from './faceMachine';
import { WAKE_CHALLENGE_CONFIG } from './config';

const neutralFace: FaceSnapshot = {
  yawAngle: 0,
  smilingProbability: 0,
  leftEyeOpenProbability: 1,
  rightEyeOpenProbability: 1,
  mouthOpenRatio: 0,
};

test('Face sequences contain three unique gestures selected from the configured pool', () => {
  const sequence = shuffleFaceSequence(() => 0);
  assert.equal(sequence.length, WAKE_CHALLENGE_CONFIG.face.sequenceLength);
  assert.equal(new Set(sequence).size, sequence.length);
  assert.ok(sequence.every((gesture) => WAKE_CHALLENGE_CONFIG.face.gestures.includes(gesture)));
});

test('a smile requires a neutral transition and the configured hold duration', () => {
  let state = createFaceState(0, ['smile', 'blink_twice', 'turn_left']);
  const smile = { ...neutralFace, smilingProbability: 0.95 };
  state = updateFaceState(state, smile, 100).state;
  assert.equal(state.index, 0);
  state = updateFaceState(state, neutralFace, 200).state;
  state = updateFaceState(state, smile, 300).state;
  const result = updateFaceState(
    state,
    smile,
    300 + WAKE_CHALLENGE_CONFIG.face.smileHoldMs,
  );
  assert.equal(result.state.index, 1);
});

test('blink twice counts two close-and-open transitions', () => {
  let state = createFaceState(0, ['blink_twice', 'smile', 'turn_left']);
  state = updateFaceState(state, neutralFace, 100).state;
  const closed = { ...neutralFace, leftEyeOpenProbability: 0.1, rightEyeOpenProbability: 0.1 };
  state = updateFaceState(state, closed, 200).state;
  state = updateFaceState(state, neutralFace, 250).state;
  state = updateFaceState(state, closed, 300).state;
  const result = updateFaceState(state, neutralFace, 350);
  assert.equal(result.state.index, 1);
});

test('gesture timeout starts a different random sequence and increments attempts', () => {
  const sequence: FaceGesture[] = ['smile', 'blink_twice', 'turn_left'];
  const state = createFaceState(0, sequence);
  const result = updateFaceState(state, neutralFace, WAKE_CHALLENGE_CONFIG.face.gestureTimeoutMs, () => sequence);
  assert.equal(result.retry, true);
  assert.equal(result.state.attempts, 2);
  assert.notDeepEqual(result.state.sequence, sequence);
});

test('losing the face requires a new neutral transition before gesture progress resumes', () => {
  let state = createFaceState(0, ['smile', 'blink_twice', 'turn_left']);
  state = updateFaceState(state, neutralFace, 100).state;
  state = updateFaceState(state, { ...neutralFace, smilingProbability: 0.95 }, 200).state;
  assert.notEqual(state.targetSince, null);
  state = updateFaceState(state, null, 250).state;
  assert.equal(state.targetSince, null);
  assert.equal(state.neutralSeen, false);
});
