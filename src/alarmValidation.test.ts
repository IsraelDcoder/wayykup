import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAlarmRecord, migrateStoredAlarm } from './alarmValidation';
import { defaultChallengeConfiguration, type ChallengeTask } from './challenges/registry';

const baseAlarm = {
  id: 'alarm-1',
  time: '07:00',
  days: ['1', '3', '5'],
  sound: 'police_siren',
  enabled: true,
  savage: false,
  label: 'Early shift',
};

test('accepts only the four supported challenge tasks with matching configurations', () => {
  const tasks: ChallengeTask[] = [
    'Yell to Stop',
    'Push-up Challenge',
    'Shake Your Phone',
    'Object Hunt',
  ];
  for (const task of tasks) {
    const type = {
      'Yell to Stop': 'yell_to_stop',
      'Push-up Challenge': 'push_up',
      'Shake Your Phone': 'shake_phone',
      'Object Hunt': 'object_hunt',
    }[task] as 'yell_to_stop' | 'push_up' | 'shake_phone' | 'object_hunt';
    assert.equal(isAlarmRecord({
      ...baseAlarm,
      task,
      challengeConfig: defaultChallengeConfiguration(type),
    }), true);
  }
  assert.equal(isAlarmRecord({ ...baseAlarm, task: 'Math' }), false);
  assert.equal(isAlarmRecord({ ...baseAlarm, task: 'Face Challenge' }), false);
});

test('migrates supported aliases without changing alarm timing or settings', () => {
  const legacy = {
    ...baseAlarm,
    task: 'Push-ups',
    sound: 'Air raid',
    challengeConfig: { type: 'push_up', targetCount: 15 },
    days: ['0', '1', '2', '3', '4'],
    customSoundUri: 'file:///old-custom-sound.mp3',
    customSoundName: 'Custom alarm',
  };
  const migrated = migrateStoredAlarm(legacy);
  assert.ok(migrated);
  assert.equal(migrated.task, 'Push-up Challenge');
  assert.deepEqual(migrated.challengeConfig, { type: 'push_up', targetCount: 15 });
  assert.deepEqual(migrated.days, legacy.days);
  assert.equal(migrated.time, legacy.time);
  assert.equal(migrated.sound, 'air_raid');
  assert.equal('customSoundUri' in migrated, false);
  assert.equal('customSoundName' in migrated, false);
  assert.equal(migrated.label, legacy.label);
  assert.equal(migrated.enabled, legacy.enabled);
  assert.equal(isAlarmRecord(migrated), true);

  const shake = migrateStoredAlarm({ ...legacy, task: 'Shake', challengeConfig: undefined, shakeCount: 100 });
  assert.equal(shake?.task, 'Shake Your Phone');
  assert.deepEqual(shake?.challengeConfig, { type: 'shake_phone', targetCount: 100 });
});

test('keeps retired alarms but clears their challenge for explicit user selection', () => {
  const retired = migrateStoredAlarm({
    ...baseAlarm,
    task: 'Math',
    mathDifficulty: 'Hard',
    challengeConfig: { type: 'math', difficulty: 'hard' },
  });
  assert.ok(retired);
  assert.equal(retired.task, null);
  assert.equal(retired.challengeConfig, undefined);
  assert.equal(retired.time, baseAlarm.time);
  assert.deepEqual(retired.days, baseAlarm.days);
  assert.equal(retired.sound, 'police_siren');
  assert.equal(retired.label, baseAlarm.label);
  assert.equal(retired.enabled, baseAlarm.enabled);
  assert.equal('mathDifficulty' in retired, false);
  assert.equal(isAlarmRecord(retired), true);
});

test('rejects invalid repeat days and malformed records', () => {
  assert.equal(migrateStoredAlarm({ ...baseAlarm, task: 'Math', days: ['7'] }), null);
  assert.equal(migrateStoredAlarm({ ...baseAlarm, task: 'Yell to Wake', savage: 'false' }), null);
});
