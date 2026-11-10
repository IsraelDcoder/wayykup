import { requireOptionalNativeModule } from 'expo-modules-core';
import type { AlarmSoundId } from '../../src/alarmSoundIds';

export type AlarmSchedule = {
  id: string;
  time: string;
  days: string[];
  enabled: boolean;
  task: 'Yell to Stop' | 'Push-up Challenge' | 'Shake Your Phone' | 'Object Hunt';
  sound: AlarmSoundId;
};

export type AlarmHealth = {
  authorized: boolean;
  exactAlarm: boolean;
  fullScreenIntent: boolean;
  notifications: boolean;
  batteryRestricted: boolean;
  canSchedule: boolean;
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
  state?: 'ringing' | 'challenge_pending' | 'challenge_active';
};

export type ObjectPrediction = {
  label: string;
  confidence: number;
};

export type PoseLandmark = {
  x: number;
  y: number;
  confidence: number;
};

export type PushUpPose = Partial<Record<
  'leftShoulder' | 'leftElbow' | 'leftWrist' | 'leftHip' | 'leftAnkle'
  | 'rightShoulder' | 'rightElbow' | 'rightWrist' | 'rightHip' | 'rightAnkle',
  PoseLandmark
>>;

export type SpeechResultEvent = {
  recognized: boolean;
  text: string;
  confidence: number;
};

export type SpeechErrorEvent = {
  reason: string;
};

type AlarmEventMap = {
  ringStarted: RingStartedEvent;
  challengeCompleted: RingStartedEvent;
  healthChanged: AlarmHealth;
  speechResult: SpeechResultEvent;
  speechError: SpeechErrorEvent;
};

type NativeAlarmModule = {
  classifyImage(uri: string, target: string): Promise<ObjectPrediction[]>;
  detectPushUpPose(uri: string): Promise<PushUpPose>;
  schedule(alarm: AlarmSchedule): Promise<void>;
  cancel(alarmId: string): Promise<void>;
  rearm(alarmId: string, delaySeconds: number): Promise<void>;
  activateChallenge(alarmId: string, occurrenceId: string): Promise<void>;
  cancelChain(alarmId: string, status: 'completed', occurrenceId: string): Promise<void>;
  getHealth(): Promise<AlarmHealth>;
  requestPermissions(): Promise<AlarmHealth>;
  openSettings(kind: 'exactAlarm' | 'fullScreenIntent' | 'battery' | 'app'): Promise<void>;
  startTestAlarm(): Promise<void>;
  startSpeechRecognition(phrase: string): Promise<void>;
  stopSpeechRecognition(): Promise<void>;
  setAlarmAudioDucked(ducked: boolean, fadeDurationMs: number): Promise<void>;
  setAlarmVolumeTier(tier: number): Promise<void>;
  addListener<K extends keyof AlarmEventMap>(
    eventName: K,
    listener: (event: AlarmEventMap[K]) => void,
  ): { remove(): void };
  getPendingChallenge(): Promise<RingStartedEvent | null>;
  consumePendingChallenge(): Promise<void>;
};

const nativeModule = requireOptionalNativeModule<NativeAlarmModule>('WayykupAlarm');

export const isNativeAlarmAvailable = nativeModule !== null;

export const classifyImage = (uri: string, target: string) => requireModule().classifyImage(uri, target);
export const detectPushUpPose = (uri: string) => requireModule().detectPushUpPose(uri);

function requireModule(): NativeAlarmModule {
  if (!nativeModule) {
    throw new Error('Wayykup native alarms require an installed development build. Expo Go is not supported.');
  }
  return nativeModule;
}

export const schedule = (alarm: AlarmSchedule) => requireModule().schedule(alarm);
export const cancel = (alarmId: string) => requireModule().cancel(alarmId);
export const rearm = (alarmId: string, delayMs = 75_000) =>
  requireModule().rearm(alarmId, delayMs / 1000);
export const activateChallenge = (alarmId: string, occurrenceId: string) =>
  requireModule().activateChallenge(alarmId, occurrenceId);
export const cancelChain = (alarmId: string, occurrenceId: string) =>
  requireModule().cancelChain(alarmId, 'completed', occurrenceId);
export const getHealth = () => requireModule().getHealth();
export const requestPermissions = () => requireModule().requestPermissions();
export const openSettings = (kind: 'exactAlarm' | 'fullScreenIntent' | 'battery' | 'app') =>
  requireModule().openSettings(kind);
export const getPendingChallenge = () => requireModule().getPendingChallenge();
export const consumePendingChallenge = () => requireModule().consumePendingChallenge();
export const startTestAlarm = () => requireModule().startTestAlarm();
export const startSpeechRecognition = (phrase: string) => requireModule().startSpeechRecognition(phrase);
export const stopSpeechRecognition = () => nativeModule?.stopSpeechRecognition() ?? Promise.resolve();
export const setAlarmAudioDucked = (ducked: boolean, fadeDurationMs: number) =>
  nativeModule?.setAlarmAudioDucked(ducked, fadeDurationMs) ?? Promise.resolve();
export const setAlarmVolumeTier = (tier: number) =>
  nativeModule?.setAlarmVolumeTier(tier) ?? Promise.resolve();

export function addAlarmListener<K extends keyof AlarmEventMap>(
  eventName: K,
  listener: (event: AlarmEventMap[K]) => void,
) {
  if (!nativeModule) return { remove() {} };
  return nativeModule.addListener(eventName, listener);
}
