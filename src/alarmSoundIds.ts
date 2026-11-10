import soundManifest from './alarm-sounds.json';

export const DEFAULT_ALARM_SOUND_ID = 'police_siren';

export const ALARM_SOUND_IDS = soundManifest.map(({ id }) => id);

export type AlarmSoundId =
  | 'police_siren'
  | 'air_raid'
  | 'fire_alarm'
  | 'industrial_klaxon'
  | 'accelerating_beeps'
  | 'metal_clang'
  | 'bass_earthquake'
  | 'screech'
  | 'emergency_two_tone'
  | 'chaos_final_boss';

const LEGACY_SOUND_MIGRATIONS: Record<string, AlarmSoundId> = {
  'air raid': 'air_raid',
  'air-raid': 'air_raid',
  air_raid: 'air_raid',
  alarm_tone: 'air_raid',
  'alarm-tone': 'air_raid',
};

export function isAlarmSoundId(value: unknown): value is AlarmSoundId {
  return typeof value === 'string' && ALARM_SOUND_IDS.includes(value);
}

export function migrateAlarmSoundId(value: string): AlarmSoundId {
  if (isAlarmSoundId(value)) return value;
  return LEGACY_SOUND_MIGRATIONS[value.trim().toLowerCase()] ?? DEFAULT_ALARM_SOUND_ID;
}
