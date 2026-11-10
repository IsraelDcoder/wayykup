import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseHuntTarget,
  chooseHuntTargetForDifficulty,
  huntTargetsForDifficulty,
  matchesHuntObject,
} from './objects';

test('hunt target shuffle only chooses from the configured valid targets', () => {
  assert.equal(chooseHuntTarget(['Chair', 'Cup'], () => 0), 'Chair');
  assert.equal(chooseHuntTarget(['Chair', 'Cup'], () => 0.99), 'Cup');
  assert.notEqual(chooseHuntTarget(['Chair', 'Cup'], () => 0, 'Chair'), 'Chair');
  assert.equal(chooseHuntTarget(['Chair'], () => 0, 'Chair'), 'Chair');
  assert.equal(chooseHuntTarget(['not an object']), null);
});

test('each Object Hunt difficulty can reshuffle to a different supported target', () => {
  for (const difficulty of ['easy', 'medium', 'hard'] as const) {
    const previousTarget = huntTargetsForDifficulty(difficulty)[0];
    const nextTarget = chooseHuntTargetForDifficulty(difficulty, () => 0, previousTarget);
    assert.ok(nextTarget);
    assert.notEqual(nextTarget, previousTarget);
    assert.ok(huntTargetsForDifficulty(difficulty).includes(nextTarget));
  }
});

test('object recognition accepts supported classifier labels for the shuffled target', () => {
  assert.equal(matchesHuntObject('Toothbrush', [{ label: 'toothbrush', confidence: 0.82 }]), true);
  assert.equal(matchesHuntObject('Coffee mug', [{ label: 'Coffee Mug', confidence: 0.72 }]), true);
  assert.equal(matchesHuntObject('Water bottle', [{ label: 'water bottle', confidence: 0.55 }]), true);
  assert.equal(matchesHuntObject('Chair', [{ label: 'armchair', confidence: 0.4 }]), true);
  assert.equal(matchesHuntObject('Laptop', [{ label: 'notebook computer', confidence: 0.65 }]), true);
  assert.equal(matchesHuntObject('Flower', [{ label: 'flower', confidence: 0.6 }]), true);
});

test('object recognition rejects unrelated, unsupported, or low-confidence labels', () => {
  assert.equal(matchesHuntObject('Toothbrush', [{ label: 'toothbrush', confidence: 0.24 }]), false);
  assert.equal(matchesHuntObject('Toothbrush', [{ label: 'soap', confidence: 0.95 }]), false);
  assert.equal(matchesHuntObject('Toothbrush', [{ label: 'laptop computer', confidence: 0.95 }]), false);
  assert.equal(matchesHuntObject('Computer mouse', [{ label: 'mouse', confidence: 0.95 }]), false);
  assert.equal(matchesHuntObject('Unknown', [{ label: 'unknown', confidence: 1 }]), false);
  assert.equal(matchesHuntObject('Pen', [{ label: 'pen', confidence: Number.NaN }]), false);
});
