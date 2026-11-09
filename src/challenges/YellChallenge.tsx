import React, { useEffect, useRef, useState } from 'react';
import { Alert, Animated, AppState, Platform, Text, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  getRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import {
  addAlarmListener,
  startMicrophoneMeter,
  stopMicrophoneMeter,
} from '../../modules/wayykup-alarm';
import { WAKE_CHALLENGE_CONFIG } from './config';
import {
  createYellState,
  powerScore,
  updateYellState,
  yellProgress,
  type YellMode,
  type YellState,
} from './yellMachine';
import { styles } from './challengeStyles';

type Props = {
  active: boolean;
  mode: YellMode;
  preview?: boolean;
  onComplete: (result: { durationMs: number; attempts: number; power: number }) => void;
  onFallback: (reason: string, result: { durationMs: number; attempts: number }) => void;
  onAlarmAudibleChange?: (audible: boolean) => void | Promise<void>;
  trackEvent: (name: string, properties: Record<string, string | number | boolean>) => void;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? -60;
}

export function YellChallenge({
  active,
  mode,
  preview = false,
  onComplete,
  onFallback,
  onAlarmAudibleChange,
  trackEvent,
}: Props) {
  const [progress, setProgress] = useState(0);
  const [power, setPower] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [calibrating, setCalibrating] = useState(true);
  const [success, setSuccess] = useState(false);
  const [alarmAudible, setAlarmAudible] = useState(false);
  const [scale] = useState(() => new Animated.Value(1));
  const startedAt = useRef(0);
  const lastProgressAt = useRef(0);
  const latestState = useRef<YellState | null>(null);
  const samples = useRef<number[]>([]);
  const finishOnce = useRef(false);
  const lastMilestone = useRef(0);
  const alarmAudibleRef = useRef(false);
  const calibratingRef = useRef(true);
  const powerRef = useRef(0);
  const meterStartedAt = useRef(0);
  const lastMeterEventAt = useRef(0);
  const calibrationStartedAt = useRef(0);
  const scorePausedUntil = useRef(0);
  const callbacks = useRef({ onComplete, onFallback, onAlarmAudibleChange, trackEvent });

  useEffect(() => {
    callbacks.current = { onComplete, onFallback, onAlarmAudibleChange, trackEvent };
  }, [onAlarmAudibleChange, onComplete, onFallback, trackEvent]);

  useEffect(() => {
    if (!active) return undefined;
    let mounted = true;
    const config = WAKE_CHALLENGE_CONFIG.yell;
    scale.setValue(1);
    startedAt.current = Date.now();
    lastProgressAt.current = startedAt.current;
    latestState.current = null;
    samples.current = [];
    meterStartedAt.current = 0;
    lastMeterEventAt.current = 0;
    calibrationStartedAt.current = 0;
    scorePausedUntil.current = 0;
    finishOnce.current = false;
    lastMilestone.current = 0;
    calibratingRef.current = true;
    alarmAudibleRef.current = false;
    const fallback = (reason: string) => {
      if (finishOnce.current || !mounted) return;
      finishOnce.current = true;
      callbacks.current.trackEvent('challenge_fallback_used', {
        type: 'yell',
        mode,
        duration_ms: Date.now() - startedAt.current,
        attempts: 1,
        reason,
        preview,
      });
      callbacks.current.onFallback(reason, { durationMs: Date.now() - startedAt.current, attempts: 1 });
    };
    const changeAlarmAudible = async (audible: boolean) => {
      try {
        await callbacks.current.onAlarmAudibleChange?.(audible);
      } catch (error) {
        console.error('Alarm audio could not be adjusted for Yell to Wake.', error);
        fallback('alarm_audio_unavailable');
      }
    };

    const complete = async () => {
      if (finishOnce.current || !mounted) return;
      finishOnce.current = true;
      const durationMs = Date.now() - startedAt.current;
      const finalPower = latestState.current?.peakPower ?? powerRef.current;
      setSuccess(true);
      setPower(finalPower);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        .catch((error: unknown) => console.warn('Yell challenge success haptic failed.', error));
      Animated.sequence([
        Animated.spring(scale, { toValue: 1.08, useNativeDriver: true, speed: 14, bounciness: 12 }),
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 12, bounciness: 8 }),
      ]).start();
      callbacks.current.trackEvent('challenge_completed', {
        type: 'yell',
        mode,
        duration_ms: durationMs,
        attempts: 1,
        power: finalPower,
        preview,
      });
      await new Promise((resolve) => setTimeout(resolve, config.successMomentMs));
      if (mounted) callbacks.current.onComplete({ durationMs, attempts: 1, power: finalPower });
    };

    let subscription: { remove: () => void } | undefined;
    let errorSubscription: { remove: () => void } | undefined;
    const begin = async () => {
      if (Platform.OS === 'web') {
        fallback('resource_unavailable');
        return;
      }
      const permission = await getRecordingPermissionsAsync();
      if (!permission.granted) {
        callbacks.current.trackEvent('challenge_permission_denied', {
          type: 'yell',
          mode,
          duration_ms: 0,
          attempts: 1,
          preview,
        });
        fallback('permission_denied');
        return;
      }
      await changeAlarmAudible(false);
      if (finishOnce.current) return;
      await setAudioModeAsync({
        allowsRecording: true,
        allowsBackgroundRecording: false,
        playsInSilentMode: true,
        shouldRouteThroughEarpiece: false,
        interruptionMode: 'mixWithOthers',
      });
      subscription = addAlarmListener('microphoneLevel', (event) => {
        if (!('dbfs' in event) || !mounted || finishOnce.current) return;
        const now = Date.now();
        lastMeterEventAt.current = now;
        if (!latestState.current) {
          if (calibrationStartedAt.current === 0) calibrationStartedAt.current = now;
          samples.current.push(event.dbfs);
          if (now - calibrationStartedAt.current < config.calibrationMs) return;
          const calibratedState = createYellState(mode, median(samples.current), now);
          latestState.current = calibratedState;
          if (!calibratedState.targetReachable) {
            fallback('room_too_loud');
            return;
          }
          setCalibrating(false);
          calibratingRef.current = false;
          callbacks.current.trackEvent('challenge_started', {
            type: 'yell',
            mode,
            duration_ms: 0,
            attempts: 1,
            preview,
          });
          return;
        }

        const previousProgress = latestState.current.progressMs;
        const nextState = updateYellState(
          latestState.current,
          event.dbfs,
          now,
          alarmAudibleRef.current || now < scorePausedUntil.current,
        );
        latestState.current = nextState;
        if (alarmAudibleRef.current) {
          if (nextState.smoothedDbfs >= nextState.targetDbfs) {
            setAlarmAudible(false);
            alarmAudibleRef.current = false;
            scorePausedUntil.current = now + config.alarmMuteSettleMs;
            latestState.current = {
              ...nextState,
              smoothedDbfs: nextState.baselineDbfs,
              aboveSince: null,
            };
            void changeAlarmAudible(false);
          }
          return;
        }
        if (now < scorePausedUntil.current) {
          latestState.current = {
            ...nextState,
            smoothedDbfs: nextState.baselineDbfs,
            aboveSince: null,
          };
          return;
        }
        const nextProgress = yellProgress(nextState);
        setProgress(nextProgress);
        const nextPower = powerScore(nextState.smoothedDbfs, nextState.baselineDbfs);
        powerRef.current = nextPower;
        setPower(nextPower);

        if (nextState.progressMs > previousProgress) lastProgressAt.current = now;
        for (const milestone of config.hapticMilestones) {
          if (nextProgress >= milestone && lastMilestone.current < milestone) {
            lastMilestone.current = milestone;
            void Haptics.impactAsync(milestone === 100 ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Medium)
              .catch((error: unknown) => console.warn('Yell challenge progress haptic failed.', error));
          }
        }
        if (nextProgress >= 100) void complete();
      });
      errorSubscription = addAlarmListener('microphoneError', (event) => {
        if ('reason' in event) fallback(event.reason || 'resource_unavailable');
      });
      lastMeterEventAt.current = Date.now();
      await startMicrophoneMeter();
      meterStartedAt.current = Date.now();
      if (!mounted) await stopMicrophoneMeter();
    };

    void begin().catch((error: unknown) => {
      console.error('Yell challenge microphone meter could not start.', error);
      fallback('resource_unavailable');
    });

    const timer = setInterval(() => {
      if (!mounted || finishOnce.current) return;
      const now = Date.now();
      const elapsed = now - startedAt.current;
      setElapsedMs(elapsed);
      if (elapsed >= config.maxDurationMs) {
        fallback('timeout');
      } else if (meterStartedAt.current > 0
        && now - lastMeterEventAt.current >= config.microphoneSilenceTimeoutMs) {
        fallback('resource_unavailable');
      } else if (!calibratingRef.current && !alarmAudibleRef.current && now - lastProgressAt.current >= config.noProgressAlarmMs) {
        setAlarmAudible(true);
        alarmAudibleRef.current = true;
        void changeAlarmAudible(true);
      }
    }, config.timerTickMs);
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') fallback('app_backgrounded');
    });

    return () => {
      mounted = false;
      clearInterval(timer);
      appStateSubscription.remove();
      subscription?.remove();
      errorSubscription?.remove();
      void stopMicrophoneMeter().catch((error: unknown) => console.error('Yell challenge microphone could not stop.', error));
      void setAudioModeAsync({
        allowsRecording: false,
        allowsBackgroundRecording: false,
        playsInSilentMode: true,
        interruptionMode: 'doNotMix',
        shouldPlayInBackground: true,
      }).catch((error: unknown) => console.error('Alarm audio mode could not be restored after Yell.', error));
      callbacks.current.onAlarmAudibleChange?.(false);
    };
  }, [active, mode, preview, scale]);

  const requestFallback = () => {
    if (finishOnce.current) return;
    Alert.alert('Switch challenge?', 'The selected fallback challenge will replace Yell to Wake for this alarm.', [
      { text: 'Keep trying', style: 'cancel' },
      { text: "Can't do this now", style: 'destructive', onPress: () => {
        if (finishOnce.current) return;
        finishOnce.current = true;
        callbacks.current.trackEvent('challenge_fallback_used', {
          type: 'yell',
          mode,
          duration_ms: Date.now() - startedAt.current,
          attempts: 1,
          reason: 'user_requested',
          preview,
        });
        callbacks.current.onFallback('user_requested', { durationMs: Date.now() - startedAt.current, attempts: 1 });
      } },
    ]);
  };

  return (
    <View style={styles.challengePanel}>
      <Text style={styles.challengeEyebrow}>{preview ? 'TRY IT NOW · MICROPHONE LEVEL ONLY' : 'YELL TO WAKE'}</Text>
      <Text style={styles.challengePrompt}>{success ? 'WAKE-UP PROVED' : calibrating ? 'LISTENING TO YOUR ROOM' : alarmAudible ? 'YOUR TURN — GET LOUD' : 'SHOUT TO FILL THE METER'}</Text>
      <Animated.View style={[styles.yellMeterOuter, { transform: [{ scale }] }]}>
        <View style={[styles.yellMeterFill, { height: `${progress}%` }]} />
        <View style={styles.yellTargetLine} />
        <Text style={styles.yellMeterScore}>{String(success ? power : progress).padStart(2, '0')}</Text>
        <Text style={styles.yellMeterCaption}>POWER</Text>
      </Animated.View>
      <Text style={styles.challengeHint}>
        {calibrating
          ? 'Measuring room sound through the phone mic. Disconnect any headset. No audio is saved.'
          : `Peak power ${power}/100 · ${Math.max(0, Math.ceil((WAKE_CHALLENGE_CONFIG.yell.maxDurationMs - elapsedMs) / 1000))}s left`}
      </Text>
      {!preview && (
        <TouchableOpacity accessibilityRole="button" onPress={requestFallback} style={styles.challengeFallbackButton}>
          <Text style={styles.challengeFallbackText}>CAN&apos;T DO THIS RIGHT NOW</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
