import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import soundManifest from './alarm-sounds.json';
import {
  ALARM_SOUND_IDS,
  DEFAULT_ALARM_SOUND_ID,
  isAlarmSoundId,
  migrateAlarmSoundId,
} from './alarmSoundIds';

test('the sound catalog contains exactly ten unique, bundled sounds', () => {
  assert.equal(soundManifest.length, 10);
  assert.equal(new Set(ALARM_SOUND_IDS).size, soundManifest.length);
  assert.ok(isAlarmSoundId(DEFAULT_ALARM_SOUND_ID));
  const androidPlayback = readFileSync(join(
    process.cwd(),
    'modules',
    'wayykup-alarm',
    'android',
    'src',
    'main',
    'java',
    'expo',
    'modules',
    'wayykupalarm',
    'RingService.kt',
  ), 'utf8');
  const iosPlayback = readFileSync(join(
    process.cwd(),
    'modules',
    'wayykup-alarm',
    'ios',
    'WayykupAlarmModule.swift',
  ), 'utf8');
  const iosResourceMapping = iosPlayback.slice(iosPlayback.indexOf('private func soundResource'));

  for (const sound of soundManifest) {
    const mp3 = readFileSync(join(process.cwd(), 'Alarms', sound.file));
    const caf = readFileSync(join(process.cwd(), 'assets', 'alarm-sounds', `${sound.id}.caf`));
    const androidResource = readFileSync(join(
      process.cwd(),
      'modules',
      'wayykup-alarm',
      'android',
      'src',
      'main',
      'res',
      'raw',
      `wayykup_${sound.id}.mp3`,
    ));
    assert.equal(mp3.subarray(0, 3).toString('ascii'), 'ID3');
    assert.equal(caf.subarray(0, 4).toString('ascii'), 'caff');
    assert.deepEqual(androidResource, mp3);
    assert.match(androidPlayback, new RegExp(`"${sound.id}"\\s*->\\s*R\\.raw\\.wayykup_${sound.id}`));
    assert.ok(iosResourceMapping.includes(`"${sound.id}"`), `iOS playback mapping missing ${sound.id}`);
  }
});

test('unknown saved sound names migrate to the new catalog, never legacy files', () => {
  assert.equal(migrateAlarmSoundId('Air raid'), 'air_raid');
  assert.equal(migrateAlarmSoundId('Beacon'), DEFAULT_ALARM_SOUND_ID);
  assert.equal(migrateAlarmSoundId('Dread Siren'), DEFAULT_ALARM_SOUND_ID);
  assert.equal(migrateAlarmSoundId('not-a-sound'), DEFAULT_ALARM_SOUND_ID);
});
