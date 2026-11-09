import React, { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Platform, Text, TouchableOpacity, View } from 'react-native';
import * as Brightness from 'expo-brightness';
import * as Haptics from 'expo-haptics';
import { Camera as ExpoCamera } from 'expo-camera';
import { Camera as FaceCamera, type Face } from 'react-native-vision-camera-face-detector';
import { WAKE_CHALLENGE_CONFIG } from './config';
import {
  createFaceState,
  shuffleFaceSequence,
  updateFaceState,
  type FaceGesture,
  type FaceSnapshot,
  type FaceState,
} from './faceMachine';
import { styles } from './challengeStyles';

type Props = {
  active: boolean;
  preview?: boolean;
  onComplete: (result: { durationMs: number; attempts: number; sequence: FaceGesture[] }) => void;
  onFallback: (reason: string, result: { durationMs: number; attempts: number }) => void;
  trackEvent: (name: string, properties: Record<string, string | number | boolean>) => void;
};

const GESTURE_LABELS: Record<FaceGesture, string> = {
  smile: 'SMILE',
  blink_twice: 'BLINK TWICE',
  turn_left: 'TURN LEFT',
  turn_right: 'TURN RIGHT',
  open_mouth: 'OPEN YOUR MOUTH',
};

function averageY(points: { x: number; y: number }[] | undefined): number | null {
  if (!points?.length) return null;
  return points.reduce((sum, point) => sum + point.y, 0) / points.length;
}

function toSnapshot(face: Face): FaceSnapshot {
  const upperLip = averageY(face.contours?.UPPER_LIP_BOTTOM);
  const lowerLip = averageY(face.contours?.LOWER_LIP_TOP);
  const mouthOpenRatio = upperLip === null || lowerLip === null || face.bounds.width <= 0
    ? undefined
    : Math.abs(lowerLip - upperLip) / face.bounds.width;
  return {
    smilingProbability: face.smilingProbability,
    leftEyeOpenProbability: face.leftEyeOpenProbability,
    rightEyeOpenProbability: face.rightEyeOpenProbability,
    yawAngle: face.yawAngle,
    mouthOpenRatio,
  };
}

function gestureProgress(state: FaceState, now: number): number {
  const gesture = state.sequence[state.index];
  if (!gesture) return 100;
  if (gesture === 'blink_twice') return Math.min(100, state.blinks * 50);
  if (state.targetSince === null) return 0;
  const holdMs = gesture === 'smile'
    ? WAKE_CHALLENGE_CONFIG.face.smileHoldMs
    : gesture === 'open_mouth'
      ? WAKE_CHALLENGE_CONFIG.face.mouthHoldMs
      : WAKE_CHALLENGE_CONFIG.face.headTurnHoldMs;
  return Math.min(100, Math.round(((now - state.targetSince) / holdMs) * 100));
}

