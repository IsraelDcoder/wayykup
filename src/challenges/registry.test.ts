import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHALLENGE_OPTIONS,
  defaultChallengeConfiguration,
  isChallengeConfiguration,
} from './registry';
import { createShakeState, updateShakeState } from './shakeMachine';
import { chooseHuntTargetForDifficulty, huntTargetsForDifficulty, HUNT_ITEMS } from './objects';

test('exposes exactly the four supported wake-up challenges', () => {
  assert.deepEqual(CHALLENGE_OPTIONS.map(({ type, task }) => [type, task]), [
    ['yell_to_stop', 'Yell to Stop'],
    ['push_up', 'Push-up Challenge'],
    ['shake_phone', 'Shake Your Phone'],
    ['object_hunt', 'Object Hunt'],
  ]);
});

test('challenge defaults and configuration validation match their supported options', () => {
  assert.deepEqual(defaultChallengeConfiguration('yell_to_stop'), {
    type: 'yell_to_stop',
    phrase: "I'M AWAKE!",
    requiredCompletions: 1,
  });
  assert.equal(isChallengeConfiguration({ type: 'shake_phone', targetCount: 25 }), true);
  assert.equal(isChallengeConfiguration({ type: 'shake_phone', targetCount: 200 }), true);
  assert.equal(isChallengeConfiguration({ type: 'shake_phone', targetCount: 201 }), false);
  assert.equal(isChallengeConfiguration({ type: 'push_up', targetCount: 10 }), true);
  assert.equal(isChallengeConfiguration({ type: 'object_hunt', difficulty: 'hard', targetObject: 'Chair' }), true);
  assert.equal(isChallengeConfiguration({ type: 'object_hunt', difficulty: 'hard' }), false);
  assert.equal(isChallengeConfiguration({ type: 'object_hunt', difficulty: 'impossible' }), false);
  assert.equal(isChallengeConfiguration({ type: 'object_hunt', difficulty: 'easy', targetObject: 'spaceship' }), false);
});

test('each Object Hunt difficulty only returns supported targets', () => {
  const supported = new Set<string>(HUNT_ITEMS.map(({ name }) => name));
  for (const difficulty of ['easy', 'medium', 'hard'] as const) {
    assert.ok(huntTargetsForDifficulty(difficulty).length > 0);
    assert.ok(huntTargetsForDifficulty(difficulty).every((target) => supported.has(target)));
  }
  assert.equal(chooseHuntTargetForDifficulty('easy', () => 0), 'Toothbrush');
});

test('shake detector requires strong motion and a quiet reset between counts', () => {
  let state = createShakeState();
  state = updateShakeState(state, { x: 0, y: 0, z: 2.3 }, 1000, 25);
  assert.equal(state.count, 1);
  state = updateShakeState(state, { x: 0, y: 0, z: 2.4 }, 1500, 25);
  assert.equal(state.count, 1);
  state = updateShakeState(state, { x: 0, y: 0, z: 1 }, 1600, 25);
  state = updateShakeState(state, { x: 0, y: 0, z: 1 }, 1800, 25);
  state = updateShakeState(state, { x: 0, y: 0, z: -2.3 }, 2000, 25);
  assert.equal(state.count, 2);
});
