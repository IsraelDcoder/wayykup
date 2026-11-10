import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Mixpanel } from 'mixpanel-react-native';
import { Platform } from 'react-native';
import { materializeOccurrences } from './stats/repository';
import { isAlarmRecord, migrateStoredAlarm, type AlarmRecord } from './alarmValidation';
import type { ChallengeTask } from './challenges/registry';
export type { AlarmRecord } from './alarmValidation';
import {
  getHealth as getNativeAlarmHealth,
  isNativeAlarmAvailable,
  openSettings as openNativeAlarmSettings,
  requestPermissions as requestNativeAlarmPermissions,
  schedule as scheduleNativeAlarm,
  cancel as cancelNativeAlarm,
  type AlarmHealth,
} from '../modules/wayykup-alarm';

const ALARMS_STORAGE_KEY = 'savage-alarm:alarms:v1';
const KEEP_ALARM_PLAYING_STORAGE_KEY = 'wayykup:keep-alarm-playing:v1';
const APP_PROGRESS_STORAGE_KEY = 'wayykup:app-progress:v1';
const NATIVE_ALARMS_STORAGE_KEY = 'wayykup:native-alarm-ids:v1';

export type AppProgress = {
  onboardingComplete: boolean;
  appUnlocked: boolean;
};

let mixpanel: Mixpanel | null = null;

export async function loadAlarms(): Promise<AlarmRecord[] | null> {
  const savedAlarms = await AsyncStorage.getItem(ALARMS_STORAGE_KEY);
  if (!savedAlarms) return null;

  const parsed: unknown = JSON.parse(savedAlarms);
  if (!Array.isArray(parsed)) {
    throw new Error('Saved alarm data is invalid.');
  }
  const alarms: AlarmRecord[] = [];
  for (const savedAlarm of parsed) {
    const alarm = migrateStoredAlarm(savedAlarm);
    if (!alarm) throw new Error('Saved alarm data is invalid.');
    alarms.push(alarm);
  }
  const normalized = JSON.stringify(alarms);
  if (normalized !== savedAlarms) {
    await AsyncStorage.setItem(ALARMS_STORAGE_KEY, normalized);
  }
  if (!alarms.every(isAlarmRecord)) throw new Error('Saved alarm migration did not produce valid alarm data.');
  return alarms;
}

export async function persistAlarms(alarms: AlarmRecord[]): Promise<void> {
  await AsyncStorage.setItem(ALARMS_STORAGE_KEY, JSON.stringify(alarms));
}

export async function loadKeepAlarmPlayingPreference(): Promise<boolean | null> {
  const savedPreference = await AsyncStorage.getItem(KEEP_ALARM_PLAYING_STORAGE_KEY);
  if (savedPreference === null) return null;
  if (savedPreference !== 'true' && savedPreference !== 'false') {
    throw new Error('Saved alarm playback preference is invalid.');
  }
  return savedPreference === 'true';
}

export async function persistKeepAlarmPlayingPreference(value: boolean): Promise<void> {
  await AsyncStorage.setItem(KEEP_ALARM_PLAYING_STORAGE_KEY, String(value));
}

export async function loadAppProgress(): Promise<AppProgress | null> {
  const savedProgress = await AsyncStorage.getItem(APP_PROGRESS_STORAGE_KEY);
  if (!savedProgress) return null;

  const parsed: unknown = JSON.parse(savedProgress);
  if (
    typeof parsed !== 'object'
    || parsed === null
    || typeof (parsed as Record<string, unknown>).onboardingComplete !== 'boolean'
    || typeof (parsed as Record<string, unknown>).appUnlocked !== 'boolean'
  ) {
    throw new Error('Saved app progress is invalid.');
  }
  return parsed as AppProgress;
}

export async function persistAppProgress(progress: AppProgress): Promise<void> {
  await AsyncStorage.setItem(APP_PROGRESS_STORAGE_KEY, JSON.stringify(progress));
}

export async function requestAlarmNotifications(): Promise<boolean> {
  if (Platform.OS === 'web') return false;

  const current = await Notifications.getPermissionsAsync();
  if (!current.granted) await Notifications.requestPermissionsAsync();
  if (!isNativeAlarmAvailable) return false;
  const health = await requestNativeAlarmPermissions();
  return health.canSchedule;
}

