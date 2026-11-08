import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseHuntTarget, matchesHuntObject } from './objects';

test('hunt target shuffle only chooses from the configured valid targets', () => {
  assert.equal(chooseHuntTarget(['Chair', 'Cup'], () => 0), 'Chair');
  assert.equal(chooseHuntTarget(['Chair', 'Cup'], () => 0.99), 'Cup');
  assert.equal(chooseHuntTarget(['not an object']), null);
});

test('object recognition accepts supported classifier labels for the shuffled target', () => {
  assert.equal(matchesHuntObject('Toothbrush', [{ label: 'toothbrush', confidence: 0.82 }]), true);
  assert.equal(matchesHuntObject('Coffee mug', [{ label: 'Coffee Mug', confidence: 0.72 }]), true);
  assert.equal(matchesHuntObject('Water bottle', [{ label: 'water bottle', confidence: 0.55 }]), true);
  assert.equal(matchesHuntObject('Chair', [{ label: 'armchair', confidence: 0.4 }]), true);
});

test('object recognition rejects unrelated, unsupported, or low-confidence labels', () => {
  assert.equal(matchesHuntObject('Toothbrush', [{ label: 'toothbrush', confidence: 0.24 }]), false);
  assert.equal(matchesHuntObject('Toothbrush', [{ label: 'soap', confidence: 0.95 }]), false);
  assert.equal(matchesHuntObject('Unknown', [{ label: 'unknown', confidence: 1 }]), false);
  assert.equal(matchesHuntObject('Pen', [{ label: 'pen', confidence: Number.NaN }]), false);
});
