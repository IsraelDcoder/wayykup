import { requireOptionalNativeModule } from 'expo-modules-core';

export type AlarmSchedule = {
  id: string;
  time: string;
  days: string[];
  enabled: boolean;
  task: string;
  sound: string;
  customSoundUri?: string;
  customSoundName?: string;
  mathDifficulty?: string;
  shakeCount?: number;
};

export type AlarmHealth = {
  authorized: boolean;
  exactAlarm: boolean;
  fullScreenIntent: boolean;
  notifications: boolean;
  batteryRestricted: boolean;
  canRingNow: boolean;
  testAlarmPassed: boolean;
  platform: 'android' | 'ios' | 'unsupported';
  deviceModel?: string;
  osVersion?: string;
  reliability: 'native' | 'reduced' | 'unavailable';
};

export type RingStartedEvent = {
  alarmId: string;
  occurrenceId: string;
  at: number;
  scheduledAt: number;
  challenge: string;
  sound: string;
  testAlarm?: boolean;
};

export type ObjectPrediction = {
  label: string;
  confidence: number;
};

type NativeAlarmModule = {
  classifyImage(uri: string): Promise<ObjectPrediction[]>;
  importSound(uri: string, name: string): Promise<{ uri: string; name: string; displayName: string }>;
  schedule(alarm: AlarmSchedule): Promise<void>;
  cancel(alarmId: string): Promise<void>;
  rearm(alarmId: string, delaySeconds: number): Promise<void>;
  cancelChain(alarmId: string, status: 'completed' | 'bypassed' | 'abandoned'): Promise<void>;
  getHealth(): Promise<AlarmHealth>;
  requestPermissions(): Promise<AlarmHealth>;
  openSettings(kind: 'exactAlarm' | 'fullScreenIntent' | 'battery' | 'app'): Promise<void>;
  startTestAlarm(): Promise<void>;
  addListener(
    eventName: 'ringStarted' | 'challengeCompleted' | 'healthChanged',
    listener: (event: RingStartedEvent | AlarmHealth) => void,
  ): { remove(): void };
  getPendingChallenge(): Promise<RingStartedEvent | null>;
  consumePendingChallenge(): Promise<void>;
};

const nativeModule = requireOptionalNativeModule<NativeAlarmModule>('WayykupAlarm');

export const isNativeAlarmAvailable = nativeModule !== null;

export const classifyImage = (uri: string) => requireModule().classifyImage(uri);

function requireModule(): NativeAlarmModule {
  if (!nativeModule) {
    throw new Error('Wayykup native alarms require an installed development build. Expo Go is not supported.');
  }
  return nativeModule;
}

export const schedule = (alarm: AlarmSchedule) => requireModule().schedule(alarm);
export const importSound = (uri: string, name: string) => requireModule().importSound(uri, name);
export const cancel = (alarmId: string) => requireModule().cancel(alarmId);
export const rearm = (alarmId: string, delayMs = 75_000) =>
  requireModule().rearm(alarmId, delayMs / 1000);
export const cancelChain = (alarmId: string, status: 'completed' | 'bypassed' | 'abandoned' = 'completed') =>
  requireModule().cancelChain(alarmId, status);
export const getHealth = () => requireModule().getHealth();
export const requestPermissions = () => requireModule().requestPermissions();
export const openSettings = (kind: 'exactAlarm' | 'fullScreenIntent' | 'battery' | 'app') =>
  requireModule().openSettings(kind);
export const getPendingChallenge = () => requireModule().getPendingChallenge();
export const consumePendingChallenge = () => requireModule().consumePendingChallenge();
export const startTestAlarm = () => requireModule().startTestAlarm();

export function addAlarmListener(
  eventName: 'ringStarted' | 'challengeCompleted' | 'healthChanged',
  listener: (event: RingStartedEvent | AlarmHealth) => void,
) {
  if (!nativeModule) return { remove() {} };
  return nativeModule.addListener(eventName, listener);
}