export async function syncAlarmNotifications(alarms: AlarmRecord[]): Promise<void> {
  if (Platform.OS === 'web') return;

  const schedulable = alarms.filter((alarm): alarm is AlarmRecord & { task: ChallengeTask } =>
    alarm.enabled && alarm.task !== null && alarm.challengeConfig !== undefined,
  );
  await materializeOccurrences(schedulable);
  if (!isNativeAlarmAvailable) {
    throw new Error('Native alarms are unavailable in Expo Go. Install a Wayykup development build.');
  }
  const health = await getNativeAlarmHealth();
  if (!health.canSchedule) {
    throw new Error(alarmHealthMessage(health));
  }
  const previousIdsText = await AsyncStorage.getItem(NATIVE_ALARMS_STORAGE_KEY);
  const previousIds = previousIdsText ? JSON.parse(previousIdsText) as unknown : [];
  if (!Array.isArray(previousIds) || !previousIds.every((id) => typeof id === 'string')) {
    throw new Error('Saved native alarm identifiers are invalid.');
  }
  const currentIds = schedulable.map((alarm) => alarm.id);
  for (const oldId of previousIds) {
    if (!currentIds.includes(oldId)) await cancelNativeAlarm(oldId);
  }
  for (const alarm of schedulable) {
    await scheduleNativeAlarm(alarm);
  }
  for (const alarm of alarms) {
    if (!alarm.enabled || alarm.task === null || !alarm.challengeConfig) {
      await cancelNativeAlarm(alarm.id);
    }
  }
  await AsyncStorage.setItem(NATIVE_ALARMS_STORAGE_KEY, JSON.stringify(currentIds));
}

export async function getAlarmHealth(): Promise<AlarmHealth> {
  if (Platform.OS === 'web' || !isNativeAlarmAvailable) {
    return {
      authorized: false,
      exactAlarm: false,
      fullScreenIntent: false,
      notifications: false,
      batteryRestricted: false,
      canSchedule: false,
      canRingNow: false,
      platform: 'unsupported',
      reliability: 'unavailable',
      testAlarmPassed: false,
    };
  }
  return getNativeAlarmHealth();
}

export function openAlarmSettings(kind: 'exactAlarm' | 'fullScreenIntent' | 'battery' | 'app') {
  return openNativeAlarmSettings(kind);
}

export function getBatteryRestrictionGuidance(deviceModel?: string): string {
  const manufacturer = deviceModel?.split(' ')[0]?.toLowerCase() ?? '';
  if (manufacturer.includes('samsung')) {
    return 'On Samsung, add Wayykup to Never sleeping apps under Battery > Background usage limits.';
  }
  if (manufacturer.includes('xiaomi') || manufacturer.includes('redmi')) {
    return 'On Xiaomi, enable Autostart for Wayykup and set Battery saver to No restrictions.';
  }
  if (manufacturer.includes('oppo') || manufacturer.includes('realme')) {
    return 'On Oppo/realme, allow Auto launch and background activity for Wayykup.';
  }
  if (manufacturer.includes('tecno') || manufacturer.includes('infinix')) {
    return 'On Tecno/Infinix, allow Auto-start in Phone Master and keep Wayykup active in battery settings.';
  }
  if (manufacturer.includes('google') || manufacturer.includes('pixel')) {
    return 'On Pixel, open App battery usage for Wayykup and allow background usage.';
  }
  return 'In your device battery settings, allow Wayykup to run in the background. OEM battery controls can delay alarms.';
}

function alarmHealthMessage(health: AlarmHealth): string {
  if (!health.canSchedule && !health.exactAlarm) return 'Allow Wayykup to schedule exact alarms in system settings.';
  if (!health.canSchedule && !health.notifications) return 'Allow Wayykup notifications before scheduling an alarm.';
  if (!health.canSchedule) return 'Wayykup cannot schedule an alarm. Check its alarm permissions in Settings.';
  if (!health.notifications) return 'The alarm can ring, but allow Wayykup notifications to see its alarm alert.';
  if (!health.exactAlarm) return 'Allow Wayykup to schedule exact alarms in system settings.';
  if (!health.fullScreenIntent && health.platform === 'android') {
    return 'Allow full-screen alarm notifications for Wayykup in system settings.';
  }
  return 'Wayykup cannot ring now. Check its alarm permissions in Settings.';
}

export async function initializeAnalytics(token: string | undefined): Promise<void> {
  if (!token || Platform.OS === 'web') return;
  mixpanel = await Mixpanel.init(token, false);
}

export function trackEvent(name: string, properties: Record<string, string | number | boolean> = {}): void {
  mixpanel?.track(name, properties);
}
