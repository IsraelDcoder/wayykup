import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Mixpanel } from 'mixpanel-react-native';
import { Platform } from 'react-native';
import { materializeOccurrences } from './stats/repository';
import {
  getHealth as getNativeAlarmHealth,
  isNativeAlarmAvailable,
  openSettings as openNativeAlarmSettings,
  requestPermissions as requestNativeAlarmPermissions,
  schedule as scheduleNativeAlarm,
  cancel as cancelNativeAlarm,
  type AlarmHealth,
} from '../modules/wayykup-alarm';

export type AlarmRecord = {
  id: string;
  time: string;
  task: 'Math' | 'Shake' | 'QR scan' | 'Memory' | 'Object Hunt' | 'Toothbrush' | 'Push-ups' | 'Squats';
  days: string[];
  sound: string;
  customSoundUri?: string;
  customSoundName?: string;
  enabled: boolean;
  savage: boolean;
  qrCode?: string;
  huntItems?: string[];
  huntTarget?: string;
  mathDifficulty: 'Easy' | 'Medium' | 'Hard';
  shakeCount?: number;
};

const ALARMS_STORAGE_KEY = 'savage-alarm:alarms:v1';
const KEEP_ALARM_PLAYING_STORAGE_KEY = 'wayykup:keep-alarm-playing:v1';
const APP_PROGRESS_STORAGE_KEY = 'wayykup:app-progress:v1';
const NATIVE_ALARMS_STORAGE_KEY = 'wayykup:native-alarm-ids:v1';

export type AppProgress = {
  onboardingComplete: boolean;
  appUnlocked: boolean;
};

let mixpanel: Mixpanel | null = null;

function isAlarmRecord(value: unknown): value is AlarmRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.time === 'string'
    && ['Math', 'Shake', 'QR scan', 'Memory', 'Object Hunt', 'Toothbrush', 'Push-ups', 'Squats'].includes(String(record.task))
    && Array.isArray(record.days)
    && record.days.every((day) => typeof day === 'string')
    && typeof record.sound === 'string'
    && (record.customSoundUri === undefined || typeof record.customSoundUri === 'string')
    && (record.customSoundName === undefined || typeof record.customSoundName === 'string')
    && typeof record.enabled === 'boolean'
    && typeof record.savage === 'boolean'
    && ['Easy', 'Medium', 'Hard'].includes(String(record.mathDifficulty))
    && (record.shakeCount === undefined || (typeof record.shakeCount === 'number' && [50, 100, 200].includes(record.shakeCount)))
    && (record.qrCode === undefined || typeof record.qrCode === 'string')
    && (record.huntItems === undefined || (Array.isArray(record.huntItems) && record.huntItems.every((item) => typeof item === 'string')))
    && (record.huntTarget === undefined || typeof record.huntTarget === 'string');
}

export async function loadAlarms(): Promise<AlarmRecord[] | null> {
  const savedAlarms = await AsyncStorage.getItem(ALARMS_STORAGE_KEY);
  if (!savedAlarms) return null;

  const parsed: unknown = JSON.parse(savedAlarms);
  if (!Array.isArray(parsed) || !parsed.every(isAlarmRecord)) {
    throw new Error('Saved alarm data is invalid.');
  }
  return parsed;
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
  const permission = current.granted ? current : await Notifications.requestPermissionsAsync();
  if (!permission.granted) return false;
  if (!isNativeAlarmAvailable) return false;
  const health = await requestNativeAlarmPermissions();
  return health.canRingNow;
}

export async function syncAlarmNotifications(alarms: AlarmRecord[]): Promise<void> {
  if (Platform.OS === 'web') return;

  await materializeOccurrences(alarms);
  if (!isNativeAlarmAvailable) {
    throw new Error('Native alarms are unavailable in Expo Go. Install a Wayykup development build.');
  }
  const health = await getNativeAlarmHealth();
  if (!health.canRingNow) {
    throw new Error(alarmHealthMessage(health));
  }
  if (!health.testAlarmPassed) {
    throw new Error('Complete Wayykup’s 60-second ring test before scheduling personal alarms.');
  }
  const previousIdsText = await AsyncStorage.getItem(NATIVE_ALARMS_STORAGE_KEY);
  const previousIds = previousIdsText ? JSON.parse(previousIdsText) as unknown : [];
  if (!Array.isArray(previousIds) || !previousIds.every((id) => typeof id === 'string')) {
    throw new Error('Saved native alarm identifiers are invalid.');
  }
  const enabled = alarms.filter((alarm) => alarm.enabled);
  const currentIds = enabled.map((alarm) => alarm.id);
  for (const oldId of previousIds) {
    if (!currentIds.includes(oldId)) await cancelNativeAlarm(oldId);
  }
  for (const alarm of alarms) {
    if (alarm.enabled) {
      await scheduleNativeAlarm(alarm);
    } else {
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
  if (!health.notifications) return 'Allow Wayykup notifications before scheduling an alarm.';
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
