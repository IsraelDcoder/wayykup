import { ALARM_SOUND_IDS, type AlarmSoundId } from './alarmSoundIds';
import soundManifest from './alarm-sounds.json';

const SOUND_ASSETS: Record<AlarmSoundId, number> = {
  police_siren: require('../Alarms/01-police-siren.mp3'),
  air_raid: require('../Alarms/02-air-raid.mp3'),
  fire_alarm: require('../Alarms/03-fire-alarm.mp3'),
  industrial_klaxon: require('../Alarms/04-industrial-klaxon.mp3'),
  accelerating_beeps: require('../Alarms/05-accelerating-beeps.mp3'),
  metal_clang: require('../Alarms/06-metal-clang.mp3'),
  bass_earthquake: require('../Alarms/07-bass-earthquake.mp3'),
  screech: require('../Alarms/08-screech.mp3'),
  emergency_two_tone: require('../Alarms/09-emergency-two-tone.mp3'),
  chaos_final_boss: require('../Alarms/10-chaos-final-boss.mp3'),
};

export const ALARM_SOUNDS = soundManifest.map((sound) => ({
  ...sound,
  id: sound.id as AlarmSoundId,
  source: SOUND_ASSETS[sound.id as AlarmSoundId],
}));

export { ALARM_SOUND_IDS, type AlarmSoundId };

export function alarmSoundName(soundId: string): string {
  return ALARM_SOUNDS.find((sound) => sound.id === soundId)?.name ?? 'Past sound';
}

export function alarmSoundAsset(soundId: string): number {
  return SOUND_ASSETS[soundId as AlarmSoundId] ?? SOUND_ASSETS.police_siren;
}