export function FaceChallengeNative({ active, preview = false, onComplete, onFallback, trackEvent }: Props) {
  const [state, setState] = useState<FaceState | null>(null);
  const [facePresent, setFacePresent] = useState(false);
  const [lowLight, setLowLight] = useState(false);
  const [progress, setProgress] = useState(0);
  const [success, setSuccess] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lowLightRemainingMs, setLowLightRemainingMs] = useState(0);
  const [appIsActive, setAppIsActive] = useState(AppState.currentState === 'active');
  const startedAt = useRef(0);
  const latestState = useRef<FaceState | null>(null);
  const lastFrameAt = useRef(0);
  const finishOnce = useRef(false);
  const mountedRef = useRef(false);
  const previousBrightnessRef = useRef<number | null>(null);
  const brightnessRaisedRef = useRef(false);
  const callbacks = useRef({ onComplete, onFallback, trackEvent });

  useEffect(() => {
    callbacks.current = { onComplete, onFallback, trackEvent };
  }, [onComplete, onFallback, trackEvent]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      setAppIsActive(nextState === 'active');
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    let mounted = true;
    mountedRef.current = true;
    finishOnce.current = false;
    startedAt.current = 0;
    latestState.current = null;
    lastFrameAt.current = 0;
    previousBrightnessRef.current = null;
    brightnessRaisedRef.current = false;
    const begin = async () => {
      if (Platform.OS === 'web') {
        fallback('resource_unavailable');
        return;
      }
      const permission = await ExpoCamera.getCameraPermissionsAsync();
      if (!permission.granted) {
        callbacks.current.trackEvent('challenge_permission_denied', {
          type: 'face',
          mode: 'gesture_sequence',
          duration_ms: 0,
          attempts: 1,
          gesture_sequence: '',
          preview,
        });
        fallback('permission_denied');
        return;
      }
      const initialState = createFaceState(Date.now());
      startedAt.current = initialState.startedAt;
      latestState.current = initialState;
      setState(initialState);
      callbacks.current.trackEvent('challenge_started', {
        type: 'face',
        mode: 'gesture_sequence',
        duration_ms: 0,
        attempts: 1,
        gesture_sequence: initialState.sequence.join(','),
        preview,
      });
    };
    const fallback = (reason: string) => {
      if (!mounted || finishOnce.current) return;
      finishOnce.current = true;
      const current = latestState.current;
      callbacks.current.trackEvent('challenge_fallback_used', {
        type: 'face',
        mode: 'gesture_sequence',
        duration_ms: Date.now() - startedAt.current,
        attempts: current?.attempts ?? 1,
        gesture_sequence: current?.sequence.join(',') ?? '',
        reason,
        preview,
      });
      callbacks.current.onFallback(reason, {
        durationMs: startedAt.current ? Date.now() - startedAt.current : 0,
        attempts: current?.attempts ?? 1,
      });
    };
    const timer = setInterval(() => {
      if (!mounted || finishOnce.current || !startedAt.current) return;
      const elapsed = Date.now() - startedAt.current;
      setElapsedMs(elapsed);
      const missingSince = latestState.current?.faceMissingSince;
      setLowLightRemainingMs(missingSince === null || missingSince === undefined
        ? 0
        : Math.max(0, missingSince + WAKE_CHALLENGE_CONFIG.face.lowLightFallbackMs - Date.now()));
      if (elapsed >= WAKE_CHALLENGE_CONFIG.face.maxDurationMs) fallback('timeout');
    }, WAKE_CHALLENGE_CONFIG.face.timerTickMs);
    void begin().catch((error: unknown) => {
      console.error('Face Challenge camera permission could not be checked.', error);
      fallback('resource_unavailable');
    });

    return () => {
      mounted = false;
      mountedRef.current = false;
      clearInterval(timer);
      if (brightnessRaisedRef.current && previousBrightnessRef.current !== null) {
        void Brightness.setBrightnessAsync(previousBrightnessRef.current)
          .catch((error: unknown) => console.error('Display brightness could not be restored after Face Challenge.', error));
        brightnessRaisedRef.current = false;
      }
    };
  }, [active, preview]);

  const onFacesDetected = (faces: Face[]) => {
    if (!active || finishOnce.current) return;
    const now = Date.now();
    if (now - lastFrameAt.current < WAKE_CHALLENGE_CONFIG.face.frameIntervalMs) return;
    lastFrameAt.current = now;
    const face = faces[0];
    setFacePresent(Boolean(face));
    const previous = latestState.current;
    if (!previous) return;
    const next = updateFaceState(previous, face ? toSnapshot(face) : null, now, () => shuffleFaceSequence());
    latestState.current = next.state;
    setState(next.state);
    const nextProgress = gestureProgress(next.state, now);
    setProgress(nextProgress);
    setLowLight(next.lowLight);

    if (!face && next.state.faceMissingSince !== null
      && now - next.state.faceMissingSince >= WAKE_CHALLENGE_CONFIG.face.lowLightFallbackMs) {
      if (!finishOnce.current) {
        finishOnce.current = true;
        callbacks.current.trackEvent('challenge_fallback_used', {
          type: 'face',
          mode: 'gesture_sequence',
          duration_ms: now - startedAt.current,
          attempts: next.state.attempts,
          gesture_sequence: next.state.sequence.join(','),
          reason: 'low_light_timeout',
          preview,
        });
        callbacks.current.onFallback('low_light_timeout', {
          durationMs: now - startedAt.current,
          attempts: next.state.attempts,
        });
      }
      return;
    }

    if (next.lowLight && !lowLight) {
      void Brightness.getBrightnessAsync()
        .then((brightness) => {
          if (!active || !mountedRef.current) return;
          previousBrightnessRef.current = brightness;
          return Brightness.setBrightnessAsync(WAKE_CHALLENGE_CONFIG.face.brightnessBoost).then(() => { brightnessRaisedRef.current = true; });
        })
        .catch((error: unknown) => console.warn('Face Challenge could not brighten the display.', error));
    } else if (!next.lowLight && lowLight && brightnessRaisedRef.current && previousBrightnessRef.current !== null) {
      void Brightness.setBrightnessAsync(previousBrightnessRef.current)
        .catch((error: unknown) => console.error('Face Challenge brightness could not be restored.', error));
      brightnessRaisedRef.current = false;
    }

    if (next.retry) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
        .catch((error: unknown) => console.warn('Face Challenge retry haptic failed.', error));
      callbacks.current.trackEvent('challenge_attempt_restarted', {
        type: 'face',
        mode: 'gesture_sequence',
        duration_ms: now - startedAt.current,
        attempts: next.state.attempts,
        gesture_sequence: next.state.sequence.join(','),
        preview,
      });
    }
    if (next.completed) {
      finishOnce.current = true;
      setSuccess(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        .catch((error: unknown) => console.warn('Face Challenge success haptic failed.', error));
      const durationMs = now - startedAt.current;
      callbacks.current.trackEvent('challenge_completed', {
        type: 'face',
        mode: 'gesture_sequence',
        duration_ms: durationMs,
        attempts: next.state.attempts,
        gesture_sequence: next.state.sequence.join(','),
        preview,
      });
      setTimeout(() => {
        if (mountedRef.current) callbacks.current.onComplete({
          durationMs,
          attempts: next.state.attempts,
          sequence: next.state.sequence,
        });
      }, WAKE_CHALLENGE_CONFIG.face.successMomentMs);
    }
    if (!face && previous.faceMissingSince === null) {
      setProgress(0);
    }
  };

  const currentGesture = state?.sequence[state.index];
  const elapsedLeft = Math.max(0, Math.ceil((WAKE_CHALLENGE_CONFIG.face.maxDurationMs - elapsedMs) / 1000));

  return (
    <View style={styles.challengePanel}>
      <Text style={styles.challengeEyebrow}>{preview ? 'TRY IT NOW · ON-DEVICE FACE LANDMARKS' : 'FACE CHALLENGE'}</Text>
      <Text style={styles.challengePrompt}>{success ? 'SEQUENCE DEFEATED' : currentGesture ? GESTURE_LABELS[currentGesture] : 'PREPARING CAMERA'}</Text>
      <View style={[styles.facePreview, lowLight && styles.facePreviewBright, success && styles.facePreviewSuccess]}>
        <FaceCamera
          device="front"
          isActive={active && appIsActive && !success}
          cameraFacing="front"
          constraints={[{ fps: WAKE_CHALLENGE_CONFIG.face.cameraFrameRate }]}
          performanceMode="fast"
          minFaceSize={WAKE_CHALLENGE_CONFIG.face.minimumFaceSize}
          runClassifications
          runContours
          runLandmarks
          trackingEnabled
          outputResolution="preview"
          onFacesDetected={onFacesDetected}
          onError={(error) => {
            console.error('Face Challenge camera failed.', error);
            if (!finishOnce.current) {
              finishOnce.current = true;
              callbacks.current.trackEvent('challenge_fallback_used', {
                type: 'face',
                mode: 'gesture_sequence',
                duration_ms: Date.now() - startedAt.current,
                attempts: latestState.current?.attempts ?? 1,
                gesture_sequence: latestState.current?.sequence.join(',') ?? '',
                reason: 'resource_unavailable',
                preview,
              });
              callbacks.current.onFallback('resource_unavailable', {
                durationMs: Date.now() - startedAt.current,
                attempts: latestState.current?.attempts ?? 1,
              });
            }
          }}
          style={styles.faceCamera}
        />
        <View pointerEvents="none" style={styles.faceGuide}>
          <View style={[styles.faceGuideOval, facePresent && styles.faceGuidePresent, success && styles.faceGuideSuccess]} />
        </View>
        {lowLight && <View pointerEvents="none" style={styles.faceLightOverlay} />}
      </View>
      <View style={styles.faceProgressRow}>
        {state?.sequence.map((gesture, index) => (
          <View key={`${gesture}-${index}`} style={[styles.faceProgressStep, index < (state?.index ?? 0) && styles.faceProgressStepDone]}>
            <Text style={styles.faceProgressText}>{index < (state?.index ?? 0) ? '✓' : String(index + 1)}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.challengeHint}>
        {lowLight
          ? `Move into brighter light · fallback in ${Math.ceil(lowLightRemainingMs / 1000)}s`
          : facePresent
            ? `${state?.attempts ?? 1} attempt${state?.attempts === 1 ? '' : 's'} · ${elapsedLeft}s left`
            : 'Center your face in the guide to begin'}
      </Text>
      <View style={styles.faceGestureMeter}>
        <View style={[styles.faceGestureMeterFill, { width: `${success ? 100 : progress}%` }]} />
      </View>
      {!preview && (
        <TouchableOpacity accessibilityRole="button" onPress={() => Alert.alert('Switch challenge?', 'The selected fallback challenge will replace Face Challenge for this alarm.', [
          { text: 'Keep trying', style: 'cancel' },
          { text: "Can't do this now", style: 'destructive', onPress: () => {
            if (finishOnce.current) return;
            finishOnce.current = true;
            const current = latestState.current;
            callbacks.current.trackEvent('challenge_fallback_used', {
              type: 'face',
              mode: 'gesture_sequence',
              duration_ms: Date.now() - startedAt.current,
              attempts: current?.attempts ?? 1,
              gesture_sequence: current?.sequence.join(',') ?? '',
              reason: 'user_requested',
              preview,
            });
            callbacks.current.onFallback('user_requested', {
              durationMs: Date.now() - startedAt.current,
              attempts: current?.attempts ?? 1,
            });
          } },
        ])} style={styles.challengeFallbackButton}>
          <Text style={styles.challengeFallbackText}>CAN&apos;T DO THIS RIGHT NOW</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
