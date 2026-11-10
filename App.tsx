import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  AccessibilityInfo,
  Alert,
  AppState,
  BackHandler,
  Easing,
  Modal,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
  Platform,
  Linking,
  useWindowDimensions,
  type ScrollViewInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import Svg, { Circle, Path } from 'react-native-svg';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import ReanimatedAnimated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { Accelerometer } from 'expo-sensors';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import Purchases, {
  type CustomerInfo,
  type PurchasesOffering,
} from 'react-native-purchases';
import { isPurchasesError, PURCHASES_ERROR_CODE } from 'react-native-purchases';
import {
  initializeAnalytics,
  loadAlarms,
  loadAppProgress,
  persistAlarms,
  persistAppProgress,
  loadKeepAlarmPlayingPreference,
  persistKeepAlarmPlayingPreference,
  type AlarmRecord,
  requestAlarmNotifications,
  syncAlarmNotifications,
  getAlarmHealth,
  getBatteryRestrictionGuidance,
  openAlarmSettings,
  trackEvent,
} from './src/nativeServices';
import {
  addAlarmListener,
  cancelChain as cancelNativeAlarmChain,
  classifyImage,
  activateChallenge as activateNativeChallenge,
  getPendingChallenge,
  isNativeAlarmAvailable,
  setAlarmAudioDucked,
  setAlarmVolumeTier,
  schedule as scheduleNativeAlarm,
  startTestAlarm,
  type AlarmHealth,
  type RingStartedEvent,
} from './modules/wayykup-alarm';
import { StatsScreen } from './src/stats/StatsScreen';
import { StreakMoment } from './src/stats/StreakMoment';
import { ALARM_SOUNDS, alarmSoundAsset, alarmSoundName } from './src/alarmSounds';
import { DEFAULT_ALARM_SOUND_ID, migrateAlarmSoundId } from './src/alarmSoundIds';
import { WayykupIcon } from './src/components/WayykupIcon';
import {
  calculateStreaks,
  countsTowardStreak,
  timeToWakeMs,
} from './src/stats/logic';
import {
  completeOccurrence,
  earnFreezeForStreak,
  getOccurrences,
  getStreakFreezes,
  makeOccurrence,
  markOccurrenceRinging,
  materializeOccurrences,
  reconcileOccurrences,
  recordFailedAttempt,
  setMorningRating,
  spendFreeze,
  usedFreezeDates,
} from './src/stats/repository';
import { registerOccurrenceReconciliationTask } from './src/stats/background';
import type { Occurrence, StreakFreeze } from './src/stats/types';
import { OnboardingFlow, type OnboardingSetup } from './src/OnboardingFlow';
import {
  chooseHuntTargetForDifficulty,
  huntTargetsForDifficulty,
  HUNT_ITEMS,
  matchesHuntObject,
} from './src/challenges/objects';
import { PushUpChallenge } from './src/challenges/PushUpChallenge';
import { YellChallenge } from './src/challenges/YellChallenge';
import { createShakeState, updateShakeState } from './src/challenges/shakeMachine';
import {
  CHALLENGE_OPTIONS,
  challengeTypeForTask,
  defaultChallengeConfiguration,
  isChallengeConfiguration,
  type ChallengeConfiguration,
  type ChallengeTask,
} from './src/challenges/registry';
import { GlassNavigationBar } from './src/components/GlassNavigationBar';
import { transitionAlarmState, type AlarmLifecycleState } from './src/alarmLifecycle';

type Task = ChallengeTask;
type Screen = 'welcome' | 'proof' | 'paywall' | 'home' | 'editor' | 'ringing' | 'alarm' | 'wakeSuccess' | 'stats' | 'streak' | 'settings';
type PaywallStage = 'intro' | 'reminder' | 'timeline' | 'gift';
type Alarm = AlarmRecord;
type ActiveAlarm = Alarm & { task: Task; challengeConfig: ChallengeConfiguration };

function alarmsWithSelectedChallenges(alarms: Alarm[]): Array<Alarm & { task: Task }> {
  return alarms.filter((alarm): alarm is Alarm & { task: Task } =>
    alarm.task !== null && alarm.challengeConfig !== undefined,
  );
}

const RED = '#FF1717';
const INK = '#171717';
const MUTED = '#77736F';
const PAPER = '#F7F7F9';
const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const TASKS = CHALLENGE_OPTIONS;
const REVENUECAT_API_KEY = Platform.OS === 'ios'
  ? 'appl_hziHOEqZqnXMyxzQqPTrvjVWRlp'
  : process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY;
const MIXPANEL_TOKEN = process.env.EXPO_PUBLIC_MIXPANEL_TOKEN;
const AnimatedTouchableOpacity = Animated.createAnimatedComponent(TouchableOpacity);

const starterAlarms: Alarm[] = [
  { id: 'alpha', time: '06:45', task: 'Object Hunt', days: ['0', '1', '2', '3', '4'], sound: DEFAULT_ALARM_SOUND_ID, enabled: true, savage: true, challengeConfig: { type: 'object_hunt', difficulty: 'easy', targetObject: 'Toothbrush' } },
  { id: 'bravo', time: '05:30', task: 'Shake Your Phone', days: ['0', '1', '2', '3', '4'], sound: 'air_raid', enabled: true, savage: false, challengeConfig: { type: 'shake_phone', targetCount: 25 } },
];

function formatClock12Hour(time: string) {
  const [hour, minute] = time.split(':').map(Number);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function formatBillingPeriod(value: number, unit: string) {
  const normalizedUnit = unit.toLowerCase();
  return `${value} ${normalizedUnit}${value === 1 ? '' : 's'}`;
}

function formatDigitalClock(date: Date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s?[AP]M$/i, '');
}

function repeatLabel(days: string[]) {
  if (days.length === 0) return 'One time';
  if (days.length === 7) return 'Every day';
  if (days.length === 5 && ['0', '1', '2', '3', '4'].every((day) => days.includes(day))) return 'Weekdays';
  if (days.length === 2 && days.includes('5') && days.includes('6')) return 'Weekends';
  return days.map((day) => DAYS[Number(day)]).join(' ');
}

function nextAlarmCountdown(alarm: Alarm, now: Date) {
  const [hour, minute] = alarm.time.split(':').map(Number);
  for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + dayOffset);
    candidate.setHours(hour, minute, 0, 0);
    const weekdayIndex = (candidate.getDay() + 6) % 7;
    if (alarm.days.length > 0 && !alarm.days.includes(String(weekdayIndex))) continue;
    const difference = candidate.getTime() - now.getTime();
    if (difference < 0) continue;
    const totalMinutes = Math.floor(difference / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `Next in ${hours}h ${minutes}m`;
  }
  return repeatLabel(alarm.days);
}

function taskLabel(task: Task | null, alarm?: Alarm) {
  const config = alarm?.challengeConfig;
  switch (task) {
    case null: return 'Choose a wake-up challenge';
    case 'Shake Your Phone': return `Shake Your Phone · ${config?.type === 'shake_phone' ? config.targetCount : 25}`;
    case 'Object Hunt': return 'Object Hunt';
    case 'Push-up Challenge': return `Push-up Challenge · ${config?.type === 'push_up' ? config.targetCount : 10} reps`;
    case 'Yell to Stop': return 'Yell to Stop';
  }
}

function challengeConfigurationForAlarm(alarm: Pick<Alarm, 'task' | 'challengeConfig'>): ChallengeConfiguration | undefined {
  const type = challengeTypeForTask(alarm.task);
  if (!type) return undefined;
  const config = alarm.challengeConfig;
  return config?.type === type && isChallengeConfiguration(config)
    ? config
    : defaultChallengeConfiguration(type);
}
function taskIcon(task: Task | null) {
  return TASKS.find((item) => item.task === task)?.icon ?? '!';
}

function ActionButton({
  label,
  onPress,
  secondary = false,
  compact = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  compact?: boolean;
  disabled?: boolean;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  const animateScale = (toValue: number) => {
    Animated.spring(scale, {
      toValue,
      useNativeDriver: true,
      speed: 35,
      bounciness: 7,
    }).start();
  };

  return (
    <AnimatedTouchableOpacity
      accessibilityRole="button"
      onPress={onPress}
      onPressIn={() => animateScale(0.97)}
      onPressOut={() => animateScale(1)}
      disabled={disabled}
      style={[
        styles.actionButton,
        secondary && styles.secondaryButton,
        compact && styles.compactButton,
        disabled && styles.buttonDisabled,
        { transform: [{ scale }] },
      ]}
    >
      <Text style={[styles.actionText, secondary && styles.secondaryText, compact && styles.compactText]}>{label}</Text>
      {!compact && <Text style={[styles.actionArrow, secondary && styles.secondaryText]}>↗</Text>}
    </AnimatedTouchableOpacity>
  );
}

function ObjectHuntCamera({
  target,
  onRecognized,
  onFailedAttempt,
  cameraReadyMessage,
}: {
  target: string;
  onRecognized: (target: string) => void;
  onFailedAttempt: () => void;
  cameraReadyMessage: string;
}) {
  const cameraRef = useRef<CameraView | null>(null);
  const captureInProgress = useRef(false);
  const captureGeneration = useRef(0);
  const scanProgress = useRef(new Animated.Value(0)).current;
  const [cameraReady, setCameraReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [message, setMessage] = useState('');
  const [hasAttempted, setHasAttempted] = useState(false);

  useEffect(() => () => {
    captureGeneration.current += 1;
    captureInProgress.current = false;
  }, []);

  useEffect(() => {
    captureGeneration.current += 1;
    captureInProgress.current = false;
    setCapturing(false);
    setMessage('');
    setHasAttempted(false);
  }, [target]);

  useEffect(() => {
    if (!capturing) {
      scanProgress.stopAnimation();
      scanProgress.setValue(0);
      return undefined;
    }
    const scan = Animated.loop(
      Animated.sequence([
        Animated.timing(scanProgress, { toValue: 1, duration: 1100, useNativeDriver: true }),
        Animated.timing(scanProgress, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    scan.start();
    return () => scan.stop();
  }, [capturing, scanProgress]);

  const capture = useCallback(async () => {
    if (captureInProgress.current) return;
    if (!isNativeAlarmAvailable) {
      setMessage('OBJECT RECOGNITION NEEDS THE WAYYKUP DEVELOPMENT BUILD. EXPO GO IS NOT SUPPORTED.');
      return;
    }
    const camera = cameraRef.current;
    if (!cameraReady || !camera) {
      setMessage('CAMERA IS GETTING READY. TRY AGAIN IN A MOMENT.');
      return;
    }
    captureInProgress.current = true;
    setCapturing(true);
    setMessage('CHECKING OBJECT…');
    const generation = captureGeneration.current;
    try {
      const photo = await camera.takePictureAsync({ quality: 0.7 });
      if (generation !== captureGeneration.current) return;
      setHasAttempted(true);
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let predictions: Awaited<ReturnType<typeof classifyImage>>;
      try {
        predictions = await Promise.race([
          classifyImage(photo.uri, target),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Object recognition timed out.')), 15_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (generation !== captureGeneration.current) return;
      if (matchesHuntObject(target, predictions)) {
        onRecognized(target);
      } else {
        onFailedAttempt();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
          .catch((error: unknown) => console.warn('Object-recognition retry haptic failed:', error));
        setMessage(
          `${target.toUpperCase()} NOT DETECTED. MOVE CLOSER, CENTRE IT, AND RETAKE THE PHOTO.`,
        );
      }
    } catch (error) {
      if (generation !== captureGeneration.current) return;
      console.error('Object Hunt image recognition failed.', error);
      setMessage('WE COULD NOT CHECK THAT PHOTO. CHECK THE LIGHTING AND RETRY.');
    } finally {
      if (generation === captureGeneration.current) {
        captureInProgress.current = false;
        setCapturing(false);
      }
    }
  }, [cameraReady, onFailedAttempt, onRecognized, target]);

  return (
    <>
      <View style={styles.huntViewfinder}>
        <CameraView
          ref={cameraRef}
          style={styles.huntCameraPreview}
          onCameraReady={() => setCameraReady(true)}
        />
        <View pointerEvents="none" style={styles.huntViewfinderOverlay}>
          <View style={[styles.huntCorner, styles.huntCornerTopLeft]} />
          <View style={[styles.huntCorner, styles.huntCornerTopRight]} />
          <View style={[styles.huntCorner, styles.huntCornerBottomLeft]} />
          <View style={[styles.huntCorner, styles.huntCornerBottomRight]} />
          <View style={styles.huntAimGuide}>
            <Text style={styles.huntAimGuideText}>CENTER THE OBJECT</Text>
          </View>
          {capturing && (
            <Animated.View
              style={[
                styles.huntScanLine,
                { transform: [{ translateY: scanProgress.interpolate({ inputRange: [0, 1], outputRange: [8, 184] }) }] },
              ]}
            />
          )}
          <View style={styles.huntCameraStatus}>
            <View style={[styles.huntCameraStatusDot, cameraReady && styles.huntCameraStatusDotReady]} />
            <Text style={styles.huntCameraStatusText}>
              {capturing ? 'IDENTIFYING TARGET' : cameraReady ? 'CAMERA READY' : 'STARTING CAMERA'}
            </Text>
          </View>
        </View>
      </View>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={capturing ? `Identifying the ${target}` : `Scan the ${target}`}
        disabled={!cameraReady || capturing}
        activeOpacity={0.86}
        onPress={() => { void capture(); }}
        style={[styles.huntScanButton, (!cameraReady || capturing) && styles.huntScanButtonDisabled]}
      >
        <Text style={styles.huntScanButtonIcon}>{capturing ? '◌' : '⌕'}</Text>
        <Text style={styles.huntScanButtonText}>
          {capturing ? 'SCANNING OBJECT…' : hasAttempted ? 'RETAKE & SCAN AGAIN' : 'SCAN OBJECT'}
        </Text>
      </TouchableOpacity>
      {!!message && (
        <View style={styles.huntRetryNotice}>
          <Text style={styles.huntRetryIcon}>↻</Text>
          <Text accessibilityLiveRegion="polite" style={styles.huntRetryText}>{message}</Text>
        </View>
      )}
      {!message && !!cameraReadyMessage && (
        <Text accessibilityLiveRegion="polite" style={styles.huntPermissionMessage}>{cameraReadyMessage}</Text>
      )}
    </>
  );
}

function ObjectHuntScreen({
  alarmTime,
  alarmLabel,
  target,
  difficulty,
  recognized,
  permissionGranted,
  permissionMessage,
  onRequestPermission,
  onRecognized,
  onFailedAttempt,
  onReshuffle,
}: {
  alarmTime: string;
  alarmLabel?: string;
  target: string;
  difficulty: string;
  recognized: boolean;
  permissionGranted: boolean;
  permissionMessage: string;
  onRequestPermission: () => void;
  onRecognized: (target: string) => void;
  onFailedAttempt: () => void;
  onReshuffle: () => void;
}) {
  const entrance = useRef(new Animated.Value(0)).current;
  const successScale = useRef(new Animated.Value(0.82)).current;
  const object = HUNT_ITEMS.find((item) => item.name === target);

  useEffect(() => {
    entrance.setValue(0);
    Animated.spring(entrance, {
      toValue: 1,
      damping: 20,
      stiffness: 110,
      mass: 0.8,
      useNativeDriver: true,
    }).start();
  }, [entrance, target]);

  useEffect(() => {
    if (!recognized) {
      successScale.setValue(0.82);
      return;
    }
    Animated.spring(successScale, {
      toValue: 1,
      damping: 11,
      stiffness: 180,
      useNativeDriver: true,
    }).start();
  }, [recognized, successScale]);

  const entranceStyle = {
    opacity: entrance,
    transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
  };

  return (
    <SafeAreaView style={styles.huntScreen}>
      <ScrollView
        contentContainerStyle={styles.huntScreenContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.huntMissionTop}>
          <View style={styles.huntLiveIndicator}>
            <View style={styles.huntLiveDot} />
            <Text style={styles.huntLiveText}>ALARM ACTIVE</Text>
          </View>
          <Text style={styles.huntMissionEyebrow}>WAKE-UP MISSION</Text>
          <Text style={styles.huntMissionTime}>{alarmTime}</Text>
          {!!alarmLabel && <Text style={styles.huntAlarmLabel}>{alarmLabel}</Text>}
          <Text style={styles.huntMissionMessage}>One mission between you and your morning.</Text>
        </View>

        <Animated.View style={[styles.huntChallengeHeading, entranceStyle]}>
          <View style={styles.huntChallengeIcon}>
            <Text style={styles.huntChallengeIconGlyph}>⌕</Text>
          </View>
          <View style={styles.huntChallengeHeadingCopy}>
            <Text style={styles.huntChallengeTitle}>OBJECT HUNT</Text>
            <Text style={styles.huntChallengeSubtitle}>Find it. Scan it. Get moving.</Text>
          </View>
        </Animated.View>

        <Animated.View style={[styles.huntTargetCard, entranceStyle]}>
          <View style={styles.huntTargetVisual}>
            <Text style={styles.huntTargetArtwork}>{object?.image ?? '⌕'}</Text>
            <View style={styles.huntDifficultyPill}>
              <Text style={styles.huntDifficultyText}>{difficulty.toUpperCase()} MISSION</Text>
            </View>
          </View>
          <View style={styles.huntTargetDetails}>
            <Text style={styles.huntTargetEyebrow}>YOUR TARGET</Text>
            <Text style={styles.huntTargetName}>{target.toUpperCase()}</Text>
            <Text style={styles.huntTargetInstructions}>
              Find this item, bring it into view, and scan it to prove you’re up.
            </Text>
            {!recognized && (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Change target object"
                onPress={onReshuffle}
                style={styles.huntChangeTarget}
              >
                <Text style={styles.huntChangeTargetIcon}>↻</Text>
                <Text style={styles.huntChangeTargetText}>CHANGE TARGET</Text>
              </TouchableOpacity>
            )}
          </View>
        </Animated.View>

        <View style={styles.huntScannerSection}>
          <View style={styles.huntScannerHeader}>
            <Text style={styles.huntScannerTitle}>OBJECT SCANNER</Text>
            <Text style={styles.huntScannerStep}>STEP 1 OF 1</Text>
          </View>
          {recognized ? (
            <View
              accessibilityRole="summary"
              accessibilityLabel={`Correct target ${target} recognized. Alarm completion is in progress.`}
              style={styles.huntSuccessCard}
            >
              <Animated.View style={[styles.huntSuccessIcon, { transform: [{ scale: successScale }] }]}>
                <Text style={styles.huntSuccessCheck}>✓</Text>
              </Animated.View>
              <Text style={styles.huntSuccessTitle}>TARGET VERIFIED</Text>
              <Text style={styles.huntSuccessMessage}>{target} confirmed. Your morning starts now.</Text>
            </View>
          ) : permissionGranted ? (
            <ObjectHuntCamera
              target={target}
              cameraReadyMessage={permissionMessage}
              onRecognized={onRecognized}
              onFailedAttempt={onFailedAttempt}
            />
          ) : (
            <View style={styles.huntCameraPlaceholder}>
              <View style={styles.huntPlaceholderIcon}>
                <Text style={styles.huntPlaceholderGlyph}>⌕</Text>
              </View>
              <Text style={styles.huntPlaceholderTitle}>Ready when you are</Text>
              <Text style={styles.huntPlaceholderMessage}>
                Allow camera access to scan and verify your target on this device.
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={onRequestPermission}
                style={styles.huntScanButton}
              >
                <Text style={styles.huntScanButtonIcon}>⌕</Text>
                <Text style={styles.huntScanButtonText}>ENABLE CAMERA</Text>
              </TouchableOpacity>
              {!!permissionMessage && (
                <Text accessibilityLiveRegion="polite" style={styles.huntPermissionMessage}>{permissionMessage}</Text>
              )}
            </View>
          )}
        </View>

        <View style={styles.huntKeepRinging}>
          <View style={styles.huntKeepRingingIcon}>
            <Text style={styles.huntKeepRingingGlyph}>♫</Text>
          </View>
          <Text style={styles.huntKeepRingingText}>Your alarm keeps ringing until your target is verified.</Text>
        </View>
      </ScrollView>
      <StatusBar barStyle="dark-content" />
    </SafeAreaView>
  );
}

function AlarmPhonePreview({ phoneHeight }: { phoneHeight: number }) {
  return (
    <View style={[styles.trialPhone, { width: phoneHeight * 0.53, height: phoneHeight }]}>
      <View style={styles.trialPhoneScreen}>
        <View style={styles.trialClockPanel}>
          <View style={styles.trialStatusBar}>
            <Text style={styles.trialStatusTime}>6:56</Text>
            <Text style={styles.trialStatusIcons}>•••  ◔  ▰</Text>
          </View>
          <View style={styles.trialClockContent}>
            <Text style={styles.trialClockTime}>06:56</Text>
            <Text style={styles.trialClockDate}>Thursday, May 28</Text>
          </View>
        </View>
        <View style={styles.trialChallengePanel}>
          <View style={styles.trialChallengeTopbar}>
            <Text style={styles.trialChallengeBack}>‹</Text>
            <Text style={styles.trialChallengeSound}>◖</Text>
          </View>
          <View style={styles.trialChallengeTarget}>
            <Text style={styles.trialChallengeEmoji}>🚽</Text>
            <Text style={styles.trialChallengeName}>Toilet</Text>
          </View>
          <View style={styles.trialScanFrame}>
            <View style={[styles.trialScanCorner, styles.trialScanTopLeft]} />
            <View style={[styles.trialScanCorner, styles.trialScanTopRight]} />
          </View>
        </View>
      </View>
    </View>
  );
}

function TrialTimelineIcon({ kind }: { kind: 'unlock' | 'bell' | 'trophy' }) {
  return (
    <Svg width={32} height={32} viewBox="0 0 32 32" accessibilityElementsHidden>
      {kind === 'unlock' ? (
        <Path d="M19 11V8a6 6 0 0 0-11.8-1.4M5 13h20v15H5zM15 19v4" fill="none" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      ) : kind === 'bell' ? (
        <Path d="M8 22h16l-2.2-3.1V14a5.8 5.8 0 0 0-11.6 0v4.9L8 22ZM13 25a3 3 0 0 0 6 0" fill="#FFFFFF" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <Path d="M11 5h10v4a5 5 0 0 1-10 0V5ZM11 8H6v2a5 5 0 0 0 6 5M21 8h5v2a5 5 0 0 1-6 5M16 14v8M11 27h10M13 22h6v5h-6z" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </Svg>
  );
}

function GiftIllustration() {
  return (
    <Svg width="100%" height="100%" viewBox="0 0 300 300" accessibilityLabel="A red gift box with a golden bow">
      <Path d="M37 265c46 16 180 16 226-2" fill="none" stroke="#D8DCE7" strokeWidth="5" strokeLinecap="round" />
      <Path d="m45 113 105-61 105 60-105 62z" fill="#F6534C" stroke="#171018" strokeWidth="4" strokeLinejoin="round" />
      <Path d="m45 113 105 61v112L57 229z" fill="#F44740" stroke="#171018" strokeWidth="4" strokeLinejoin="round" />
      <Path d="m150 174 105-62v117l-105 57z" fill="#E83A35" stroke="#171018" strokeWidth="4" strokeLinejoin="round" />
      <Path d="m126 67 28 16v185l-28-15zM175 84l28-16v183l-28 15z" fill="#FFC94A" stroke="#171018" strokeWidth="3" strokeLinejoin="round" />
      <Path d="m47 110 103 59v31L51 140zM150 169l103-59v31l-103 59z" fill="#FFC94A" stroke="#171018" strokeWidth="3" strokeLinejoin="round" />
      <Path d="M148 81c-15-28-43-56-61-40-18 17 10 43 54 57M152 81c16-28 43-56 62-40 18 17-11 43-54 57" fill="#FFC94A" stroke="#171018" strokeWidth="4" strokeLinejoin="round" />
      <Path d="M142 91c-29-12-48-28-52-43M158 91c29-12 48-28 52-43" fill="none" stroke="#FFF0B2" strokeWidth="4" strokeLinecap="round" />
      <Path d="m147 90-35 22 17 5-4 18 28-28M153 90l35 22-17 5 4 18-28-28" fill="#FFC94A" stroke="#171018" strokeWidth="4" strokeLinejoin="round" />
      <Circle cx="150" cy="91" r="13" fill="#F5AE26" stroke="#171018" strokeWidth="4" />
      <Path d="m68 129 30 18M79 204l20 12M221 135l-24 15M220 207l-22 12M119 179l11 6M182 178l-11 7" fill="none" stroke="#FF9380" strokeWidth="3" strokeLinecap="round" />
    </Svg>
  );
}

function AnimatedGiftArtwork({ height }: { height: number }) {
  const [floatMotion] = useState(() => new Animated.Value(0));
  const [revealMotion] = useState(() => new Animated.Value(0));
  const [sparkleMotion] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const reveal = Animated.timing(revealMotion, {
      toValue: 1,
      duration: 650,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    const float = Animated.loop(Animated.sequence([
      Animated.timing(floatMotion, { toValue: 1, duration: 1700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(floatMotion, { toValue: 0, duration: 1700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    const sparkles = Animated.loop(Animated.sequence([
      Animated.timing(sparkleMotion, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(sparkleMotion, { toValue: 0, duration: 1100, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));

    reveal.start();
    float.start();
    sparkles.start();
    return () => {
      reveal.stop();
      float.stop();
      sparkles.stop();
    };
  }, [floatMotion, revealMotion, sparkleMotion]);

  const translateY = floatMotion.interpolate({ inputRange: [0, 1], outputRange: [0, -11] });
  const rotate = floatMotion.interpolate({ inputRange: [0, 0.5, 1], outputRange: ['-1.5deg', '1.5deg', '-1.5deg'] });
  const revealY = revealMotion.interpolate({ inputRange: [0, 1], outputRange: [18, 0] });
  const sparkleOpacity = sparkleMotion.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.35, 1, 0.35] });
  const sparkleScale = sparkleMotion.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.7, 1.15, 0.7] });

  return (
    <View style={[styles.giftArtworkStage, { height }]}>
      <Animated.Text style={[styles.giftSparkle, styles.giftSparkleLeft, { opacity: sparkleOpacity, transform: [{ scale: sparkleScale }] }]}>✦</Animated.Text>
      <Animated.Text style={[styles.giftSparkle, styles.giftSparkleRight, { opacity: sparkleOpacity, transform: [{ scale: sparkleScale }] }]}>✦</Animated.Text>
      <Animated.View style={{ width: '100%', height: '100%', opacity: revealMotion, transform: [{ translateY: Animated.add(translateY, revealY) }, { rotate }] }}>
        <GiftIllustration />
      </Animated.View>
    </View>
  );
}

function AnimatedOfferButton({
  busy,
  onPress,
}: {
  busy: boolean;
  onPress: () => void;
}) {
  const [pulseMotion] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (busy) {
      pulseMotion.stopAnimation();
      pulseMotion.setValue(0);
      return;
    }

    const pulse = Animated.loop(Animated.sequence([
      Animated.timing(pulseMotion, { toValue: 1, duration: 1350, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(pulseMotion, { toValue: 0, duration: 1350, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    pulse.start();
    return () => pulse.stop();
  }, [busy, pulseMotion]);

  const scale = pulseMotion.interpolate({ inputRange: [0, 1], outputRange: [1, 1.018] });

  return (
    <Animated.View style={{ width: '100%', transform: [{ scale }] }}>
      <TouchableOpacity
        accessibilityRole="button"
        disabled={busy}
        onPress={onPress}
        style={[styles.giftOfferClaim, busy && styles.proTrialContinueDisabled]}
      >
        <Text style={styles.giftOfferClaimText}>{busy ? 'Connecting to store…' : 'Claim my special offer'}</Text>
        <Svg width={23} height={23} viewBox="0 0 24 24" accessibilityElementsHidden>
          <Path d="M3 10h18v11H3zM2 6h20v4H2zM12 6v15M12 6H7.5a2.5 2.5 0 1 1 2.2-3.7L12 6Zm0 0h4.5a2.5 2.5 0 1 0-2.2-3.7L12 6Z" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinejoin="round" />
        </Svg>
      </TouchableOpacity>
    </Animated.View>
  );
}

function AlarmToggle({ enabled, onPress, accessibilityLabel, scale = 1 }: { enabled: boolean; onPress: () => void; accessibilityLabel: string; scale?: number }) {
  const position = useRef(new Animated.Value(enabled ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(position, {
      toValue: enabled ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [enabled, position]);

  const translateX = position.interpolate({ inputRange: [0, 1], outputRange: [0, 21 * scale] });

  return (
    <TouchableOpacity
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: enabled }}
      onPress={onPress}
      style={[styles.referenceToggle, enabled && styles.referenceToggleOn, { width: 51 * scale, height: 30 * scale, borderRadius: 16 * scale, paddingHorizontal: 3 * scale, marginLeft: 8 * scale }]}
    >
      <Animated.View style={[styles.referenceToggleThumb, { width: 24 * scale, height: 24 * scale, borderRadius: 12 * scale, transform: [{ translateX }] }]} />
    </TouchableOpacity>
  );
}

function AlarmSwipeAction({
  alarm,
  action,
  width,
  onPress,
}: {
  alarm: Alarm;
  action: 'edit' | 'delete';
  width: number;
  onPress: () => void;
}) {
  const isEdit = action === 'edit';

  return (
    <ReanimatedAnimated.View
      style={[
        styles.alarmSwipeAction,
        isEdit ? styles.alarmSwipeEdit : styles.alarmSwipeDelete,
        { width },
      ]}
    >
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`${isEdit ? 'Edit' : 'Delete'} ${formatClock12Hour(alarm.time)} alarm`}
        onPress={onPress}
        style={styles.alarmSwipeActionButton}
      >
        <Text style={isEdit ? styles.alarmSwipeEditIcon : styles.alarmSwipeDeleteIcon}>
          {isEdit ? '✎' : '×'}
        </Text>
        <Text style={styles.alarmSwipeActionLabel}>{isEdit ? 'Edit' : 'Delete'}</Text>
      </TouchableOpacity>
    </ReanimatedAnimated.View>
  );
}

function AlarmSwipeRow({
  alarm,
  index,
  total,
  layoutScale,
  nextLabel,
  openSwipeId,
  onSwipeOpen,
  onEdit,
  onDelete,
  onToggle,
}: {
  alarm: Alarm;
  index: number;
  total: number;
  layoutScale: number;
  nextLabel: string;
  openSwipeId: { id: string; action: 'edit' | 'delete' } | null;
  onSwipeOpen: (alarmId: string, action: 'edit' | 'delete' | null) => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const actionWidth = 88 * layoutScale;
  const translateX = useSharedValue(0);
  const gestureStartX = useSharedValue(0);

  useEffect(() => {
    const target = openSwipeId?.id === alarm.id
      ? openSwipeId.action === 'edit' ? actionWidth : -actionWidth
      : 0;
    translateX.value = withSpring(target, { damping: 22, stiffness: 220, mass: 0.8 });
  }, [actionWidth, alarm.id, openSwipeId]);

  const finishSwipe = (action: 'edit' | 'delete' | null) => {
    onSwipeOpen(alarm.id, action);
  };
  const pan = Gesture.Pan()
    .activeOffsetX([-18, 18])
    .failOffsetY([-12, 12])
    .onStart(() => {
      gestureStartX.value = translateX.value;
    })
    .onUpdate((event) => {
      // Gesture worklets update this Reanimated shared value on the UI thread.
      // eslint-disable-next-line react-hooks/immutability
      translateX.value = Math.max(
        -actionWidth,
        Math.min(actionWidth, gestureStartX.value + event.translationX),
      );
    })
    .onEnd((event) => {
      const projectedOffset = translateX.value + event.velocityX * 0.12;
      const target = projectedOffset > actionWidth * 0.42
        ? actionWidth
        : projectedOffset < -actionWidth * 0.42
          ? -actionWidth
          : 0;
      // eslint-disable-next-line react-hooks/immutability
      translateX.value = withSpring(target, {
        damping: 22,
        stiffness: 220,
        mass: 0.8,
        velocity: event.velocityX,
      });
      runOnJS(finishSwipe)(target > 0 ? 'edit' : target < 0 ? 'delete' : null);
    });

  const editActionStyle = useAnimatedStyle(() => ({
    width: actionWidth,
    opacity: interpolate(translateX.value, [0, actionWidth], [0, 1], Extrapolation.CLAMP),
  }), [actionWidth]);
  const deleteActionStyle = useAnimatedStyle(() => ({
    width: actionWidth,
    opacity: interpolate(translateX.value, [-actionWidth, 0], [1, 0], Extrapolation.CLAMP),
  }), [actionWidth]);

  return (
    <View
      style={[
        styles.alarmSwipeContainer,
        { minHeight: 96 * layoutScale },
        index < total - 1 && styles.referenceAlarmDivider,
      ]}
    >
      <ReanimatedAnimated.View
        pointerEvents={openSwipeId?.id === alarm.id && openSwipeId.action === 'edit' ? 'auto' : 'none'}
        style={[styles.alarmSwipeActionReveal, styles.alarmSwipeEdit, { left: 0 }, editActionStyle]}
      >
        <AlarmSwipeAction
          alarm={alarm}
          action="edit"
          width={actionWidth}
          onPress={onEdit}
        />
      </ReanimatedAnimated.View>
      <ReanimatedAnimated.View
        pointerEvents={openSwipeId?.id === alarm.id && openSwipeId.action === 'delete' ? 'auto' : 'none'}
        style={[styles.alarmSwipeActionReveal, styles.alarmSwipeDelete, { right: 0 }, deleteActionStyle]}
      >
        <AlarmSwipeAction
          alarm={alarm}
          action="delete"
          width={actionWidth}
          onPress={onDelete}
        />
      </ReanimatedAnimated.View>
      <GestureDetector gesture={pan}>
        <ReanimatedAnimated.View
          style={[
            styles.referenceAlarmRow,
            {
              minHeight: 96 * layoutScale,
              opacity: alarm.enabled ? 1 : 0.86,
              transform: [{ translateX }],
            },
          ]}
        >
        <TouchableOpacity
          activeOpacity={0.75}
          onPress={onEdit}
          style={[styles.referenceAlarmDetails, { paddingVertical: 12 * layoutScale }]}
        >
          <Text style={[styles.referenceAlarmTime, { fontSize: 37 * layoutScale, lineHeight: 40 * layoutScale }]}>
            {formatClock12Hour(alarm.time)}
          </Text>
          <View style={[styles.referenceAlarmMeta, { gap: 7 * layoutScale, marginTop: 3 * layoutScale }]}>
            <View style={[styles.referenceTaskChip, { minHeight: 30 * layoutScale, gap: 6 * layoutScale, paddingHorizontal: 9 * layoutScale }]}>
              <Text style={[styles.referenceTaskIcon, { fontSize: 15 * layoutScale }]}>{taskIcon(alarm.task)}</Text>
              <Text style={[styles.referenceTaskLabel, { fontSize: 14 * layoutScale }]}>
                {taskLabel(alarm.task, alarm)}
              </Text>
            </View>
            <Text style={[styles.referenceMetaDot, { fontSize: 15 * layoutScale }]}>·</Text>
            <Text numberOfLines={1} style={[styles.referenceMetaText, { fontSize: 14 * layoutScale }]}>
              {alarm.enabled ? nextLabel : 'Off'}
            </Text>
          </View>
        </TouchableOpacity>
        <AlarmToggle
          accessibilityLabel={`${alarm.enabled ? 'Disable' : 'Enable'} ${formatClock12Hour(alarm.time)} alarm`}
          enabled={alarm.enabled}
          scale={layoutScale}
          onPress={onToggle}
        />
        </ReanimatedAnimated.View>
      </GestureDetector>
    </View>
  );
}

function Tag({ children, dark = false }: { children: string; dark?: boolean }) {
  return (
    <View style={[styles.tag, dark && styles.darkTag]}>
      <Text style={[styles.tagText, dark && styles.darkTagText]}>{children}</Text>
    </View>
  );
}

function WheelColumn({
  values,
  selectedIndex,
  onChange,
  label,
}: {
  values: string[];
  selectedIndex: number;
  onChange: (index: number) => void;
  label: string;
}) {
  const wheelRef = useRef<ScrollViewInstance>(null);
  const rowHeight = 42;
  const padding = rowHeight * 2;

  useEffect(() => {
    wheelRef.current?.scrollTo({ y: selectedIndex * rowHeight, animated: false });
  }, [selectedIndex, values.length]);

  return (
    <View accessibilityLabel={label} style={styles.wheelColumn}>
      <ScrollView
        ref={wheelRef}
        showsVerticalScrollIndicator={false}
        snapToInterval={rowHeight}
        decelerationRate="fast"
        contentContainerStyle={{ paddingVertical: padding }}
        onMomentumScrollEnd={(event) => {
          const index = Math.max(0, Math.min(values.length - 1, Math.round(event.nativeEvent.contentOffset.y / rowHeight)));
          if (index !== selectedIndex) onChange(index);
        }}
        onScrollEndDrag={(event) => {
          const index = Math.max(0, Math.min(values.length - 1, Math.round(event.nativeEvent.contentOffset.y / rowHeight)));
          if (index !== selectedIndex) onChange(index);
        }}
      >
        {values.map((value, index) => (
          <TouchableOpacity
            key={`${value}-${index}`}
            activeOpacity={1}
            onPress={() => {
              onChange(index);
              wheelRef.current?.scrollTo({ y: index * rowHeight, animated: true });
            }}
            style={styles.wheelRow}
          >
            <Text style={[styles.wheelText, index === selectedIndex && styles.wheelTextSelected]}>{value}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function App() {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const availableHeight = Math.max(0, windowHeight - insets.top - insets.bottom);
  const compactViewport = availableHeight < 700 || windowWidth < 360;
  const trialPhoneHeight = Math.min(
    490,
    availableHeight * (compactViewport ? 0.47 : 0.58),
    (windowWidth - 48) * 0.76 / 0.53,
  );
  const [screen, setScreen] = useState<Screen>('welcome');
  const [navIndicatorPosition] = useState(() => new Animated.Value(0));
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo | null>(null);
  const [startupProgressLoaded, setStartupProgressLoaded] = useState(false);
  const [startupProgressError, setStartupProgressError] = useState('');
  const [progressRetryCount, setProgressRetryCount] = useState(0);
  const [localAppUnlocked, setLocalAppUnlocked] = useState(false);
  const [billingStatus, setBillingStatus] = useState<'loading' | 'ready' | 'error'>(
    Platform.OS === 'web' ? 'ready' : REVENUECAT_API_KEY ? 'loading' : 'error',
  );
  const [billingRetryCount, setBillingRetryCount] = useState(0);
  const [alarms, setAlarms] = useState(starterAlarms);
  const [alarmsLoaded, setAlarmsLoaded] = useState(false);
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [streakFreezes, setStreakFreezes] = useState<StreakFreeze[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [morningRating, setMorningRatingState] = useState<1 | 2 | 3 | 4 | 5 | null>(null);
  const [celebration, setCelebration] = useState<{
    occurrenceId: string;
    streak: number;
    wakeDurationMs: number;
    previousWakeDurationMs: number | null;
  } | null>(null);
  const [notificationsAllowed, setNotificationsAllowed] = useState(false);
  const [alarmHealth, setAlarmHealth] = useState<AlarmHealth | null>(null);
  const [keepAlarmPlayingDuringChallenges, setKeepAlarmPlayingDuringChallenges] = useState<boolean | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [openAlarmSwipeId, setOpenAlarmSwipeId] = useState<{ id: string; action: 'edit' | 'delete' } | null>(null);
  const [expandedEditorSection, setExpandedEditorSection] = useState<'sound' | 'task' | null>(null);
  const [challengePreviewing, setChallengePreviewing] = useState(false);
  const [alarmFallbackReason, setAlarmFallbackReason] = useState<string | null>(null);
  const [paywallStage, setPaywallStage] = useState<PaywallStage>('intro');
  const [draft, setDraft] = useState<Alarm>({
    id: '',
    time: '07:00',
    task: 'Shake Your Phone',
    days: ['0', '1', '2', '3', '4'],
    sound: DEFAULT_ALARM_SOUND_ID,
    enabled: true,
    savage: false,
    challengeConfig: defaultChallengeConfiguration('shake_phone'),
  });
  const [now, setNow] = useState(() => new Date());
  const [wrongAnswers, setWrongAnswers] = useState(0);
  const [shakeCount, setShakeCount] = useState(0);
  const [sensorAvailable, setSensorAvailable] = useState(true);
  const [huntRecognized, setHuntRecognized] = useState(false);
  const [huntRecognitionMessage, setHuntRecognitionMessage] = useState('');
  const [previewingSound, setPreviewingSound] = useState<string | null>(null);
  const [snoozeLevels, setSnoozeLevels] = useState<Record<string, number>>({});
  const [challengeDurationSeconds, setChallengeDurationSeconds] = useState(0);
  const [availablePackages, setAvailablePackages] = useState<Parameters<typeof Purchases.purchasePackage>[0][]>([]);
  const [currentOffering, setCurrentOffering] = useState<PurchasesOffering | null>(null);
  const [annualIntroEligible, setAnnualIntroEligible] = useState(false);
  const [billingError, setBillingError] = useState(
    Platform.OS !== 'web' && !REVENUECAT_API_KEY ? 'Subscriptions are not configured for this build.' : '',
  );
  const [billingBusy, setBillingBusy] = useState(false);
  const [hasPremium, setHasPremium] = useState(false);
  const [plan, setPlan] = useState<'yearly' | 'monthly'>('yearly');
  const [plansModalVisible, setPlansModalVisible] = useState(false);
  const [currentPlanModalVisible, setCurrentPlanModalVisible] = useState(false);
  const [lastAlarm, setLastAlarm] = useState<ActiveAlarm>(starterAlarms[0] as ActiveAlarm);
  const snoozeLevel = snoozeLevels[lastAlarm.id] ?? 0;
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const alarmPlayer = useAudioPlayer(alarmSoundAsset(DEFAULT_ALARM_SOUND_ID));
  const soundPreviewPlayer = useAudioPlayer(alarmSoundAsset(DEFAULT_ALARM_SOUND_ID));
  const soundPreviewTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shakeDetectorState = useRef(createShakeState());
  const challengeCompleted = useRef(false);
  const challengeTransitionInProgress = useRef(false);
  const pendingChallengeResume = useRef<string | null>(null);
  const challengeStartedAt = useRef(0);
  const activeChallengeAlarmId = useRef<string | null>(null);
  const activeOccurrenceId = useRef<string | null>(null);
  const activeRingStartedAt = useRef(0);
  const startChallengeRef = useRef<(alarm?: Alarm, occurrenceId?: string | null, firstRingAt?: number, entryScreen?: 'ringing' | 'alarm') => void>(() => {});
  const alarmSessionState = useRef<{ occurrenceId: string | null; state: AlarmLifecycleState }>({
    occurrenceId: null,
    state: 'scheduled',
  });
  const alarmsRef = useRef(alarms);
  const pendingNotificationAlarmId = useRef<{ alarmId: string; occurrenceId: string } | null>(null);
  const lastNotificationResponse = useRef<{ id: string; receivedAt: number } | null>(null);
  const revenueCatConfigured = useRef(false);
  const premiumEntitlementRef = useRef(false);
  const screenEntrance = useRef(new Animated.Value(0)).current;
  const sheetTranslation = useRef(new Animated.Value(900)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const addButtonScale = useRef(new Animated.Value(1)).current;
  const ringingSwipeX = useSharedValue(0);

  const refreshStats = useCallback(async (showLoading = false) => {
    if (showLoading) setStatsLoading(true);
    setStatsError(null);
    if (Platform.OS === 'web') {
      setOccurrences([]);
      setStreakFreezes([]);
      setStatsLoading(false);
      return;
    }
    try {
      const [savedOccurrences, savedFreezes] = await Promise.all([getOccurrences(), getStreakFreezes()]);
      setOccurrences(savedOccurrences);
      setStreakFreezes(savedFreezes);
    } catch (error) {
      console.error('Local alarm stats could not be loaded.', error);
      setStatsError('Your local wake-up records could not be loaded.');
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const refreshAlarmHealth = useCallback(async () => {
    try {
      const health = await getAlarmHealth();
      setAlarmHealth(health);
      setNotificationsAllowed(health.canRingNow);
      return health;
    } catch (error) {
      console.error('Native alarm health could not be checked.', error);
      setAlarmHealth(null);
      setNotificationsAllowed(false);
      return null;
    }
  }, []);

  useEffect(() => {
    screenEntrance.setValue(0);
    Animated.spring(screenEntrance, {
      toValue: 1,
      useNativeDriver: true,
      speed: 18,
      bounciness: 3,
    }).start();
  }, [screen, screenEntrance]);

  useEffect(() => {
    if (screen !== 'editor') return;
    sheetTranslation.setValue(900);
    backdropOpacity.setValue(0);
    Animated.parallel([
      Animated.spring(sheetTranslation, {
        toValue: 0,
        useNativeDriver: true,
        speed: 16,
        bounciness: 5,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 1,
        duration: 240,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  }, [screen, sheetTranslation, backdropOpacity]);

  useEffect(() => {
    alarmsRef.current = alarms;
  }, [alarms]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    void refreshStats(true);
    void refreshAlarmHealth();
    if (Platform.OS === 'web') return;
    reconcileOccurrences()
      .then(() => refreshStats())
      .catch((error: unknown) => {
        console.error('Alarm history reconciliation failed on launch.', error);
        setStatsError('Alarm history could not be reconciled.');
      });
  }, [refreshAlarmHealth, refreshStats]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    registerOccurrenceReconciliationTask().catch((error: unknown) => {
      console.error('Background alarm reconciliation could not be registered.', error);
    });
  }, []);

  useEffect(() => {
    if (!alarmsLoaded || Platform.OS === 'web') return;
    const updateSchedule = async () => {
      try {
        if (alarmHealth?.canSchedule) {
          await syncAlarmNotifications(alarms);
        } else {
          await materializeOccurrences(alarmsWithSelectedChallenges(alarms));
        }
        await refreshStats();
      } catch (error) {
        console.error('Alarm schedule and occurrence history could not be synchronized.', error);
        setStatsError('Alarm history could not be synchronized.');
        if (alarmHealth?.canSchedule) {
          Alert.alert(
            'Alarm scheduling failed',
            error instanceof Error ? error.message : 'Your alarm changes were saved, but the operating system did not accept the notification schedule.',
          );
        }
      }
    };
    void updateSchedule();
  }, [alarmHealth, alarms, alarmsLoaded, refreshStats]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => { if (active) setReduceMotion(enabled); })
      .catch((error: unknown) => console.error('Reduce Motion setting could not be read.', error));
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void refreshAlarmHealth().then((health) => {
        if (Platform.OS !== 'ios' || !health?.canSchedule) return;
        return syncAlarmNotifications(alarmsRef.current).catch((error: unknown) => {
          console.error('iOS alarms could not be refreshed after returning to Wayykup.', error);
          Alert.alert('Alarm refresh failed', 'Your saved alarms could not be rescheduled. Review alarm permissions and try again.');
        });
      });
      reconcileOccurrences()
        .then(() => materializeOccurrences(alarmsWithSelectedChallenges(alarmsRef.current)))
        .then(() => refreshStats())
        .catch((error: unknown) => {
          console.error('Alarm history reconciliation failed on foreground.', error);
          setStatsError('Alarm history could not be reconciled.');
        });
    });
    return () => subscription.remove();
  }, [refreshAlarmHealth, refreshStats]);

  useEffect(() => {
    let active = true;
    loadAlarms()
      .then((savedAlarms) => {
        if (active && savedAlarms) {
          setAlarms(savedAlarms);
          if (savedAlarms.some((alarm) => alarm.task === null)) {
            Alert.alert(
              'Choose a new wake-up challenge',
              'Some saved alarms used retired challenges. Their times, repeat schedules, sounds, and labels are preserved; edit each flagged alarm and choose one of the four current challenges before it can ring.',
            );
          }
        }
      })
      .catch((error: unknown) => {
        console.error('Unable to load saved alarms.', error);
        Alert.alert('Alarm data unavailable', 'Saved alarms could not be loaded. Your current alarms are still available for this session.');
      })
      .finally(() => {
        if (active) setAlarmsLoaded(true);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    loadAppProgress()
      .then(async (progress) => {
        if (!active) return;
        if (premiumEntitlementRef.current) {
          const premiumProgress = { onboardingComplete: true, appUnlocked: true };
          await persistAppProgress(premiumProgress);
          setLocalAppUnlocked(true);
          setScreen('home');
          return;
        }
        setLocalAppUnlocked(progress?.appUnlocked ?? false);
        if (progress?.onboardingComplete) {
          setPaywallStage('intro');
          setScreen(premiumEntitlementRef.current || progress.appUnlocked ? 'home' : 'paywall');
          return;
        }

        if (progress === null) {
          const savedAlarms = await loadAlarms();
          const completedOnboardingAlarm = savedAlarms?.some((alarm) => alarm.id.startsWith('onboarding-')) ?? false;
          if (!active) return;
          if (!completedOnboardingAlarm) {
            setLocalAppUnlocked(false);
            return;
          }

          const migratedProgress = { onboardingComplete: true, appUnlocked: false };
          await persistAppProgress(migratedProgress);
          setLocalAppUnlocked(false);
          setPaywallStage('intro');
          setScreen('paywall');
          return;
        }
      })
      .catch((error: unknown) => {
        console.error('Unable to restore app progress.', error);
        if (active) setStartupProgressError('Wayykup could not restore your saved setup. Your existing alarm data has not been changed.');
      })
      .finally(() => {
        if (active) setStartupProgressLoaded(true);
      });
    return () => { active = false; };
  }, [progressRetryCount]);

  useEffect(() => {
    if (!alarmsLoaded) return;
    persistAlarms(alarms).catch((error: unknown) => {
      console.error('Unable to save alarms.', error);
      Alert.alert('Could not save alarm', 'Changes could not be saved to this device.');
    });
  }, [alarms, alarmsLoaded]);

  useEffect(() => {
    loadKeepAlarmPlayingPreference()
      .then((preference) => {
        if (preference !== null) setKeepAlarmPlayingDuringChallenges(preference);
      })
      .catch((error: unknown) => {
        console.error('Unable to load alarm playback preference.', error);
        Alert.alert('Alarm preference unavailable', 'The saved alarm playback choice could not be loaded.');
      });
  }, []);

  useEffect(() => {
    if (screen !== 'settings' || Platform.OS === 'web') return;
    Notifications.getPermissionsAsync()
      .then((permission) => setNotificationsAllowed(permission.granted))
      .catch((error: unknown) => {
        console.error('Notification permission status could not be refreshed in Settings.', error);
      });
  }, [screen]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    Notifications.getPermissionsAsync()
      .then((permission) => setNotificationsAllowed(permission.granted))
      .catch((error: unknown) => {
        console.error('Notification permission status could not be read.', error);
      });
  }, []);

  useEffect(() => {
    initializeAnalytics(MIXPANEL_TOKEN).catch((error: unknown) => {
      console.error('Mixpanel could not be initialized.', error);
    });
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web' || !REVENUECAT_API_KEY) return;
    let active = true;
    void Promise.resolve()
      .then(async () => {
        if (!revenueCatConfigured.current) {
          await Purchases.setLogLevel(Purchases.LOG_LEVEL.DEBUG);
          Purchases.configure({ apiKey: REVENUECAT_API_KEY });
          revenueCatConfigured.current = true;
        }
        return Promise.allSettled([Purchases.getOfferings(), Purchases.getCustomerInfo()]);
      })
      .then(async ([offeringsResult, customerInfoResult]) => {
        if (!active) return;
        if (customerInfoResult.status === 'rejected') throw customerInfoResult.reason;
        const customerInfo = customerInfoResult.value;
        setCustomerInfo(customerInfo);
        const isPremium = Boolean(customerInfo.entitlements.active.wayykup_premium);
        premiumEntitlementRef.current = isPremium;
        setHasPremium(isPremium);

        if (offeringsResult.status === 'rejected') {
          console.error('😿 RevenueCat could not load subscription offerings.', offeringsResult.reason);
          setCurrentOffering(null);
          setAvailablePackages([]);
          setAnnualIntroEligible(false);
          setBillingError('Plans could not load. Check your connection and try again.');
          setBillingStatus(isPremium ? 'ready' : 'error');
          if (isPremium) {
            setScreen((current) => ['welcome', 'proof', 'paywall'].includes(current) ? 'home' : current);
            setLocalAppUnlocked(true);
            void persistAppProgress({ onboardingComplete: true, appUnlocked: true }).catch((error: unknown) => {
              console.error('Premium app access could not be saved.', error);
            });
          }
          return;
        }

        const offering = offeringsResult.value.current;
        const annualPackage = offering?.annual ?? null;
        const monthlyPackage = offering?.monthly ?? null;
        setCurrentOffering(offering);
        setAvailablePackages(offering?.availablePackages ?? []);
        console.info(
          '🍎 RevenueCat current offering:',
          offering?.identifier ?? 'none',
          'monthly:',
          monthlyPackage?.product.identifier ?? 'missing',
          'annual:',
          annualPackage?.product.identifier ?? 'missing',
        );

        let introEligible = false;
        if (Platform.OS === 'ios' && annualPackage?.product.introPrice) {
          try {
            const eligibility = await Purchases.checkTrialOrIntroductoryPriceEligibility([
              'wayykup_pro_annual',
            ]);
            introEligible = eligibility.wayykup_pro_annual?.status
              === Purchases.INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE;
            console.info('🍎 RevenueCat annual introductory offer eligible:', introEligible);
          } catch (error) {
            console.error('😿 RevenueCat introductory-price eligibility could not be checked.', error);
          }
        }
        if (!active) return;
        setAnnualIntroEligible(introEligible);

        const plansLoaded = Boolean(offering && annualPackage && monthlyPackage);
        if (plansLoaded) {
          setBillingError('');
        } else {
          console.error('😿 RevenueCat current offering is missing an annual or monthly package.');
          setBillingError('Plans could not load. Please retry or restore your purchase.');
        }
        setBillingStatus(isPremium || plansLoaded ? 'ready' : 'error');
        if (isPremium) {
          setScreen((current) => ['welcome', 'proof', 'paywall'].includes(current) ? 'home' : current);
          const premiumProgress = { onboardingComplete: true, appUnlocked: true };
          setLocalAppUnlocked(true);
          void persistAppProgress(premiumProgress).catch((error: unknown) => {
            console.error('Premium app access could not be saved.', error);
          });
        } else {
          void loadAppProgress()
            .then((progress) => {
              if (!active || !progress?.appUnlocked) return;
              const lockedProgress = { ...progress, appUnlocked: false };
              setLocalAppUnlocked(false);
              return persistAppProgress(lockedProgress);
            })
            .catch((error: unknown) => {
              console.error('Expired app access could not be updated.', error);
            });
        }
      })
      .catch((error: unknown) => {
        console.error('😿 RevenueCat could not resolve offerings or subscription entitlement.', error);
        if (active) {
          setBillingStatus('error');
          setBillingError('Wayykup could not verify your subscription. Check your connection and try again.');
        }
      });
    return () => { active = false; };
  }, [billingRetryCount]);

  useEffect(() => {
    if (screen !== 'alarm' && screen !== 'ringing' && screen !== 'paywall') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [screen]);

  useEffect(() => {
    if (screen !== 'alarm' && screen !== 'ringing') return;
    const nativeOwnsAlarmAudio = Platform.OS === 'android'
      || (Platform.OS === 'ios' && alarmHealth?.reliability === 'native');
    if (activeOccurrenceId.current && isNativeAlarmAvailable && nativeOwnsAlarmAudio) {
      alarmPlayer.pause();
      alarmPlayer.clearLockScreenControls();
      return;
    }
    if (!activeOccurrenceId.current && keepAlarmPlayingDuringChallenges === false) {
      alarmPlayer.pause();
      alarmPlayer.clearLockScreenControls();
      return;
    }
    let active = true;
    setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'doNotMix',
      shouldPlayInBackground: true,
    })
      .then(() => {
        if (!active) return;
        alarmPlayer.replace(alarmSoundAsset(lastAlarm.sound));
        alarmPlayer.loop = true;
        alarmPlayer.volume = Math.min(1, 0.55 + (wrongAnswers + snoozeLevel) * 0.1);
        alarmPlayer.setActiveForLockScreen(
          true,
          { title: 'WAYYKUP', artist: alarmSoundName(lastAlarm.sound) },
          { showSeekForward: false, showSeekBackward: false, showNextTrack: false, showPreviousTrack: false },
        );
        alarmPlayer.play();
      })
      .catch((error: unknown) => {
        console.error('Alarm audio could not start.', error);
        Alert.alert('Alarm audio unavailable', 'The alarm sound could not be started on this device.');
      });
    return () => {
      active = false;
      alarmPlayer.pause();
      alarmPlayer.clearLockScreenControls();
    };
  }, [
    alarmHealth?.reliability,
    alarmPlayer,
    keepAlarmPlayingDuringChallenges,
    lastAlarm.sound,
    lastAlarm.task,
    screen,
  ]);

  useEffect(() => {
    if (screen !== 'alarm') return;
    if (lastAlarm.task === 'Yell to Stop') return;
    alarmPlayer.volume = Math.min(1, 0.55 + (wrongAnswers + snoozeLevel) * 0.1);
  }, [alarmPlayer, lastAlarm.task, screen, snoozeLevel, wrongAnswers]);

  useEffect(() => {
    if (screen === 'editor') return;
    if (soundPreviewTimeout.current) clearTimeout(soundPreviewTimeout.current);
    soundPreviewTimeout.current = null;
    soundPreviewPlayer.pause();
  }, [screen, soundPreviewPlayer]);

  const nextAlarm = useMemo(
    () => alarms.find((alarm) => alarm.enabled && alarm.task !== null && alarm.challengeConfig) ?? null,
    [alarms],
  );

  useEffect(() => {
    if (screen !== 'alarm' || lastAlarm.task !== 'Shake Your Phone') return;
    shakeDetectorState.current = createShakeState();
    setShakeCount(0);
    let active = true;
    let sensorSubscription: { remove: () => void } | undefined;
    const targetCount = lastAlarm.challengeConfig.type === 'shake_phone'
      ? lastAlarm.challengeConfig.targetCount
      : 25;
    Accelerometer.isAvailableAsync()
      .then((available) => {
        if (!active) return;
        setSensorAvailable(available);
        if (!available) return;
        Accelerometer.setUpdateInterval(100);
        const subscription = Accelerometer.addListener(({ x, y, z }) => {
          const previousCount = shakeDetectorState.current.count;
          shakeDetectorState.current = updateShakeState(
           shakeDetectorState.current,
           { x, y, z },
           Date.now(),
           targetCount,
          );
          if (shakeDetectorState.current.count > previousCount) {
           setShakeCount(shakeDetectorState.current.count);
           if ([0.25, 0.5, 0.75, 1].some((milestone) =>
             previousCount < Math.ceil(targetCount * milestone)
             && shakeDetectorState.current.count >= Math.ceil(targetCount * milestone))) {
             void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
               .catch((error: unknown) => console.warn('Shake challenge milestone haptic failed.', error));
           }
          }
        });
        sensorSubscription = subscription;
      })
      .catch((error: unknown) => {
        console.error('Accelerometer could not be started.', error);
        setSensorAvailable(false);
      });
    return () => {
      active = false;
      sensorSubscription?.remove();
    };
  }, [lastAlarm.challengeConfig, lastAlarm.task, screen]);

  const beginAlarmTest = async () => {
    if (!isNativeAlarmAvailable) {
      Alert.alert(
        'Development build required',
        'Wayykup alarms use native Android/iOS alarm services and cannot be tested in Expo Go. Build and install the Wayykup development client first.',
      );
      return;
    }
    try {
      const health = await refreshAlarmHealth();
      if (!health?.canSchedule) {
        Alert.alert(
          'Alarm permissions needed',
          'Allow Wayykup to schedule exact alarms first. Use the alarm health panel to open the required system setting.',
        );
        return;
      }
      await startTestAlarm();
      Alert.alert(
        '60-second test scheduled',
        'The native alarm will ring in 60 seconds. Use this optional test to verify alarm sound and challenge launch on this device.',
      );
    } catch (error) {
      console.error('The 60-second native alarm test could not be scheduled.', error);
      Alert.alert('Test alarm unavailable', error instanceof Error ? error.message : 'Wayykup could not schedule the native ring test.');
    }
  };

  const openNewAlarm = () => {
    setOpenAlarmSwipeId(null);
    setPreviewingSound(null);
    setEditingId(null);
    setDraft({
      id: '',
      time: '07:00',
      task: 'Shake Your Phone',
      days: ['0', '1', '2', '3', '4'],
      sound: DEFAULT_ALARM_SOUND_ID,
      enabled: true,
      savage: false,
      challengeConfig: defaultChallengeConfiguration('shake_phone'),
    });
    setChallengePreviewing(false);
    setExpandedEditorSection(null);
    setScreen('editor');
  };

  const openEditAlarm = (alarm: Alarm) => {
    setOpenAlarmSwipeId(null);
    setPreviewingSound(null);
    setEditingId(alarm.id);
    setDraft({ ...alarm });
    setExpandedEditorSection(null);
    setScreen('editor');
  };

  const handleAlarmSwipeOpen = useCallback((alarmId: string, action: 'edit' | 'delete' | null) => {
    setOpenAlarmSwipeId(action ? { id: alarmId, action } : null);
  }, []);

  const deleteAlarm = (alarm: Alarm) => {
    setOpenAlarmSwipeId(null);
    setAlarms((current) => current.filter((item) => item.id !== alarm.id));
  };

  const dismissEditor = (nextScreen: Screen = 'home') => {
    Animated.parallel([
      Animated.timing(sheetTranslation, {
        toValue: 900,
        duration: 240,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 200,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) setScreen(nextScreen);
    });
  };

  const saveAlarm = async () => {
    if (!draft.task) {
      Alert.alert(
        'Choose a wake-up challenge',
        'Select one of the four supported challenges before saving this alarm.',
      );
      setExpandedEditorSection('task');
      return;
    }
    const config = challengeConfigurationForAlarm(draft);
    if (!config) throw new Error(`Missing challenge configuration for ${draft.task}.`);
    const savedDraft = { ...draft, challengeConfig: config };
    if (editingId) {
      setAlarms((current) => current.map((alarm) => (alarm.id === editingId ? savedDraft : alarm)));
      trackEvent('alarm_updated', { task: draft.task, time: draft.time });
    } else {
      setAlarms((current) => [...current, { ...savedDraft, id: Date.now().toString() }]);
      trackEvent('alarm_created', { task: draft.task, time: draft.time });
    }
    try {
      await requestAlarmNotifications();
      const health = await refreshAlarmHealth();
      if (!health?.canSchedule) {
        Alert.alert(
          'Alarm permissions incomplete',
          'Your alarm details were saved, but Wayykup cannot schedule the ring until exact-alarm access is enabled.',
        );
      } else if (!health.canRingNow) {
        Alert.alert(
          'Alarm scheduled with limited access',
          'The alarm is scheduled to ring, but allow notifications and full-screen alarm access so its challenge can appear over the lock screen.',
        );
      }
    } catch (error) {
      console.error('Native alarm permission request failed.', error);
      Alert.alert('Alarm permissions unavailable', 'The alarm details were saved, but required native alarm access could not be checked.');
    }
    dismissEditor();
  };

  const startChallenge = (
    alarm = nextAlarm,
    occurrenceId: string | null = null,
    firstRingAt = Date.now(),
    entryScreen: 'ringing' | 'alarm' = 'ringing',
  ) => {
    if (!alarm) {
      Alert.alert('No active alarm', 'Create or enable an alarm before starting a wake-up drill.');
      return;
    }
    if (!alarm.task) {
      Alert.alert(
        'Choose a wake-up challenge',
        'This saved alarm needs one of the four supported challenges before it can ring.',
        [{
          text: 'CHOOSE A CHALLENGE',
          onPress: () => {
            setExpandedEditorSection('task');
            openEditAlarm(alarm);
          },
        }],
      );
      return;
    }
    const challengeConfig = challengeConfigurationForAlarm(alarm);
    if (!challengeConfig) throw new Error(`Missing challenge configuration for ${alarm.task}.`);
    const runtimeAlarm: ActiveAlarm = { ...alarm, task: alarm.task, challengeConfig };
    setLastAlarm(runtimeAlarm);
    const sameOccurrence = occurrenceId !== null && activeOccurrenceId.current === occurrenceId;
    activeChallengeAlarmId.current = runtimeAlarm.id;
    activeOccurrenceId.current = occurrenceId;
    let lifecycleState = transitionAlarmState('scheduled', 'ringing');
    if (entryScreen === 'alarm') {
      lifecycleState = transitionAlarmState(lifecycleState, 'challenge_pending');
      lifecycleState = transitionAlarmState(lifecycleState, 'challenge_active');
    }
    alarmSessionState.current = { occurrenceId, state: lifecycleState };
    challengeTransitionInProgress.current = false;
    ringingSwipeX.value = 0;
    if (!sameOccurrence) activeRingStartedAt.current = firstRingAt;
    setWrongAnswers(0);
    setShakeCount(0);
    setHuntRecognitionMessage('');
    setHuntRecognized(false);
    setAlarmFallbackReason(null);
    setChallengePreviewing(false);
    challengeCompleted.current = false;
    challengeStartedAt.current = Date.now();
    setScreen(entryScreen);
  };

  startChallengeRef.current = startChallenge;

  const handleNativeRing = useCallback((event: RingStartedEvent) => {
    void refreshStats();
    trackEvent('alarm_ring_started', {
      alarm_id: event.alarmId,
      occurrence_id: event.occurrenceId,
      scheduled_at: event.scheduledAt,
      ring_started_at: event.at,
      ring_latency_ms: Math.max(0, event.at - event.scheduledAt),
      device_model: alarmHealth?.deviceModel ?? 'unknown',
    });
    const savedAlarm = alarmsRef.current.find((item) => item.id === event.alarmId);
    const testTask = TASKS.find((option) => option.task === event.challenge)?.task ?? 'Shake Your Phone';
    const testChallengeType = challengeTypeForTask(testTask);
    const testTime = new Date(event.scheduledAt);
    const alarm: Alarm | null = savedAlarm ?? (event.testAlarm ? {
      id: event.alarmId,
      time: `${String(testTime.getHours()).padStart(2, '0')}:${String(testTime.getMinutes()).padStart(2, '0')}`,
      task: testTask,
      days: [],
      sound: migrateAlarmSoundId(event.sound),
      enabled: true,
      savage: false,
      challengeConfig: defaultChallengeConfiguration(testChallengeType ?? 'shake_phone'),
    } : null);
    if (!alarm) {
      pendingNotificationAlarmId.current = { alarmId: event.alarmId, occurrenceId: event.occurrenceId };
      return;
    }
    if (
      activeChallengeAlarmId.current === event.alarmId
      && activeOccurrenceId.current === event.occurrenceId
    ) return;
    if (event.state === 'challenge_pending' && isNativeAlarmAvailable) {
      if (pendingChallengeResume.current === event.occurrenceId) return;
      pendingChallengeResume.current = event.occurrenceId;
      void activateNativeChallenge(event.alarmId, event.occurrenceId)
        .then(() => {
          startChallengeRef.current(alarm, event.occurrenceId, event.at, 'alarm');
        })
        .catch((error: unknown) => {
          console.error('A pending wake-up challenge could not be restored.', error);
          Alert.alert('Challenge unavailable', 'Wayykup could not restore the active challenge. The alarm is still ringing.');
        })
        .finally(() => {
          pendingChallengeResume.current = null;
        });
      return;
    }
    startChallengeRef.current(
      alarm,
      event.occurrenceId,
      event.at,
      event.state === 'challenge_active' ? 'alarm' : 'ringing',
    );
  }, [refreshStats]);

  const activateChallengeAfterSwipe = useCallback(async () => {
    if (screen !== 'ringing' || challengeTransitionInProgress.current || challengeCompleted.current) return;
    challengeTransitionInProgress.current = true;
    const occurrenceId = activeOccurrenceId.current;
    try {
      const session = alarmSessionState.current;
      if (session.occurrenceId !== occurrenceId) {
        throw new Error('The active alarm occurrence changed before the challenge started.');
      }
      if (session.state === 'ringing') {
        session.state = transitionAlarmState(session.state, 'challenge_pending');
      }
      if (session.state !== 'challenge_pending') {
        throw new Error('The active alarm is not waiting for a challenge.');
      }
      if (occurrenceId && isNativeAlarmAvailable) {
        await activateNativeChallenge(lastAlarm.id, occurrenceId);
      }
      if (activeOccurrenceId.current !== occurrenceId) return;
      session.state = transitionAlarmState(session.state, 'challenge_active');
      ringingSwipeX.value = 0;
      setScreen('alarm');
    } catch (error) {
      console.error('The alarm challenge could not be activated.', error);
      Alert.alert(
        'Challenge still locked',
        error instanceof Error ? error.message : 'Wayykup could not verify the active alarm. Keep the alarm screen open and try again.',
      );
    } finally {
      challengeTransitionInProgress.current = false;
    }
  }, [isNativeAlarmAvailable, lastAlarm.id, ringingSwipeX, screen]);

  const ringingSwipeGesture = useMemo(() => Gesture.Pan()
    .activeOffsetX(12)
    .failOffsetY([-18, 18])
    .onUpdate((event) => {
      if (event.translationX > 0) {
        ringingSwipeX.value = Math.min(event.translationX, Math.max(0, windowWidth - 104));
      }
    })
    .onEnd((event) => {
      if (event.translationX >= 112 || event.velocityX >= 850) {
        runOnJS(activateChallengeAfterSwipe)();
      } else {
        ringingSwipeX.value = withSpring(0, { damping: 18, stiffness: 190 });
      }
    }), [activateChallengeAfterSwipe, ringingSwipeX, windowWidth]);
  const ringingSwipeThumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: ringingSwipeX.value }],
  }));

  useEffect(() => {
    if (!isNativeAlarmAvailable || Platform.OS === 'web') return;
    const ringSubscription = addAlarmListener('ringStarted', (event) => {
      if ('occurrenceId' in event) handleNativeRing(event);
    });
    const healthSubscription = addAlarmListener('healthChanged', (event) => {
      if ('canRingNow' in event) {
        setAlarmHealth(event);
        setNotificationsAllowed(event.canRingNow);
      }
    });
    return () => {
      ringSubscription.remove();
      healthSubscription.remove();
    };
  }, [handleNativeRing]);

  useEffect(() => {
    if (!alarmsLoaded || !isNativeAlarmAvailable || Platform.OS === 'web') return;
    getPendingChallenge()
      .then((event) => {
        if (event) handleNativeRing(event);
      })
      .catch((error: unknown) => {
        console.error('Pending native ring could not be restored on app launch.', error);
      });
  }, [alarmsLoaded, handleNativeRing]);

  useEffect(() => {
    if (!alarmsLoaded || Platform.OS !== 'ios' || !isNativeAlarmAvailable) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      getPendingChallenge()
        .then((event) => {
          if (event) handleNativeRing(event);
        })
        .catch((error: unknown) => {
          console.error('AlarmKit challenge state could not be restored after returning to Wayykup.', error);
        });
    });
    return () => subscription.remove();
  }, [alarmsLoaded, handleNativeRing]);

  const finishChallenge = useCallback(async () => {
    const session = alarmSessionState.current;
    if (
      screen !== 'alarm'
      || challengeCompleted.current
      || session.state !== 'challenge_active'
      || session.occurrenceId !== activeOccurrenceId.current
    ) return;
    challengeCompleted.current = true;
    const completedAt = Date.now();
    const challengeDurationMs = Math.max(
      0,
      completedAt - (activeRingStartedAt.current || challengeStartedAt.current),
    );
    const occurrenceId = activeOccurrenceId.current;
    if (occurrenceId && isNativeAlarmAvailable) {
      try {
        await cancelNativeAlarmChain(lastAlarm.id, occurrenceId);
      } catch (error) {
        challengeCompleted.current = false;
        console.error('Verified challenge could not dismiss the native alarm.', error);
        Alert.alert(
          'Alarm is still active',
          error instanceof Error ? error.message : 'Wayykup could not verify this alarm occurrence. Keep trying or retry the completed challenge.',
        );
        return;
      }
    }
    if (Platform.OS === 'ios' && isNativeAlarmAvailable && lastAlarm.days.length > 0) {
      try {
        await scheduleNativeAlarm(lastAlarm);
      } catch (error) {
        console.error('Completed repeating iOS alarm could not be scheduled for its next occurrence.', error);
        Alert.alert(
          'Next alarm could not be scheduled',
          'This alarm was stopped successfully, but Wayykup could not schedule its next occurrence. Check alarm permissions and review the alarm.',
        );
      }
    }

    session.state = transitionAlarmState(session.state, 'challenge_completed');
    session.state = transitionAlarmState(session.state, 'dismissed');
    activeChallengeAlarmId.current = null;
    activeOccurrenceId.current = null;
    setScreen('wakeSuccess');
    setChallengeDurationSeconds(Math.max(1, Math.floor((Date.now() - challengeStartedAt.current) / 1000)));
    if (lastAlarm.days.length === 0) {
      setAlarms((current) => current.map((alarm) => (
        alarm.id === lastAlarm.id ? { ...alarm, enabled: false } : alarm
      )));
    }
    trackEvent('alarm_completed', {
      task: lastAlarm.task,
      snoozes: snoozeLevel,
      completed_at: completedAt,
      device_model: alarmHealth?.deviceModel ?? 'unknown',
    });
    if (!occurrenceId) {
      return;
    }

    let localCompletionSaved = false;
    try {
      const previousOccurrence = occurrences
        .filter((item) => item.id !== occurrenceId && item.status === 'completed' && item.completedAt != null)
        .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0];
      const previousWakeDurationMs = previousOccurrence ? timeToWakeMs(previousOccurrence) : null;
      const streakBefore = calculateStreaks(occurrences, usedFreezeDates(streakFreezes), completedAt).current;
      const occurrenceLocalDate = occurrenceId.split(':').at(-1);
      if (!occurrenceLocalDate || !/^\d{4}-\d{2}-\d{2}$/.test(occurrenceLocalDate)) {
        throw new Error(`The completed wake-up has an invalid local date: ${occurrenceId}`);
      }
      const [year, month, day] = occurrenceLocalDate.split('-').map(Number);
      const scheduledDate = new Date(year, month - 1, day);
      const fallbackOccurrence = makeOccurrence(
        lastAlarm,
        scheduledDate,
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      );
      await completeOccurrence(occurrenceId, completedAt, {
        shakesCounted: lastAlarm.task === 'Shake Your Phone' ? shakeCount : undefined,
        challengeDurationMs,
      }, fallbackOccurrence, activeRingStartedAt.current || completedAt);
      localCompletionSaved = true;
      await refreshAlarmHealth();
      let updatedOccurrences = await getOccurrences();
      const completedOccurrence = updatedOccurrences.find((item) => item.id === occurrenceId);
      if (!completedOccurrence) throw new Error('The completed alarm occurrence was not saved.');
      const counted = countsTowardStreak(completedOccurrence);
      let updatedFreezes = await getStreakFreezes();
      const streakAfter = calculateStreaks(updatedOccurrences, usedFreezeDates(updatedFreezes), completedAt).current;
      await earnFreezeForStreak(occurrenceId, streakBefore, streakAfter);
      if (counted) updatedFreezes = await getStreakFreezes();
      setOccurrences(updatedOccurrences);
      setStreakFreezes(updatedFreezes);
      if (counted) {
        setCelebration({
          occurrenceId,
          streak: streakAfter,
          wakeDurationMs: timeToWakeMs(completedOccurrence) ?? challengeDurationMs,
          previousWakeDurationMs,
        });
        setMorningRatingState(completedOccurrence.morningRating ?? null);
      }
    } catch (error) {
      if (localCompletionSaved) {
        console.error('Wake-up was saved, but its Stats summary could not be refreshed.', error);
        await refreshStats();
        setStatsError('Wake-up saved. Some streak details could not be refreshed.');
        Alert.alert('Wake-up saved', 'Your challenge completion was saved locally, but Wayykup could not refresh all streak details.');
        return;
      }
      console.error('Completed alarm could not be recorded in local stats.', error);
      setStatsError('This wake-up could not be saved to Stats.');
      Alert.alert('Wake-up not saved', 'The challenge is complete, but Wayykup could not save this alarm session locally.');
    }
  }, [
    lastAlarm.days.length,
    lastAlarm.id,
    lastAlarm.task,
    alarmHealth?.deviceModel,
    occurrences,
    refreshAlarmHealth,
    refreshStats,
    screen,
    shakeCount,
    snoozeLevel,
    streakFreezes,
  ]);

  useEffect(() => {
    if (screen !== 'alarm' || lastAlarm.task !== 'Shake Your Phone' || sensorAvailable) return;
    setAlarmFallbackReason('motion_sensor_unavailable');
  }, [lastAlarm, screen, sensorAvailable]);

  const recordChallengeFailure = useCallback(() => {
    const nextWrongCount = wrongAnswers + 1;
    setWrongAnswers(nextWrongCount);
    const occurrenceId = activeOccurrenceId.current;
    if (occurrenceId && Platform.OS === 'android') {
      void setAlarmVolumeTier(Math.min(3, nextWrongCount)).catch((error: unknown) => {
        console.error('Native alarm volume could not be raised after a failed challenge.', error);
      });
    }
    if (!occurrenceId) return;
    recordFailedAttempt(occurrenceId)
      .then(() => refreshStats())
      .catch((error: unknown) => {
        console.error('Failed wake-up attempt could not be recorded.', error);
        Alert.alert('Attempt not saved', 'Wayykup could not save this failed attempt to your local wake-up history.');
      });
  }, [refreshStats, wrongAnswers]);

  useEffect(() => {
    if (screen !== 'alarm' || lastAlarm.task !== 'Object Hunt' || !huntRecognized) return;
    const timeout = setTimeout(() => finishChallenge(), 1100);
    return () => clearTimeout(timeout);
  }, [finishChallenge, huntRecognized, lastAlarm.task, screen]);

  useEffect(() => {
    if (
      screen === 'alarm'
      && lastAlarm.task === 'Shake Your Phone'
      && lastAlarm.challengeConfig.type === 'shake_phone'
      && shakeCount >= lastAlarm.challengeConfig.targetCount
    ) {
      finishChallenge();
    }
  }, [finishChallenge, lastAlarm.challengeConfig, lastAlarm.task, screen, shakeCount]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const handleAlarmNotification = (notification: Notifications.Notification) => {
      const { alarmId, occurrenceId, challenge, sound, scheduledAt } = notification.request.content.data ?? {};
      if (typeof alarmId !== 'string') return;
      const requestId = notification.request.identifier;
      const receivedAt = Date.now();
      if (lastNotificationResponse.current?.id === requestId && receivedAt - lastNotificationResponse.current.receivedAt < 2000) return;
      lastNotificationResponse.current = { id: requestId, receivedAt };
      if (typeof occurrenceId === 'string') {
        markOccurrenceRinging(occurrenceId, receivedAt)
          .then(() => refreshStats())
          .catch((error: unknown) => {
            console.error('Alarm ring could not be recorded.', error);
            Alert.alert('Wake-up not recorded', 'Wayykup could not save this alarm ring to your local history.');
          });
      }
      if (alarmId.startsWith('__wayykup_test_alarm__') && typeof occurrenceId === 'string') {
        handleNativeRing({
          alarmId,
          occurrenceId,
          at: receivedAt,
          scheduledAt: typeof scheduledAt === 'number' ? scheduledAt : receivedAt,
          challenge: typeof challenge === 'string' ? challenge : 'Shake Your Phone',
          sound: typeof sound === 'string' ? sound : DEFAULT_ALARM_SOUND_ID,
          testAlarm: true,
        });
        return;
      }
      const savedSnoozeLevel = notification.request.content.data?.snoozeLevel;
      if (typeof savedSnoozeLevel === 'number') {
        setSnoozeLevels((levels) => ({ ...levels, [alarmId]: savedSnoozeLevel }));
      }
      if (activeChallengeAlarmId.current === alarmId) return;
      const alarm = alarmsRef.current.find((item) => item.id === alarmId);
      if (alarm) startChallengeRef.current(alarm, typeof occurrenceId === 'string' ? occurrenceId : null, receivedAt);
      else if (typeof occurrenceId === 'string') pendingNotificationAlarmId.current = { alarmId, occurrenceId };
    };
    const responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
      handleAlarmNotification(response.notification);
    });
    const receivedSubscription = Notifications.addNotificationReceivedListener(handleAlarmNotification);
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) handleAlarmNotification(response.notification);
      })
      .catch((error: unknown) => {
        console.error('The last alarm notification response could not be read.', error);
      });
    return () => {
      responseSubscription.remove();
      receivedSubscription.remove();
    };
  }, [handleNativeRing]);

  useEffect(() => {
    const pending = pendingNotificationAlarmId.current;
    if (!pending) return;
    const alarm = alarms.find((item) => item.id === pending.alarmId);
    if (!alarm) return;
    pendingNotificationAlarmId.current = null;
    startChallengeRef.current(alarm, pending.occurrenceId, Date.now());
  }, [alarms, alarmsLoaded]);

  const purchaseSubscription = async (
    packageOverride?: Parameters<typeof Purchases.purchasePackage>[0],
    failureStage?: PaywallStage,
    refreshOfferings = false,
    packageTypeOverride?: (typeof Purchases.PACKAGE_TYPE)[keyof typeof Purchases.PACKAGE_TYPE],
    useAndroidAnnualDiscount = false,
  ) => {
    setBillingError('');
    setBillingBusy(true);
    try {
      if (!REVENUECAT_API_KEY) {
        setBillingError('Subscriptions are not configured for this build. Add the RevenueCat public SDK key to enable purchases.');
        if (failureStage) setPaywallStage(failureStage);
        return;
      }

      let offering = currentOffering;
      if (refreshOfferings) {
        const offerings = await Purchases.getOfferings();
        offering = offerings.current;
        setCurrentOffering(offering);
        setAvailablePackages(offering?.availablePackages ?? []);
      }

      const wantedType = packageTypeOverride ?? (plan === 'yearly'
        ? Purchases.PACKAGE_TYPE.ANNUAL
        : Purchases.PACKAGE_TYPE.MONTHLY);
      const selectedPackage = packageOverride
        ? offering?.availablePackages.find((item) => item.identifier === packageOverride.identifier)
        : wantedType === Purchases.PACKAGE_TYPE.ANNUAL
          ? offering?.annual
          : wantedType === Purchases.PACKAGE_TYPE.MONTHLY
            ? offering?.monthly
            : offering?.availablePackages.find((item) => item.packageType === wantedType);
      if (!selectedPackage) {
        setBillingError('This plan is not available in the current RevenueCat offering.');
        if (failureStage) setPaywallStage(failureStage);
        return;
      }

      let result: Awaited<ReturnType<typeof Purchases.purchasePackage>>;
      if (useAndroidAnnualDiscount && Platform.OS === 'android') {
        const discountOption = selectedPackage.product.subscriptionOptions?.find(
          (option) => option.id === 'annual:annual-discount' || option.id.endsWith(':annual-discount'),
        );
        if (!discountOption) {
          setBillingError('The special offer is no longer available. Choose from the regular plans.');
          if (failureStage) setPaywallStage('timeline');
          return;
        }
        result = await Purchases.purchaseSubscriptionOption(discountOption);
      } else {
        result = await Purchases.purchasePackage(selectedPackage);
      }
      if (!result.customerInfo.entitlements.active.wayykup_premium) {
        setBillingError('Purchase completed, but the Wayykup Premium entitlement was not returned.');
        if (failureStage) setPaywallStage(failureStage);
        return;
      }
      setCustomerInfo(result.customerInfo);
      premiumEntitlementRef.current = true;
      setHasPremium(true);
      setLocalAppUnlocked(true);
      setBillingStatus('ready');
      void persistAppProgress({ onboardingComplete: true, appUnlocked: true }).catch((error: unknown) => {
        console.error('Purchased app access could not be saved.', error);
        Alert.alert('Progress could not be saved', 'Your purchase is active, but Wayykup may not remember your app access next time.');
      });
      trackEvent('subscription_started', { plan: selectedPackage.packageType });
      setScreen('home');
    } catch (error) {
      console.error('Subscription purchase failed.', error);
      const wasCancelled = isPurchasesError(error) && error.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR;
      setBillingError(wasCancelled ? '' : error instanceof Error ? error.message : 'The purchase could not be completed.');
      if (failureStage) setPaywallStage(failureStage);
    } finally {
      setBillingBusy(false);
    }
  };

  const restorePurchases = async () => {
    setBillingError('');
    if (!REVENUECAT_API_KEY) {
      setBillingError('RevenueCat is not configured for this build.');
      return;
    }
    try {
      const customerInfo = await Purchases.restorePurchases();
      setCustomerInfo(customerInfo);
      if (customerInfo.entitlements.active.wayykup_premium) {
        premiumEntitlementRef.current = true;
        setHasPremium(true);
        setLocalAppUnlocked(true);
        setBillingStatus('ready');
        void persistAppProgress({ onboardingComplete: true, appUnlocked: true }).catch((error: unknown) => {
          console.error('Restored app access could not be saved.', error);
          Alert.alert('Progress could not be saved', 'Your purchase is active, but Wayykup may not remember your app access next time.');
        });
        trackEvent('subscription_restored');
        if (screen === 'paywall') setScreen('home');
      } else {
        premiumEntitlementRef.current = false;
        setHasPremium(false);
        setLocalAppUnlocked(false);
        setBillingStatus('ready');
        setBillingError('No active Wayykup Premium subscription was found.');
        void loadAppProgress()
          .then((progress) => {
            if (!progress?.appUnlocked) return;
            return persistAppProgress({ ...progress, appUnlocked: false });
          })
          .catch((error: unknown) => {
            console.error('Restored app access could not be updated.', error);
          });
      }
    } catch (error) {
      console.error('Purchase restoration failed.', error);
      setBillingError(error instanceof Error ? error.message : 'Purchases could not be restored.');
    }
  };

  const retryRevenueCat = () => {
    setBillingError('');
    setBillingStatus('loading');
    setBillingRetryCount((count) => count + 1);
  };

  const closeCurrentPlan = () => {
    setCurrentPlanModalVisible(false);
    if (!hasPremium) {
      setPaywallStage('intro');
      setScreen('paywall');
    }
  };

  const updateTime = (part: 'hour' | 'minute', delta: number) => {
    const [hour, minute] = draft.time.split(':').map(Number);
    const date = new Date();
    date.setHours(hour, minute, 0, 0);
    if (part === 'hour') date.setHours(date.getHours() + delta);
    else date.setMinutes(date.getMinutes() + delta);
    setDraft((current) => ({
      ...current,
      time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
    }));
  };

  const toggleDay = (index: number) => {
    const value = String(index);
    setDraft((current) => ({
      ...current,
      days: current.days.includes(value)
        ? current.days.filter((day) => day !== value)
        : [...current.days, value],
    }));
  };

  const isDaySelected = (index: number) => draft.days.includes(String(index));

  const completeOnboarding = async ({ alarm, notificationGranted, keepAlarmPlaying }: OnboardingSetup) => {
    const newAlarm: Alarm = alarm;
    const nextAlarms = [
      ...alarmsRef.current.filter((item) => !['alpha', 'bravo', 'charlie'].includes(item.id)),
      newAlarm,
    ];
    const completedProgress = { onboardingComplete: true, appUnlocked: false };
    try {
      await Promise.all([
        persistAlarms(nextAlarms),
        persistKeepAlarmPlayingPreference(keepAlarmPlaying),
        persistAppProgress(completedProgress),
      ]);
    } catch (error) {
      console.error('Onboarding setup could not be saved.', error);
      Alert.alert('Setup could not be saved', 'Wayykup could not save your alarm and setup. Please try again before leaving onboarding.');
      throw error;
    }

    alarmsRef.current = nextAlarms;
    setDraft(newAlarm);
    setAlarms(nextAlarms);
    setNotificationsAllowed(notificationGranted);
    setLocalAppUnlocked(false);
    setKeepAlarmPlayingDuringChallenges(keepAlarmPlaying);
    setPaywallStage('intro');
    trackEvent('onboarding_completed', { task: newAlarm.task ?? 'none', time: newAlarm.time });
    setScreen(hasPremium ? 'home' : 'paywall');
  };

  const showCurrentPlan = () => {
    setBillingError('');
    setCurrentPlanModalVisible(true);
    if (!REVENUECAT_API_KEY || Platform.OS === 'web') return;

    setBillingBusy(true);
    Purchases.getCustomerInfo()
      .then((latestInfo) => {
        setCustomerInfo(latestInfo);
        const isPremium = Boolean(latestInfo.entitlements.active.wayykup_premium);
        premiumEntitlementRef.current = isPremium;
        setHasPremium(isPremium);
        if (!isPremium) {
          setLocalAppUnlocked(false);
          void loadAppProgress()
            .then((progress) => {
              if (!progress?.appUnlocked) return;
              return persistAppProgress({ ...progress, appUnlocked: false });
            })
            .catch((error: unknown) => {
              console.error('Expired app access could not be updated.', error);
            });
        }
      })
      .catch((error: unknown) => {
        console.error('Current subscription could not be refreshed.', error);
        setBillingError('Your current plan could not be refreshed. Check your connection and try again.');
      })
      .finally(() => setBillingBusy(false));
  };

  const openSubscriptionManagement = async () => {
    const managementUrl = customerInfo?.managementURL;
    if (!managementUrl) {
      setBillingError('Subscription management is unavailable from the store right now.');
      return;
    }
    try {
      await Linking.openURL(managementUrl);
    } catch (error) {
      console.error('Subscription management could not be opened.', error);
      setBillingError('The store subscription page could not be opened.');
    }
  };

  const renderWelcome = () => (
    <View style={styles.onboarding}>
      <View style={styles.onboardingTop}>
        <View style={styles.wordmarkLockup}>
          <WayykupIcon size={26} />
          <Text style={styles.wordmark}>WAYYKUP<Text style={styles.wordmarkDot}>.</Text></Text>
        </View>
        <Tag>WAKE UP / 001</Tag>
      </View>
      <View style={styles.heroGraphic}>
        <View style={styles.orbit}>
          <View style={styles.orbitInner}>
            <Text style={styles.bolt}>↯</Text>
            <Text style={styles.graphicCaption}>NO EASY WAY OUT</Text>
          </View>
        </View>
        <View style={styles.graphicStamp}><Text style={styles.stampText}>EST.{'\n'}05:00</Text></View>
      </View>
      <View style={styles.onboardingCopy}>
        <Text style={styles.eyebrow}>01 — THE WAKE-UP CALL</Text>
        <Text style={styles.onboardingTitle}>Waking up{'\n'}shouldn’t be{'\n'}<Text style={styles.redText}>easy.</Text></Text>
        <Text style={styles.bodyCopy}>Built for the snoozers. Made for the next version of you.</Text>
      </View>
      <ActionButton label="LET’S GET UP" onPress={() => setScreen('proof')} />
      <Text style={styles.footerNote}>YOUR MORNING. YOUR MISSION.</Text>
    </View>
  );

  const renderProof = () => (
    <View style={styles.onboarding}>
      <View style={styles.onboardingTop}>
        <TouchableOpacity onPress={() => setScreen('welcome')}><Text style={styles.backText}>← BACK</Text></TouchableOpacity>
        <Tag>02 / 03</Tag>
      </View>
      <View style={styles.proofIntro}>
        <Text style={styles.eyebrow}>NO SNOOZE. NO MERCY.</Text>
        <Text style={styles.sectionTitle}>Prove you’re{'\n'}<Text style={styles.redText}>awake.</Text></Text>
        <Text style={styles.bodyCopy}>Pick your challenge. Your bed doesn’t get the last word.</Text>
      </View>
      <View style={styles.proofList}>
        {TASKS.slice(0, 3).map((task, index) => (
          <View key={task.type} style={styles.proofRow}>
            <View style={styles.proofIcon}><Text style={styles.proofIconText}>{task.icon}</Text></View>
            <View style={styles.proofCopy}><Text style={styles.proofName}>{task.title}</Text><Text style={styles.proofDetail}>{task.description}</Text></View>
            <Text style={styles.proofIndex}>0{index + 1}</Text>
          </View>
        ))}
      </View>
      <View style={styles.onboardingBottom}>
        <ActionButton label="SHOW ME THE PLAN" onPress={() => setScreen('paywall')} />
        <Text style={styles.footerNote}>NEXT UP: YOUR ULTIMATE WAKE-UP CALL</Text>
      </View>
    </View>
  );

  const renderPaywall = () => {
    const annualPackage = currentOffering?.annual ?? null;
    const annualProduct = annualPackage?.product;
    const introOffer = annualProduct?.introPrice;
    const androidAnnualDiscountOption = Platform.OS === 'android'
      ? annualProduct?.subscriptionOptions?.find(
        (option) => option.id === 'annual:annual-discount' || option.id.endsWith(':annual-discount'),
      )
      : undefined;
    const introPeriod = introOffer
      ? formatBillingPeriod(introOffer.periodNumberOfUnits, introOffer.periodUnit)
      : null;
    const androidIntroPhase = androidAnnualDiscountOption?.introPhase;
    const annualRenewalPrice = androidAnnualDiscountOption?.fullPricePhase?.price.formatted
      ?? annualProduct?.priceString;
    const hasSpecialOffer = Platform.OS === 'ios'
      ? Boolean(annualIntroEligible && introOffer)
      : Platform.OS === 'android'
        ? Boolean(androidAnnualDiscountOption?.introPhase)
        : false;

    const isIntro = paywallStage === 'intro';
    const isReminder = paywallStage === 'reminder';
    const isTimeline = paywallStage === 'timeline' || (paywallStage === 'gift' && !hasSpecialOffer);
    const isGift = paywallStage === 'gift' && hasSpecialOffer;

      if (isIntro) {
        return (
          <ScrollView
            style={styles.trialIntroScroll}
            contentContainerStyle={[styles.trialIntro, compactViewport && styles.trialIntroCompact]}
            showsVerticalScrollIndicator={false}
          >
            <Text style={[styles.trialTitle, { fontSize: Math.min(43, windowWidth * 0.11), lineHeight: Math.min(49, windowWidth * 0.125), marginTop: compactViewport ? 10 : 56 }]}>Get ready to{'\n'}own your mornings</Text>
            <View style={[styles.trialPhoneArea, { minHeight: trialPhoneHeight + 24 }]}>
              <AlarmPhonePreview phoneHeight={trialPhoneHeight} />
            </View>
            <View style={styles.trialFooter}>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => setPaywallStage('reminder')}
                style={styles.trialContinue}
              >
                <Text style={styles.trialContinueText}>Continue</Text>
                <Text style={styles.trialContinueArrow}>›</Text>
              </TouchableOpacity>
              <View style={styles.trialCancelRow}>
                <Text style={styles.trialCheck}>✓</Text>
                <Text style={styles.trialCancelText}>No commitment, cancel anytime</Text>
              </View>
              <View style={styles.trialLegalRow}>
                <Text style={styles.trialLegalText}>Privacy Policy  ·  Terms of Use  ·  </Text>
                <TouchableOpacity accessibilityRole="button" onPress={() => { void restorePurchases(); }}>
                  <Text style={[styles.trialLegalText, styles.trialLegalLink]}>Restore Purchase</Text>
                </TouchableOpacity>
              </View>
              {!!billingError && <Text accessibilityRole="alert" style={styles.trialError}>{billingError}</Text>}
            </View>
          </ScrollView>
        );
      }

      if (isReminder) {
        return (
          <ScrollView
            style={styles.trialIntroScroll}
            contentContainerStyle={[styles.trialReminder, compactViewport && styles.trialReminderCompact]}
            showsVerticalScrollIndicator={false}
          >
            <Text style={[styles.trialReminderTitle, { fontSize: Math.min(42, windowWidth * 0.095), lineHeight: Math.min(50, windowWidth * 0.105) }]}>
              See your plan{'\n'}before you confirm
            </Text>
            <View style={styles.trialReminderArt}>
              <Svg width="190" height="210" viewBox="0 0 190 210" accessibilityLabel="Reminder bell">
                <Path
                  d="M95 26c-31 0-51 24-51 58v30c0 20-9 31-20 42-7 7-3 17 7 17h128c10 0 14-10 7-17-11-11-20-22-20-42V84"
                  fill="none"
                  stroke="#000000"
                  strokeWidth="9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <Path d="M72 177c2 15 10 23 23 23s21-8 23-23" fill="none" stroke="#000000" strokeWidth="9" strokeLinecap="round" />
                <Circle cx="144" cy="48" r="25" fill="#000000" />
              </Svg>
            </View>
            <View style={styles.trialFooter}>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => setPaywallStage('timeline')}
                style={styles.trialContinue}
              >
                <Text style={styles.trialContinueText}>Continue</Text>
                <Text style={styles.trialContinueArrow}>›</Text>
              </TouchableOpacity>
              <View style={styles.trialCancelRow}>
                <Text style={styles.trialCheck}>✓</Text>
                <Text style={styles.trialCancelText}>No commitment, cancel anytime</Text>
              </View>
              <View style={styles.trialLegalRow}>
                <Text style={styles.trialLegalText}>Privacy Policy  ·  Terms of Use  ·  </Text>
                <TouchableOpacity accessibilityRole="button" onPress={() => { void restorePurchases(); }}>
                  <Text style={[styles.trialLegalText, styles.trialLegalLink]}>Restore Purchase</Text>
                </TouchableOpacity>
              </View>
              {!!billingError && <Text accessibilityRole="alert" style={styles.trialError}>{billingError}</Text>}
            </View>
          </ScrollView>
        );
      }

      if (isTimeline) {
        const hasEligibleIntro = Platform.OS === 'ios' && annualIntroEligible && introOffer;
        const hasFreeTrial = Boolean(hasEligibleIntro && introOffer?.price === 0);
        const timelineItems = [
          {
            kind: 'unlock' as const,
            title: 'Today — Full access',
            detail: 'Wake-up challenges, alarm sounds and detailed stats.',
          },
          ...(hasFreeTrial
            ? [{
                kind: 'bell' as const,
                title: 'Before your trial ends — Reminder',
                detail: `Your ${introPeriod} free trial is ending soon.`,
              }]
            : hasEligibleIntro && introOffer
              ? [{
                  kind: 'bell' as const,
                  title: 'Intro offer, if eligible',
                  detail: `${introOffer.priceString} for your first ${introPeriod}, then ${annualProduct?.priceString ?? ''} per year.`,
                }]
              : [{
                  kind: 'bell' as const,
                  title: 'Standard subscription',
                  detail: 'Your subscription starts at the displayed annual price when you confirm your purchase.',
                }]),
          {
            kind: 'trophy' as const,
            title: hasFreeTrial ? `After ${introPeriod} — Billing` : 'Annual renewal',
            detail: annualProduct
              ? `${annualProduct.priceString} per year, as confirmed by your store.`
              : 'Annual price and billing terms will be shown by your store.',
          },
        ];
        return (
          <ScrollView
            style={styles.trialIntroScroll}
            contentContainerStyle={[styles.proTrialScreen, compactViewport && styles.proTrialScreenCompact]}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.proTrialHeader}>
              <TouchableOpacity accessibilityRole="button" onPress={() => { void restorePurchases(); }}>
                <Text style={styles.proTrialRestore}>Restore</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={hasSpecialOffer ? 'View special offer' : 'View subscription plans'}
                onPress={() => {
                  setBillingError('');
                  if (hasSpecialOffer) {
                    setPaywallStage('gift');
                  } else {
                    setPlan('yearly');
                    setPlansModalVisible(true);
                  }
                }}
                style={styles.proTrialClose}
              >
                <Text style={styles.proTrialCloseGlyph}>×</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.proTrialContent}>
              <View style={styles.proTrialAlarmIcon}>
                <Svg width={58} height={58} viewBox="0 0 58 58" accessibilityLabel="Wayykup alarm">
                  <Path d="M17 13 11 8M41 13l6-5M18 45h22M21 43V26a8 8 0 0 1 16 0v17M15 22a14 14 0 0 1 28 0M25 29l4 4 7-8M13 44l-4 5M45 44l4 5" fill="none" stroke="#171018" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  <Circle cx="29" cy="27" r="15" fill="none" stroke="#171018" strokeWidth="2.5" />
                </Svg>
              </View>
              <Text style={styles.proTrialTitle}>Unlock Wayykup{'\n'}Pro</Text>
              <Text style={styles.proTrialPrice}>
                {annualProduct?.pricePerMonthString
                  ? `Just ${annualProduct.pricePerMonthString} per month`
                  : 'Annual price shown by your store'}
              </Text>
              {annualProduct && (
                <Text style={styles.proTrialBilled}>({annualProduct.priceString} billed yearly)</Text>
              )}
              <Text style={styles.proTrialSectionTitle}>
                {hasFreeTrial ? 'How your trial works' : 'How your subscription works'}
              </Text>
              <View style={styles.proTrialTimeline}>
                <View pointerEvents="none" style={styles.proTrialTimelineLine} />
                {timelineItems.map((item) => (
                  <View key={item.kind} style={styles.proTrialTimelineRow}>
                    <View style={styles.proTrialTimelineIcon}>
                      <TrialTimelineIcon kind={item.kind} />
                    </View>
                    <View style={styles.proTrialTimelineCopy}>
                      <Text style={styles.proTrialTimelineTitle}>{item.title}</Text>
                      <Text style={styles.proTrialTimelineDetail}>{item.detail}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>
            <View style={styles.proTrialFooter}>
              <View style={styles.trialCancelRow}>
                <Text style={styles.trialCheck}>✓</Text>
                <Text style={styles.trialCancelText}>No commitment, cancel anytime</Text>
              </View>
              <TouchableOpacity
                accessibilityRole="button"
                disabled={billingBusy}
                onPress={() => {
                  setPlan('yearly');
                  void purchaseSubscription(undefined, 'gift', true, Purchases.PACKAGE_TYPE.ANNUAL);
                }}
                style={[styles.trialContinue, billingBusy && styles.proTrialContinueDisabled]}
              >
                <Text style={styles.trialContinueText}>{billingBusy ? 'Connecting to store…' : 'Continue'}</Text>
                <Text style={styles.trialContinueArrow}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setBillingError('');
                  setPlan('yearly');
                  setPlansModalVisible(true);
                }}
                style={styles.proTrialPlans}
              >
                <Text style={styles.proTrialPlansText}>View all plans</Text>
              </TouchableOpacity>
              {!!billingError && <Text accessibilityRole="alert" style={styles.trialError}>{billingError}</Text>}
              <View style={styles.trialLegalRow}>
                <Text style={styles.trialLegalText}>Privacy Policy  ·  Terms of Use</Text>
              </View>
            </View>
          </ScrollView>
        );
      }

      if (isGift) {
        return (
          <ScrollView
            style={styles.trialIntroScroll}
            contentContainerStyle={[styles.giftOfferScreen, compactViewport && styles.giftOfferScreenCompact]}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.giftOfferHeader}>
              <Text style={styles.giftOfferHeaderLabel}>YOUR SPECIAL OFFER</Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Close special offer"
                onPress={() => setPaywallStage('timeline')}
                style={styles.giftOfferClose}
              >
                <Text style={styles.proTrialCloseGlyph}>×</Text>
              </TouchableOpacity>
            </View>
            <Text style={[styles.giftOfferTitle, { fontSize: Math.min(37, windowWidth * 0.083), lineHeight: Math.min(45, windowWidth * 0.097) }]}>
              Your first year,{'\n'}at a special price
            </Text>
            <AnimatedGiftArtwork height={Math.min(380, Math.max(230, availableHeight * (compactViewport ? 0.34 : 0.43)))} />
            <View style={styles.giftOfferFooter}>
              <Text style={styles.giftOfferTerms}>
                {Platform.OS === 'ios' && introOffer && annualProduct
                  ? `${introOffer.priceString} for your first ${introPeriod}, then ${annualProduct.priceString} per year. Renews automatically unless cancelled.`
                  : androidIntroPhase && annualRenewalPrice
                    ? `${androidIntroPhase.price.formatted} for your first ${formatBillingPeriod(androidIntroPhase.billingPeriod.value, androidIntroPhase.billingPeriod.unit)}, then ${annualRenewalPrice} per year. Renews automatically unless cancelled.`
                    : ''}
              </Text>
              <AnimatedOfferButton
                busy={billingBusy}
                onPress={() => {
                  setPlan('yearly');
                  void purchaseSubscription(
                    undefined,
                    'gift',
                    true,
                    Purchases.PACKAGE_TYPE.ANNUAL,
                    Platform.OS === 'android',
                  );
                }}
              />
              <View style={styles.trialCancelRow}>
                <Text style={styles.trialCheck}>✓</Text>
                <Text style={styles.trialCancelText}>No commitment, cancel anytime</Text>
              </View>
              {!!billingError && <Text accessibilityRole="alert" style={styles.giftOfferError}>{billingError}</Text>}
              <View style={styles.giftOfferLegal}>
                <Text style={styles.trialLegalText}>Privacy Policy  ·  Terms of Use  ·  </Text>
                <TouchableOpacity accessibilityRole="button" onPress={() => { void restorePurchases(); }}>
                  <Text style={[styles.trialLegalText, styles.trialLegalLink]}>Restore Purchase</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        );
      }

      return (
        <ScrollView contentContainerStyle={styles.waterfall} showsVerticalScrollIndicator={false}>
          <View style={styles.wordmarkLockup}>
            <WayykupIcon size={26} />
            <Text style={styles.wordmarkSmall}>WAYYKUP<Text style={styles.wordmarkDot}>.</Text></Text>
          </View>
          <View style={styles.waterfallHero}>
            <Text style={styles.waterfallIcon}>{isIntro ? '◴' : '✦'}</Text>
            <Text style={styles.eyebrow}>{isGift ? 'A THANK-YOU OFFER' : 'YOUR MORNING, REBUILT'}</Text>
            <Text style={styles.waterfallTitle}>
              {isIntro ? 'Your wake-up plan is ready.' : 'Unlock Wayykup Pro.'}
            </Text>
            <Text style={styles.bodyCopy}>
              {isIntro
                ? 'Your first alarm is set. Choose a plan to unlock the full set of wake-up challenges and sounds.'
                : 'The store will show the localized price and billing period before you confirm.'}
            </Text>
          </View>

          <View style={styles.waterfallActions}>
            {isIntro && <ActionButton label="CONTINUE" onPress={() => setPaywallStage('reminder')} />}
            {isReminder && <ActionButton label="CONTINUE" onPress={() => setPaywallStage('timeline')} />}
            {isTimeline && <ActionButton label={billingBusy ? 'CONNECTING TO APP STORE…' : 'CONTINUE TO STORE'} onPress={() => purchaseSubscription(undefined, undefined, true, Purchases.PACKAGE_TYPE.ANNUAL)} disabled={billingBusy || !annualPackage} />}
            {isTimeline && !!billingError && <Text accessibilityRole="alert" style={styles.billingError}>{billingError}</Text>}
            {isTimeline && (
              <TouchableOpacity
                onPress={() => {
                  setBillingError('');
                  setPlan('yearly');
                  setPlansModalVisible(true);
                }}
                style={styles.restorePurchases}
              >
                <Text style={styles.restoreText}>VIEW ALL PLANS</Text>
              </TouchableOpacity>
            )}
            {isIntro && <Text style={styles.terms}>No charge is made without confirming the store purchase sheet.</Text>}
          </View>
        </ScrollView>
      );
  };

  const renderHome = () => {
    const layoutScale = Math.max(0.76, Math.min(1, windowWidth / 390, availableHeight / 760));
    const clockSize = Math.max(64, Math.min(110, windowWidth * 0.29, availableHeight * 0.16));
    const horizontalInset = windowWidth < 360 ? 12 : Math.min(22, windowWidth * 0.055);
    const alarmHealthMessage = !isNativeAlarmAvailable
      ? 'Install a development build. Expo Go cannot ring native alarms.'
      : !alarmHealth
        ? 'Checking native alarm permissions…'
        : !alarmHealth.canRingNow
          ? 'Alarm access is incomplete. Tap to review permissions.'
          : alarmHealth.reliability === 'reduced'
            ? 'This iOS version uses notifications, not a persistent alarm. AlarmKit requires iOS 26+.'
            : alarmHealth.batteryRestricted
            ? 'Battery restrictions may delay alarms on this device.'
            : null;

    return (
      <SafeAreaView style={styles.safeArea}>
        {Platform.OS === 'web' && (
          <View style={styles.referenceStatusBar}>
            <Text style={styles.referenceStatusTime}>{formatDigitalClock(now)}</Text>
            <View style={styles.referenceStatusIcons}><Text style={styles.statusSignal}>▂▄▆</Text><Text style={styles.statusWifi}>◔</Text><View style={styles.statusBattery}><Text style={styles.statusBatteryText}>100</Text></View></View>
          </View>
        )}
        <View style={[styles.referenceHomeContent, { paddingHorizontal: horizontalInset, paddingTop: 8 * layoutScale }]}>
          <View style={[styles.referenceClockArea, { height: availableHeight * (compactViewport ? 0.31 : 0.35) }]}>
            <View style={styles.referenceClockBlock}>
              <Text style={[styles.referenceClock, { fontSize: clockSize, lineHeight: clockSize * 0.86, letterSpacing: -clockSize * 0.046 }]}>{formatDigitalClock(now)}</Text>
              <Text style={[styles.referenceDate, { fontSize: 18 * layoutScale, lineHeight: 24 * layoutScale }]}>{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</Text>
            </View>
          </View>
          <View style={[styles.referenceAlarmSection, { flex: 1, minHeight: 0 }]}>
            <View style={styles.referenceAlarmSectionHeader}>
              <Text style={[styles.referenceAlarmSectionTitle, { fontSize: 22 * layoutScale }]}>Your alarms</Text>
              <AnimatedTouchableOpacity
                accessibilityRole="button"
                onPress={openNewAlarm}
                onPressIn={() => Animated.spring(addButtonScale, { toValue: 0.94, useNativeDriver: true, speed: 35, bounciness: 8 }).start()}
                onPressOut={() => Animated.spring(addButtonScale, { toValue: 1, useNativeDriver: true, speed: 25, bounciness: 8 }).start()}
                style={[styles.referenceAddCompact, { transform: [{ scale: addButtonScale }] }]}
              >
                <Text style={styles.referenceAddCompactPlus}>＋</Text>
                <Text style={styles.referenceAddCompactLabel}>ADD</Text>
              </AnimatedTouchableOpacity>
            </View>
            {alarmHealthMessage && (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`Alarm health. ${alarmHealthMessage}`}
                onPress={() => {
                  if (!isNativeAlarmAvailable) {
                    Alert.alert('Development build required', 'Alarm testing is disabled in Expo Go. Install the Wayykup development build.');
                  } else if (alarmHealth?.reliability === 'reduced') {
                    Alert.alert(
                      'iOS notification fallback',
                      'This iOS version cannot provide the persistent alarm experience available with AlarmKit on iOS 26 and later.',
                    );
                  } else if (alarmHealth?.canRingNow && alarmHealth.testAlarmPassed !== true) {
                    void beginAlarmTest();
                  } else if (!alarmHealth?.notifications) {
                    void requestSettingsNotifications();
                  } else if (!alarmHealth?.exactAlarm) {
                    void openAlarmSettings('exactAlarm');
                  } else if (!alarmHealth?.fullScreenIntent && alarmHealth.platform === 'android') {
                    void openAlarmSettings('fullScreenIntent');
                  } else {
                    void openAlarmSettings('battery');
                  }
                }}
                style={styles.nativeAlarmHealthBanner}
              >
                <View style={styles.nativeAlarmHealthDot} />
                <View style={styles.nativeAlarmHealthCopy}>
                  <Text style={styles.nativeAlarmHealthTitle}>ALARM HEALTH</Text>
                  <Text style={styles.nativeAlarmHealthMessage}>{alarmHealthMessage}</Text>
                </View>
                <Text style={styles.nativeAlarmHealthAction}>
                  {alarmHealth?.testAlarmPassed ? 'FIX' : 'CHECK'}
                </Text>
              </TouchableOpacity>
            )}
            <Text style={styles.alarmSwipeHint}>Swipe right to edit · swipe left to delete</Text>
            <ScrollView
              style={styles.referenceAlarmListScroll}
              contentContainerStyle={{ paddingBottom: 10 * layoutScale }}
              showsVerticalScrollIndicator={false}
            >
              {alarms.length ? (
                <View style={styles.alarmCardList}>
                  {alarms.map((alarm, index) => (
                    <View key={`alarm-card-${alarm.id}`} style={[styles.referenceAlarmCard, { borderRadius: 24 * layoutScale, paddingHorizontal: 19 * layoutScale }]}>
                      <AlarmSwipeRow
                        alarm={alarm}
                        index={index}
                        total={alarms.length}
                        layoutScale={layoutScale}
                        nextLabel={nextAlarmCountdown(alarm, now)}
                        openSwipeId={openAlarmSwipeId}
                        onSwipeOpen={handleAlarmSwipeOpen}
                        onEdit={() => openEditAlarm(alarm)}
                        onDelete={() => deleteAlarm(alarm)}
                        onToggle={() => {
                          setOpenAlarmSwipeId(null);
                          setAlarms((current) => current.map((item) => item.id === alarm.id ? { ...item, enabled: !item.enabled } : item));
                          trackEvent(alarm.enabled ? 'alarm_disabled' : 'alarm_enabled', { task: alarm.task ?? 'none', time: alarm.time });
                        }}
                      />
                    </View>
                  ))}
                </View>
              ) : (
                <TouchableOpacity onPress={openNewAlarm} style={styles.referenceEmptyCard}>
                  <Text style={styles.referenceEmptyText}>No alarms yet · Add your first alarm</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </View>
        </View>
        <GlassNavigationBar
          selected="alarms"
          indicatorPosition={navIndicatorPosition}
          reduceMotion={reduceMotion}
          onSelect={(tab) => setScreen(tab === 'alarms' ? 'home' : tab)}
          scale={layoutScale}
          style={{ width: windowWidth < 360 ? '90%' : '82%' }}
        />
        {Platform.OS === 'web' && <View style={styles.referenceHomeIndicator}><View style={styles.referenceHomeIndicatorLine} /></View>}
        <StatusBar barStyle="dark-content" />
        {screen === 'editor' && renderEditor()}
      </SafeAreaView>
    );
  };

  const renderEditor = () => {
    const [hourValue, minuteValue] = draft.time.split(':').map(Number);
    const isPm = hourValue >= 12;
    const hour12 = hourValue % 12 || 12;
    const hourValues = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'));
    const minuteValues = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0'));
    const closeEditor = () => {
      setChallengePreviewing(false);
      dismissEditor();
    };
    const updateHour = (index: number) => {
      const selectedHour = index + 1;
      const nextHour = isPm ? (selectedHour === 12 ? 12 : selectedHour + 12) : selectedHour === 12 ? 0 : selectedHour;
      setDraft((current) => ({ ...current, time: `${String(nextHour).padStart(2, '0')}:${String(minuteValue).padStart(2, '0')}` }));
    };
    const updateMinute = (index: number) => {
      setDraft((current) => ({ ...current, time: `${String(hourValue).padStart(2, '0')}:${String(index).padStart(2, '0')}` }));
    };
    const updatePeriod = (index: number) => {
      const nextHour = index === 1 ? (hourValue % 12) + 12 : hourValue % 12;
      setDraft((current) => ({ ...current, time: `${String(nextHour).padStart(2, '0')}:${String(minuteValue).padStart(2, '0')}` }));
    };
    const selectTask = (task: Task) => {
      const type = challengeTypeForTask(task);
      if (!type) return;
      setChallengePreviewing(false);
      setDraft((current) => {
        const config = current.challengeConfig?.type === type
          ? current.challengeConfig
          : defaultChallengeConfiguration(type);
        return {
          ...current,
          task,
          challengeConfig: config,
        };
      });
    };
    const previewSound = async (sound: string) => {
      if (previewingSound === sound) {
        if (soundPreviewTimeout.current) clearTimeout(soundPreviewTimeout.current);
        soundPreviewTimeout.current = null;
        soundPreviewPlayer.pause();
        setPreviewingSound(null);
        return;
      }
      try {
        if (soundPreviewTimeout.current) clearTimeout(soundPreviewTimeout.current);
        await setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'doNotMix' });
        soundPreviewPlayer.replace(alarmSoundAsset(sound));
        soundPreviewPlayer.loop = false;
        soundPreviewPlayer.volume = 0.9;
        soundPreviewPlayer.play();
        setPreviewingSound(sound);
        soundPreviewTimeout.current = setTimeout(() => {
          soundPreviewPlayer.pause();
          setPreviewingSound(null);
          soundPreviewTimeout.current = null;
        }, 3300);
      } catch (error) {
        console.error('Alarm sound preview could not start.', error);
        Alert.alert('Preview unavailable', 'Wayykup could not play this alarm preview on this device.');
      }
    };
    return (
      <Modal visible={screen === 'editor'} transparent animationType="none" statusBarTranslucent onRequestClose={closeEditor}>
        <View style={styles.editorModal}>
          <Animated.View style={[styles.editorBackdrop, { opacity: backdropOpacity }]}>
            <TouchableOpacity accessibilityLabel="Close alarm editor" activeOpacity={1} onPress={closeEditor} style={StyleSheet.absoluteFill} />
          </Animated.View>
          <Animated.View style={[styles.alarmSheet, { transform: [{ translateY: sheetTranslation }] }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <TouchableOpacity onPress={closeEditor} style={styles.sheetHeaderButton}><Text style={styles.sheetCancel}>Cancel</Text></TouchableOpacity>
              <Text style={styles.sheetTitle}>{editingId ? 'Edit Alarm' : 'New Alarm'}</Text>
              <TouchableOpacity onPress={saveAlarm} style={styles.sheetHeaderButton}><Text style={styles.sheetAdd}>Add</Text></TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.sheetContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <View style={styles.wheelPicker}>
                <View pointerEvents="none" style={styles.wheelSelection} />
                <WheelColumn label="Hour" values={hourValues} selectedIndex={hour12 - 1} onChange={updateHour} />
                <Text style={styles.wheelColon}>:</Text>
                <WheelColumn label="Minute" values={minuteValues} selectedIndex={minuteValue} onChange={updateMinute} />
                <WheelColumn label="AM or PM" values={['AM', 'PM']} selectedIndex={isPm ? 1 : 0} onChange={updatePeriod} />
              </View>

              <View style={styles.sheetSection}>
                <Text style={styles.sheetSectionTitle}>Repeat</Text>
                <View style={styles.sheetDaysRow}>
                  {DAYS.map((day, index) => (
                    <TouchableOpacity key={`${day}-${index}`} onPress={() => toggleDay(index)} style={[styles.sheetDay, isDaySelected(index) && styles.sheetDaySelected]}>
                      <Text style={[styles.sheetDayText, isDaySelected(index) && styles.sheetDayTextSelected]}>{day}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <View style={styles.sheetSection}>
                <TouchableOpacity onPress={() => setExpandedEditorSection(expandedEditorSection === 'sound' ? null : 'sound')} style={styles.sheetOptionRow}>
                  <View style={styles.sheetOptionIcon}><Text style={styles.sheetOptionGlyph}>♫</Text></View>
                  <View style={styles.sheetOptionCopy}><Text style={styles.sheetOptionTitle}>Sound</Text><Text style={styles.sheetOptionSubtitle}>{alarmSoundName(draft.sound)}</Text></View>
                  <Text style={styles.sheetChevron}>{expandedEditorSection === 'sound' ? '⌄' : '›'}</Text>
                </TouchableOpacity>
                {expandedEditorSection === 'sound' && <View style={styles.sheetInlineOptions}>
                  {ALARM_SOUNDS.map((sound) => {
                    const selected = draft.sound === sound.id;
                    const previewing = previewingSound === sound.id;
                    return (
                      <View key={sound.id} style={styles.sheetInlineOption}>
                        <TouchableOpacity
                          accessibilityRole="button"
                          onPress={() => setDraft((current) => ({ ...current, sound: sound.id }))}
                          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 43 }}
                        >
                          <Text style={[styles.sheetInlineText, selected && styles.sheetInlineTextSelected]}>{sound.name}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel={`${previewing ? 'Stop' : 'Preview'} ${sound.name}`}
                          onPress={() => { void previewSound(sound.id); }}
                          style={{ minWidth: 42, minHeight: 43, alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Text style={styles.soundPreviewButton}>{previewing ? '■' : '▶'}</Text>
                        </TouchableOpacity>
                        {selected && <Text style={styles.sheetInlineCheck}>✓</Text>}
                      </View>
                    );
                  })}
                </View>}

                <TouchableOpacity onPress={() => setExpandedEditorSection(expandedEditorSection === 'task' ? null : 'task')} style={[styles.sheetOptionRow, styles.sheetOptionDivider]}>
                  <View style={styles.sheetOptionIcon}><Text style={styles.sheetOptionGlyph}>{TASKS.find((task) => task.task === draft.task)?.icon ?? '!'}</Text></View>
                  <View style={styles.sheetOptionCopy}><Text style={styles.sheetOptionTitle}>Wake-Up Task</Text><Text style={styles.sheetOptionSubtitle}>{taskLabel(draft.task, draft)}</Text></View>
                  <Text style={styles.sheetChevron}>{expandedEditorSection === 'task' ? '⌄' : '›'}</Text>
                </TouchableOpacity>
                {expandedEditorSection === 'task'
                  && !challengeTypeForTask(draft.task)
                  && (
                  <View style={styles.legacyChallengeNotice}>
                    <Text style={styles.legacyChallengeNoticeTitle}>THIS MISSION IS RETIRED</Text>
                    <Text style={styles.legacyChallengeNoticeBody}>
                      Choose a current mission below before this saved alarm can ring its challenge.
                    </Text>
                  </View>
                )}
                {expandedEditorSection === 'task' && (
                  <View style={styles.missionGrid}>
                    {TASKS.map((mission) => {
                      const selected = draft.task === mission.task;
                      return (
                        <TouchableOpacity
                          key={mission.type}
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          onPress={() => selectTask(mission.task)}
                          style={[styles.missionCard, selected && styles.missionCardSelected]}
                        >
                          <View style={[styles.missionIconWrap, selected && styles.missionIconWrapSelected]}>
                            <Text style={[styles.missionIcon, selected && styles.missionIconSelected]}>{mission.icon}</Text>
                          </View>
                          <Text style={styles.missionTitle}>{mission.title}</Text>
                          <Text style={styles.missionDescription}>{mission.description}</Text>
                          <View style={styles.missionMetaRow}>
                            <Text style={styles.missionMeta}>{mission.difficulty.toUpperCase()}</Text>
                            <Text style={styles.missionMeta}>{mission.duration}</Text>
                          </View>
                          {selected && <Text style={styles.missionSelectedMark}>✓</Text>}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
                {expandedEditorSection === 'task' && draft.task === 'Shake Your Phone' && (
                  <View style={styles.challengeSettings}>
                    <Text style={styles.challengeSettingsLabel}>SHAKE TARGET</Text>
                    <View style={styles.sheetDifficulty}>
                      {[10, 25, 50, 100, 200].map((count) => {
                        const selected = draft.challengeConfig?.type === 'shake_phone'
                          ? draft.challengeConfig.targetCount === count
                          : count === 25;
                        return (
                          <TouchableOpacity
                            key={count}
                            onPress={() => setDraft((current) => ({
                              ...current,
                              challengeConfig: { type: 'shake_phone', targetCount: count as 10 | 25 | 50 | 100 | 200 },
                            }))}
                            style={[styles.sheetDifficultyButton, selected && styles.sheetDifficultySelected]}
                          >
                            <Text style={[styles.sheetDifficultyText, selected && styles.sheetDifficultyTextSelected]}>{count}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                )}
                {expandedEditorSection === 'task' && draft.task === 'Push-up Challenge' && (
                  <View style={styles.challengeSettings}>
                    <Text style={styles.challengeSettingsLabel}>PUSH-UP TARGET</Text>
                    <View style={styles.sheetDifficulty}>
                      {[5, 10, 15, 20].map((count) => {
                        const selected = draft.challengeConfig?.type === 'push_up'
                          ? draft.challengeConfig.targetCount === count
                          : count === 10;
                        return (
                          <TouchableOpacity
                            key={count}
                            onPress={() => setDraft((current) => ({
                              ...current,
                              challengeConfig: { type: 'push_up', targetCount: count as 5 | 10 | 15 | 20 },
                            }))}
                            style={[styles.sheetDifficultyButton, selected && styles.sheetDifficultySelected]}
                          >
                            <Text style={[styles.sheetDifficultyText, selected && styles.sheetDifficultyTextSelected]}>{count}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                )}
                {expandedEditorSection === 'task' && draft.task === 'Object Hunt' && (
                  <View style={styles.challengeSettings}>
                    <Text style={styles.challengeSettingsLabel}>OBJECT HUNT DIFFICULTY</Text>
                    <View style={styles.sheetDifficulty}>
                      {(['easy', 'medium', 'hard'] as const).map((difficulty) => {
                        const selected = draft.challengeConfig?.type === 'object_hunt'
                          ? draft.challengeConfig.difficulty === difficulty
                          : false;
                        return (
                          <TouchableOpacity
                            key={difficulty}
                            onPress={() => setDraft((current) => ({
                              ...current,
                              challengeConfig: {
                                type: 'object_hunt',
                                difficulty,
                                targetObject: huntTargetsForDifficulty(difficulty)[0],
                              },
                            }))}
                            style={[styles.sheetDifficultyButton, selected && styles.sheetDifficultySelected]}
                          >
                            <Text style={[styles.sheetDifficultyText, selected && styles.sheetDifficultyTextSelected]}>{difficulty.toUpperCase()}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    <Text style={styles.challengeSettingsLabel}>SELECT THE TARGET OBJECT</Text>
                    <View style={styles.sheetDifficulty}>
                      {huntTargetsForDifficulty(draft.challengeConfig?.type === 'object_hunt' ? draft.challengeConfig.difficulty : 'easy').map((target) => {
                        const selected = draft.challengeConfig?.type === 'object_hunt'
                          && draft.challengeConfig.targetObject === target;
                        return (
                          <TouchableOpacity
                            key={target}
                            onPress={() => setDraft((current) => ({
                              ...current,
                              challengeConfig: current.challengeConfig?.type === 'object_hunt'
                                ? { ...current.challengeConfig, targetObject: target }
                                : { type: 'object_hunt', difficulty: 'easy', targetObject: target },
                            }))}
                            style={[styles.sheetDifficultyButton, selected && styles.sheetDifficultySelected]}
                          >
                            <Text style={[styles.sheetDifficultyText, selected && styles.sheetDifficultyTextSelected]}>{target.toUpperCase()}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                )}
                {expandedEditorSection === 'task' && draft.task === 'Yell to Stop' && (
                  <View style={styles.challengeSettings}>
                    <Text style={styles.challengeSettingsLabel}>SAY THIS PHRASE TO STOP</Text>
                    <View style={styles.sheetDifficulty}>
                    {(["I'M AWAKE!", 'GOOD MORNING!', "I'M UP!", 'WAKE UP!'] as const).map((phrase) => (
                      <TouchableOpacity
                        key={phrase}
                        onPress={() => setDraft((current) => ({
                          ...current,
                          challengeConfig: { type: 'yell_to_stop', phrase, requiredCompletions: 1 },
                        }))}
                        style={[styles.sheetDifficultyButton, draft.challengeConfig?.type === 'yell_to_stop' && draft.challengeConfig.phrase === phrase && styles.sheetDifficultySelected]}
                      >
                        <Text style={[styles.sheetDifficultyText, draft.challengeConfig?.type === 'yell_to_stop' && draft.challengeConfig.phrase === phrase && styles.sheetDifficultyTextSelected]}>
                          {phrase}
                        </Text>
                      </TouchableOpacity>
                    ))}
                    </View>
                    <Text style={styles.objectPickerHint}>Wayykup must recognize your chosen phrase. Background noise alone never completes this mission.</Text>
                  </View>
                )}
              </View>

              <TouchableOpacity onPress={() => setDraft((current) => ({ ...current, savage: !current.savage }))} style={styles.sheetSavageRow}>
                <View style={styles.sheetSavageIcon}><Text style={styles.sheetSavageGlyph}>↗</Text></View>
                <View style={styles.sheetSavageCopy}><Text style={styles.sheetSavageTitle}>Savage Mode</Text><Text style={styles.sheetSavageSubtitle}>Increase volume after every snooze</Text></View>
                <Switch value={draft.savage} onValueChange={(value) => setDraft((current) => ({ ...current, savage: value }))} trackColor={{ false: '#D8D8DC', true: '#FFB7B7' }} thumbColor={draft.savage ? '#FF1717' : '#FFFFFF'} />
              </TouchableOpacity>
              {editingId && <TouchableOpacity onPress={() => { setAlarms((current) => current.filter((alarm) => alarm.id !== editingId)); closeEditor(); }} style={styles.deleteAlarm}><Text style={styles.deleteText}>DELETE ALARM</Text></TouchableOpacity>}
              <Text style={styles.sheetFootnote}>Your alarm will be saved on this device.</Text>
            </ScrollView>
          </Animated.View>
        </View>
      </Modal>
    );
  };

  const renderRinging = () => (
    <SafeAreaView style={styles.ringingScreen}>
      <View style={styles.ringingTop}>
        <View style={styles.liveAlarmDot} />
        <Text style={styles.ringingStatus}>WAYYKUP ALARM · RINGING</Text>
      </View>
      <View style={styles.ringingCenter}>
        <Text style={styles.ringingEyebrow}>ALARM SOUND · {alarmSoundName(lastAlarm.sound).toUpperCase()}</Text>
        <Text style={styles.ringingTime}>{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>
        <Text style={styles.ringingScheduledTime}>SCHEDULED FOR {formatClock12Hour(lastAlarm.time)}</Text>
        <Text style={styles.ringingTask}>{lastAlarm.task.toUpperCase()} WAKE-UP CHALLENGE</Text>
        <Text style={styles.ringingHint}>Swipe to stop the ringing and start your challenge. The alarm will keep playing while you complete it.</Text>
      </View>
      <GestureDetector gesture={ringingSwipeGesture}>
        <View
          accessibilityRole="button"
          accessibilityActions={[{ name: 'activate', label: 'Start wake-up challenge' }]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'activate') void activateChallengeAfterSwipe();
          }}
          accessibilityLabel="Swipe right to start your wake-up challenge. The alarm will keep ringing."
          style={styles.ringingSwipeTrack}
        >
          <Text style={styles.ringingSwipeLabel}>SWIPE RIGHT TO START</Text>
          <ReanimatedAnimated.View style={[styles.ringingSwipeThumb, ringingSwipeThumbStyle]}>
            <Text style={styles.ringingSwipeGlyph}>››</Text>
          </ReanimatedAnimated.View>
        </View>
      </GestureDetector>
      <Text style={styles.ringingFooter}>CHALLENGE REQUIRED · AUDIO STAYS ON</Text>
    </SafeAreaView>
  );

  const renderWakeSuccess = () => (
    <SafeAreaView style={styles.wakeSuccessScreen}>
      <WayykupIcon size={64} />
      <Text style={styles.wakeSuccessEyebrow}>WAKE-UP VERIFIED</Text>
      <Text style={styles.wakeSuccessTitle}>GOOD MORNING!</Text>
      <Text style={styles.wakeSuccessMessage}>You've completed your wake-up challenge. Time to start your day!</Text>
      <Text style={styles.wakeSuccessDuration}>CHALLENGE TIME · {challengeDurationSeconds} SECONDS</Text>
      {!!statsError && <Text style={styles.wakeSuccessWarning}>{statsError}</Text>}
      <TouchableOpacity
        accessibilityRole="button"
        onPress={() => setScreen('home')}
        style={styles.wakeSuccessButton}
      >
        <Text style={styles.wakeSuccessButtonText}>CONTINUE TO WAYYKUP</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );

  const renderAlarm = () => {
    const challengeConfig = lastAlarm.challengeConfig;
    const huntTarget = challengeConfig.type === 'object_hunt' ? challengeConfig.targetObject : 'your object';
    const yellPhrase = challengeConfig.type === 'yell_to_stop' ? challengeConfig.phrase : "I'M AWAKE!";
    const reshuffleHuntTarget = () => {
      if (
        !activeOccurrenceId.current
        || activeChallengeAlarmId.current !== lastAlarm.id
        || alarmSessionState.current.state !== 'challenge_active'
        || challengeConfig.type !== 'object_hunt'
      ) return;
      const targetObject = chooseHuntTargetForDifficulty(
        challengeConfig.difficulty,
        Math.random,
        challengeConfig.targetObject,
      );
      if (!targetObject) {
        Alert.alert('No alternate target', 'There is no other valid target at this difficulty.');
        return;
      }
      setLastAlarm((current) => (
        current.id !== lastAlarm.id || current.challengeConfig.type !== 'object_hunt'
          ? current
          : { ...current, challengeConfig: { ...current.challengeConfig, targetObject } }
      ));
      setHuntRecognized(false);
      setHuntRecognitionMessage('');
      trackEvent('object_hunt_target_reshuffled', { alarm_id: lastAlarm.id, target: targetObject });
    };
    const allowObjectHuntCamera = () => {
      requestCameraPermission()
        .then((permission) => {
          if (permission.granted) setHuntRecognitionMessage('');
          else setHuntRecognitionMessage('CAMERA ACCESS IS REQUIRED TO RECOGNIZE THE OBJECT.');
        })
        .catch((error: unknown) => {
          console.error('Camera permission request failed for Object Hunt.', error);
          setHuntRecognitionMessage('CAMERA ACCESS IS UNAVAILABLE. CHECK YOUR DEVICE SETTINGS.');
        });
    };
    if (lastAlarm.task === 'Object Hunt') {
      return (
        <ObjectHuntScreen
          alarmTime={lastAlarm.time}
          alarmLabel={lastAlarm.label}
          target={huntTarget}
          difficulty={challengeConfig.type === 'object_hunt' ? challengeConfig.difficulty : 'easy'}
          recognized={huntRecognized}
          permissionGranted={cameraPermission?.granted === true}
          permissionMessage={huntRecognitionMessage}
          onRequestPermission={allowObjectHuntCamera}
          onRecognized={(target) => {
            setHuntRecognized(true);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
              .catch((error: unknown) => console.warn('Object-recognition haptic failed:', error));
            trackEvent('object_hunt_object_recognized', { target });
          }}
          onFailedAttempt={recordChallengeFailure}
          onReshuffle={reshuffleHuntTarget}
        />
      );
    }
    return (
      <SafeAreaView style={styles.alarmScreen}>
        <ScrollView contentContainerStyle={styles.alarmContent} keyboardShouldPersistTaps="handled">
          <View style={styles.alarmScreenTop}><View style={styles.liveAlarmDot} /><Text style={styles.alarmScreenStatus}>WAKE-UP PROTOCOL ACTIVE</Text><Text style={styles.alarmScreenNumber}>01 / 01</Text></View>
          <Text style={styles.alarmBigTime}>{lastAlarm.time}</Text>
          <View style={styles.alarmRule}><View style={styles.ruleAccent} /><Text style={styles.alarmRuleText}>GET UP. GET IT DONE.</Text></View>
          <View style={styles.challengeCard}>
            <View style={styles.challengeHeader}><Text style={styles.challengeLabel}>YOUR CHALLENGE</Text><Tag dark>{lastAlarm.task.toUpperCase()}</Tag></View>
            {lastAlarm.task === 'Push-up Challenge' && (
              <PushUpChallenge
                active={screen === 'alarm'}
                targetCount={challengeConfig.type === 'push_up' ? challengeConfig.targetCount : 10}
                onComplete={() => { void finishChallenge(); }}
                onError={(reason) => setAlarmFallbackReason(reason)}
              />
            )}
            {lastAlarm.task === 'Shake Your Phone' && challengeConfig.type === 'shake_phone' && (
              <View style={styles.challengeBody}>
                <Text style={styles.challengePrompt}>SHAKE IT OFF.</Text>
                <View style={styles.shakeMeter}><View style={[styles.shakeFill, { width: `${Math.min(shakeCount / challengeConfig.targetCount, 1) * 100}%` }]} /></View>
                <Text style={styles.shakeCount}>{String(Math.min(shakeCount, challengeConfig.targetCount)).padStart(2, '0')} <Text style={styles.shakeTotal}>/ {challengeConfig.targetCount}</Text></Text>
                <Text style={styles.simulationNote}>{sensorAvailable ? 'SHAKE YOUR PHONE TO FILL THE METER.' : 'Accelerometer is unavailable on this device.'}</Text>
              </View>
            )}
            {alarmFallbackReason && (
              <Text style={styles.simulationNote}>
                MISSION NEEDS ATTENTION · {alarmFallbackReason === 'alarm_audio_unavailable' && Platform.OS === 'ios'
                  ? 'IOS ALARM AUDIO CANNOT BE MUTED SAFELY'
                  : alarmFallbackReason.replace(/_/g, ' ').toUpperCase()}
              </Text>
            )}
            {lastAlarm.task === 'Yell to Stop' && (
              <YellChallenge
                key={`alarm-${lastAlarm.id}-${yellPhrase}`}
                active={screen === 'alarm'}
                phrase={yellPhrase}
                trackEvent={trackEvent}
                onComplete={() => { void finishChallenge(); }}
                onError={(reason) => setAlarmFallbackReason(reason)}
              />
            )}
          </View>
          <View style={styles.alarmScreenFoot}><WayykupIcon size={18} style={styles.alarmFootMark} /><Text style={styles.alarmFootText}>NO EXIT UNTIL IT’S DONE.</Text></View>
        </ScrollView>
        <StatusBar barStyle="light-content" />
      </SafeAreaView>
    );
  };

  const renderStats = () => {
    const useStreakFreeze = async () => {
      try {
        const protectedDate = await spendFreeze(occurrences);
        if (!protectedDate) {
          Alert.alert('Freeze unavailable', 'No unused freeze or eligible alarm within the last 24 hours was found.');
          return;
        }
        await refreshStats();
      } catch (error) {
        console.error('Streak freeze could not be used.', error);
        Alert.alert('Freeze not saved', 'Wayykup could not protect this day in your local wake history.');
      }
    };
    return (
      <StatsScreen
        occurrences={occurrences}
        freezes={streakFreezes}
        now={now}
        hasAlarms={alarms.length > 0}
        loading={statsLoading}
        error={statsError}
        onRetry={() => { void refreshStats(true); }}
        onSetAlarm={openNewAlarm}
        onHome={() => setScreen('home')}
        onSettings={() => setScreen('settings')}
        indicatorPosition={navIndicatorPosition}
        reduceMotion={reduceMotion}
        onUseFreeze={useStreakFreeze}
      />
    );
  };

  const renderStreakMoment = () => {
    if (!celebration) return renderStats();
    return (
      <StreakMoment
        streak={celebration.streak}
        wakeDurationMs={celebration.wakeDurationMs}
        previousWakeDurationMs={celebration.previousWakeDurationMs}
        occurrenceId={celebration.occurrenceId}
        rating={morningRating}
        reduceMotion={reduceMotion}
        onRate={(rating) => {
          setMorningRatingState(rating);
          setMorningRating(celebration.occurrenceId, rating)
            .then(() => refreshStats())
            .catch((error: unknown) => {
              console.error('Morning wake rating could not be saved.', error);
              Alert.alert('Rating not saved', 'Wayykup could not save your morning rating.');
            });
        }}
        onDone={() => {
          setCelebration(null);
          setScreen('home');
        }}
      />
    );
  };

  const updateKeepAlarmPlayingPreference = async (value: boolean) => {
    const previousValue = keepAlarmPlayingDuringChallenges;
    setKeepAlarmPlayingDuringChallenges(value);
    try {
      await persistKeepAlarmPlayingPreference(value);
    } catch (error) {
      console.error('Alarm playback preference could not be saved.', error);
      setKeepAlarmPlayingDuringChallenges(previousValue);
      Alert.alert('Could not save setting', 'Your alarm playback preference was not changed.');
    }
  };

  const showSettingsNotice = (title: string, message: string) => {
    Alert.alert(title, message);
  };

  const requestSettingsNotifications = async () => {
    try {
      const granted = await requestAlarmNotifications();
      setNotificationsAllowed(granted);
      if (!granted) {
        showSettingsNotice('Notifications are off', 'Allow Wayykup notifications in your device settings so alarms can alert you.');
      }
    } catch (error) {
      console.error('Notification permission could not be requested from Settings.', error);
      showSettingsNotice('Notifications unavailable', 'Wayykup could not check or request notification access.');
    }
  };

  const requestSettingsCamera = async () => {
    try {
      const permission = await requestCameraPermission();
      if (!permission.granted) {
        showSettingsNotice('Camera access is off', 'Allow camera access in your device settings to use Object Hunt or Push-up Challenge.');
      }
    } catch (error) {
      console.error('Camera permission could not be requested from Settings.', error);
      showSettingsNotice('Camera unavailable', 'Wayykup could not check or request camera access.');
    }
  };

  const openBatteryGuidance = () => {
    Alert.alert('Keep alarms reliable', getBatteryRestrictionGuidance(alarmHealth?.deviceModel), [
      { text: 'Not now', style: 'cancel' },
      { text: 'Open app settings', onPress: () => { void openAlarmSettings('battery'); } },
    ]);
  };

  const openAlarmPermissionSettings = () => {
    if (!alarmHealth) {
      void refreshAlarmHealth();
      return;
    }
    if (!alarmHealth.notifications) {
      void requestSettingsNotifications();
    } else if (!alarmHealth.exactAlarm) {
      void openAlarmSettings('exactAlarm');
    } else if (!alarmHealth.fullScreenIntent && alarmHealth.platform === 'android') {
      void openAlarmSettings('fullScreenIntent');
    } else {
      openBatteryGuidance();
    }
  };

  const renderCurrentPlanModal = () => {
    const activeEntitlement = customerInfo?.entitlements.active.wayykup_premium;
    const activePackage = activeEntitlement
      ? availablePackages.find((item) => item.product.identifier === activeEntitlement.productIdentifier
        || item.product.identifier === activeEntitlement.productIdentifier.split(':')[0])
      : undefined;
    const expirationDate = activeEntitlement?.expirationDate
      ? new Date(activeEntitlement.expirationDate).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
      : null;
    const planStatus = activeEntitlement
      ? activeEntitlement.periodType === 'TRIAL'
        ? expirationDate ? `Free trial ends ${expirationDate}.` : 'Your free trial is active.'
        : activeEntitlement.willRenew
          ? expirationDate ? `Renews on ${expirationDate}.` : 'Your subscription renews automatically.'
          : expirationDate ? `Access continues until ${expirationDate}.` : 'Your subscription is active.'
      : 'No active Wayykup Pro subscription was found.';
    const planTitle = activeEntitlement
      ? activePackage?.product.title ?? 'Wayykup Pro'
      : 'No active plan';

    return (
      <Modal
        visible={currentPlanModalVisible}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={closeCurrentPlan}
      >
        <View style={styles.plansModalRoot}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Close current plan"
            activeOpacity={1}
            onPress={closeCurrentPlan}
            style={styles.plansModalBackdrop}
          />
          <View style={[styles.currentPlanSheet, { paddingBottom: Math.max(insets.bottom, 24) }]}>
            <View style={styles.plansSheetHandle} />
            <Text style={styles.currentPlanEyebrow}>YOUR WAYYKUP PLAN</Text>
            <Text style={styles.currentPlanTitle}>{billingBusy && !customerInfo ? 'Checking your plan…' : planTitle}</Text>
            {activeEntitlement && activePackage && (
              <Text style={styles.currentPlanPrice}>
                {activePackage.product.priceString}
                {activePackage.packageType === Purchases.PACKAGE_TYPE.ANNUAL ? ' / year' : ''}
                {activePackage.packageType === Purchases.PACKAGE_TYPE.MONTHLY ? ' / month' : ''}
                {activePackage.packageType === Purchases.PACKAGE_TYPE.WEEKLY ? ' / week' : ''}
              </Text>
            )}
            <Text style={styles.currentPlanStatus}>{planStatus}</Text>
            {billingBusy && <Text style={styles.currentPlanStatus}>Refreshing subscription details…</Text>}
            {!!billingError && <Text accessibilityRole="alert" style={styles.plansError}>{billingError}</Text>}
            {activeEntitlement && customerInfo?.managementURL && (
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => { void openSubscriptionManagement(); }}
                style={styles.currentPlanAction}
              >
                <Text style={styles.currentPlanActionText}>MANAGE SUBSCRIPTION</Text>
              </TouchableOpacity>
            )}
            {!activeEntitlement && REVENUECAT_API_KEY && (
              <TouchableOpacity
                accessibilityRole="button"
                disabled={billingBusy}
                onPress={() => { void restorePurchases(); }}
                style={styles.currentPlanAction}
              >
                <Text style={styles.currentPlanActionText}>RESTORE PURCHASES</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              accessibilityRole="button"
              onPress={closeCurrentPlan}
              style={styles.currentPlanClose}
            >
              <Text style={styles.currentPlanCloseText}>DONE</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  };

  const renderSettings = () => (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.settingsPage} showsVerticalScrollIndicator={false}>
        <Text style={styles.settingsPageTitle}>Settings</Text>
        <View style={styles.settingsGroup}>
          <TouchableOpacity accessibilityRole="button" onPress={() => showSettingsNotice('Appearance', 'Wayykup currently uses its light theme.')} style={styles.settingsListRow}>
            <View style={styles.settingsListIcon}><Text style={styles.settingsListIconText}>◐</Text></View>
            <Text style={styles.settingsListLabel}>Appearance</Text>
            <Text style={styles.settingsListValue}>Light⌄</Text>
          </TouchableOpacity>
          <View style={styles.settingsListDivider} />
          <TouchableOpacity accessibilityRole="button" onPress={() => showSettingsNotice('Language', 'Wayykup is currently available in English.')} style={styles.settingsListRow}>
            <View style={styles.settingsListIcon}><Text style={styles.settingsListIconText}>◎</Text></View>
            <Text style={styles.settingsListLabel}>Language</Text>
            <Text style={styles.settingsListValue}>English⌄</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.settingsSectionLabel}>PERMISSIONS</Text>
        <View style={styles.settingsGroup}>
          <TouchableOpacity accessibilityRole="button" onPress={() => { void requestSettingsNotifications(); }} style={styles.settingsListRow}>
            <View style={styles.settingsListIcon}><Text style={styles.settingsListIconNeutral}>♧</Text></View>
            <Text style={styles.settingsListLabel}>Notifications</Text>
            <Text style={[styles.settingsListStatus, alarmHealth?.notifications && styles.settingsListStatusEnabled]}>{alarmHealth ? alarmHealth.notifications ? 'Enabled' : 'Allow' : 'Checking'}</Text>
          </TouchableOpacity>
          <View style={styles.settingsListDivider} />
          {Platform.OS === 'android' && (
            <>
              <TouchableOpacity accessibilityRole="button" onPress={() => { void openAlarmSettings('exactAlarm'); }} style={styles.settingsListRow}>
                <View style={styles.settingsListIcon}><Text style={styles.settingsListIconNeutral}>◷</Text></View>
                <Text style={styles.settingsListLabel}>Exact alarms</Text>
                <Text style={[styles.settingsListStatus, alarmHealth?.exactAlarm && styles.settingsListStatusEnabled]}>{alarmHealth ? alarmHealth.exactAlarm ? 'Enabled' : 'Allow' : 'Checking'}</Text>
              </TouchableOpacity>
              <View style={styles.settingsListDivider} />
              <TouchableOpacity accessibilityRole="button" onPress={() => { void openAlarmSettings('fullScreenIntent'); }} style={styles.settingsListRow}>
                <View style={styles.settingsListIcon}><Text style={styles.settingsListIconNeutral}>▣</Text></View>
                <Text style={styles.settingsListLabel}>Full-screen alarm</Text>
                <Text style={[styles.settingsListStatus, alarmHealth?.fullScreenIntent && styles.settingsListStatusEnabled]}>{alarmHealth ? alarmHealth.fullScreenIntent ? 'Enabled' : 'Allow' : 'Checking'}</Text>
              </TouchableOpacity>
              <View style={styles.settingsListDivider} />
            </>
          )}
          <TouchableOpacity accessibilityRole="button" onPress={() => { void requestSettingsCamera(); }} style={styles.settingsListRow}>
            <View style={styles.settingsListIcon}><Text style={styles.settingsListIconNeutral}>▣</Text></View>
            <Text style={styles.settingsListLabel}>Camera</Text>
            <Text style={[styles.settingsListStatus, cameraPermission?.granted && styles.settingsListStatusEnabled]}>{cameraPermission ? cameraPermission.granted ? 'Enabled' : 'Allow' : 'Checking'}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.settingsSectionLabel}>ALARM EXPERIENCE</Text>
        <View style={styles.settingsGroup}>
          <TouchableOpacity accessibilityRole="button" onPress={openAlarmPermissionSettings} style={styles.settingsListRow}>
            <View style={styles.settingsListIcon}><Text style={styles.settingsListIconNeutral}>◉</Text></View>
            <View style={styles.settingsListCopy}>
              <Text style={styles.settingsListLabel}>Native alarm status</Text>
              <Text style={styles.settingsListDetail}>
                {alarmHealth?.reliability === 'reduced'
                  ? 'Reduced reliability on this iOS version; notifications cannot provide AlarmKit parity.'
                  : alarmHealth?.canRingNow
                    ? 'Native alarm permissions are ready.'
                    : isNativeAlarmAvailable
                      ? 'Tap to open the permission that is blocking alarms.'
                      : 'Install a development build. Expo Go cannot ring native alarms.'}
              </Text>
            </View>
            <Text style={[styles.settingsListStatus, alarmHealth?.canRingNow && styles.settingsListStatusEnabled]}>
              {alarmHealth?.canRingNow ? 'Ready' : 'Check'}
            </Text>
          </TouchableOpacity>
          <View style={styles.settingsListDivider} />
          <TouchableOpacity accessibilityRole="button" onPress={() => { void beginAlarmTest(); }} style={styles.settingsListRow}>
            <View style={styles.settingsListIcon}><Text style={styles.settingsListIconNeutral}>▶</Text></View>
            <View style={styles.settingsListCopy}>
              <Text style={styles.settingsListLabel}>60-second ring test</Text>
              <Text style={styles.settingsListDetail}>Optional: test a native ring and wake-up challenge on this device.</Text>
            </View>
            <Text style={[styles.settingsListStatus, alarmHealth?.testAlarmPassed && styles.settingsListStatusEnabled]}>
              {alarmHealth?.testAlarmPassed ? 'Passed' : 'Run'}
            </Text>
          </TouchableOpacity>
          <View style={styles.settingsListDivider} />
          <View style={styles.settingsListRow}>
            <View style={styles.settingsListIcon}><Text style={styles.settingsListIconNeutral}>♫</Text></View>
            <View style={styles.settingsListCopy}>
              <Text style={styles.settingsListLabel}>Play through challenges</Text>
              <Text style={styles.settingsListDetail}>Keep alarm audio playing while you complete a wake-up task.</Text>
            </View>
            <Switch
              accessibilityLabel="Keep alarm audio playing during wake-up challenges"
              value={keepAlarmPlayingDuringChallenges ?? true}
              onValueChange={(value) => { void updateKeepAlarmPlayingPreference(value); }}
              trackColor={{ false: '#D8D8DC', true: '#FFB7B7' }}
              thumbColor={keepAlarmPlayingDuringChallenges !== false ? RED : '#FFFFFF'}
            />
          </View>
          <View style={styles.settingsListDivider} />
          <TouchableOpacity accessibilityRole="button" onPress={openBatteryGuidance} style={styles.settingsListRow}>
            <View style={styles.settingsListIcon}><Text style={styles.settingsListIconNeutral}>!</Text></View>
            <View style={styles.settingsListCopy}>
              <Text style={styles.settingsListLabel}>Background battery access</Text>
              <Text style={styles.settingsListDetail}>
                {Platform.OS === 'android' && alarmHealth?.batteryRestricted
                  ? 'Your device may restrict background alarms. View manufacturer-specific steps.'
                  : 'Battery saver and OEM controls can still delay alarms.'}
              </Text>
            </View>
            <Text style={styles.settingsListStatus}>Guide</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.settingsSectionLabel}>YOUR PLAN</Text>
        <View style={styles.settingsGroup}>
          <View style={styles.settingsListRow}>
            <View style={styles.settingsListIcon}><Text style={styles.settingsListIconText}>✳</Text></View>
            <View style={styles.settingsListCopy}>
              <Text style={styles.settingsListLabel}>Wayykup Pro</Text>
              <Text style={styles.settingsListDetail}>
                {hasPremium
                  ? 'View your active subscription and renewal status.'
                  : 'An active subscription is required to unlock Wayykup.'}
              </Text>
            </View>
          </View>
          <TouchableOpacity accessibilityRole="button" onPress={showCurrentPlan} style={styles.settingsManagePlan}>
            <Text style={styles.settingsManagePlanText}>{hasPremium ? 'VIEW CURRENT PLAN' : 'VIEW PLAN STATUS'}  ›</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.settingsSectionLabel}>FEEDBACK</Text>
        <View style={styles.settingsGroup}>
          <TouchableOpacity onPress={() => showSettingsNotice('Leave a Rating', 'App Store and Play Store rating links will be available when Wayykup is published.')} style={styles.settingsListRow}>
            <View style={styles.settingsListIcon}><Text style={styles.settingsListIconNeutral}>☆</Text></View>
            <Text style={styles.settingsListLabel}>Leave a Rating</Text>
          </TouchableOpacity>
          <View style={styles.settingsListDivider} />
          <TouchableOpacity onPress={() => showSettingsNotice('Request a Feature', 'Feature requests are not connected yet.')} style={styles.settingsListRow}>
            <View style={styles.settingsListIcon}><Text style={styles.settingsListIconNeutral}>♧</Text></View>
            <Text style={styles.settingsListLabel}>Request a Feature</Text>
          </TouchableOpacity>
          <View style={styles.settingsListDivider} />
          <TouchableOpacity onPress={() => showSettingsNotice('Support', 'Support contact details will be added soon.')} style={styles.settingsListRow}>
            <View style={styles.settingsListIcon}><Text style={styles.settingsListIconNeutral}>?</Text></View>
            <Text style={styles.settingsListLabel}>Support</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.settingsSectionLabel}>ABOUT</Text>
        <View style={styles.settingsGroup}>
          <TouchableOpacity onPress={() => showSettingsNotice('Privacy Policy', 'The privacy policy will be available when the app is published.')} style={styles.settingsListRow}>
            <View style={styles.settingsListIcon}><Text style={styles.settingsListIconNeutral}>⌑</Text></View>
            <Text style={styles.settingsListLabel}>Privacy Policy</Text>
          </TouchableOpacity>
          <View style={styles.settingsListDivider} />
          <TouchableOpacity onPress={() => showSettingsNotice('Terms of Service', 'The terms of service will be available when the app is published.')} style={styles.settingsListRow}>
            <View style={styles.settingsListIcon}><Text style={styles.settingsListIconNeutral}>▤</Text></View>
            <Text style={styles.settingsListLabel}>Terms of Service</Text>
          </TouchableOpacity>
          <View style={styles.settingsListDivider} />
          <View style={styles.settingsListRow}>
            <View style={styles.settingsListIcon}><WayykupIcon size={26} /></View>
            <Text style={styles.settingsListLabel}>Wayykup</Text>
            <Text style={styles.settingsListStatus}>Version 1.0.0</Text>
          </View>
        </View>
      </ScrollView>
      <GlassNavigationBar
        selected="settings"
        indicatorPosition={navIndicatorPosition}
        reduceMotion={reduceMotion}
        onSelect={(tab) => setScreen(tab === 'alarms' ? 'home' : tab)}
      />
      {Platform.OS === 'web' && <View style={styles.referenceHomeIndicator}><View style={styles.referenceHomeIndicatorLine} /></View>}
      <StatusBar barStyle="dark-content" />
      {renderCurrentPlanModal()}
    </SafeAreaView>
  );

  const renderPlansModal = () => {
    const annualPackage = currentOffering?.annual ?? null;
    const monthlyPackage = currentOffering?.monthly ?? null;
    const selectedPackage = plan === 'yearly' ? annualPackage : monthlyPackage;
    const annualPrice = annualPackage?.product.price;
    const monthlyPrice = monthlyPackage?.product.price;
    const annualDiscount = annualPrice !== undefined && monthlyPrice !== undefined && monthlyPrice > 0
      ? Math.max(0, Math.round((1 - annualPrice / (monthlyPrice * 12)) * 100))
      : null;

    return (
      <Modal
        visible={plansModalVisible}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setPlansModalVisible(false)}
      >
        <View style={styles.plansModalRoot}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Close plan selector"
            activeOpacity={1}
            onPress={() => setPlansModalVisible(false)}
            style={styles.plansModalBackdrop}
          />
          <View style={[styles.plansSheet, { paddingBottom: Math.max(insets.bottom, 20) }]}>
            <View style={styles.plansSheetHandle} />
            {annualPackage && <TouchableOpacity
              accessibilityRole="button"
              onPress={() => setPlan('yearly')}
              style={[styles.plansOption, styles.plansYearly, plan === 'yearly' && styles.plansOptionSelected]}
            >
              <View style={styles.plansBestDeal}>
                <Text style={styles.plansBestDealText}>
                  {annualDiscount ? `BEST DEAL - ${annualDiscount}% OFF` : 'BEST VALUE'}
                </Text>
              </View>
              <View style={styles.plansOptionBody}>
                <View style={styles.plansOptionCopy}>
                  <Text style={styles.plansOptionTitle}>Yearly Plan</Text>
                  <View style={styles.plansPriceLine}>
                    <Text style={styles.plansPrice}>{annualPackage.product.priceString} /yr</Text>
                    {!!annualPackage?.product.pricePerMonthString && (
                      <Text style={styles.plansMonthlyEquivalent}>{annualPackage.product.pricePerMonthString}/mo</Text>
                    )}
                  </View>
                </View>
                <View style={[styles.plansRadio, plan === 'yearly' && styles.plansRadioSelected]}>
                  {plan === 'yearly' && <View style={styles.plansRadioDot} />}
                </View>
              </View>
            </TouchableOpacity>}
            {monthlyPackage && <TouchableOpacity
              accessibilityRole="button"
              onPress={() => setPlan('monthly')}
              style={[styles.plansOption, plan === 'monthly' && styles.plansOptionSelected]}
            >
              <View style={styles.plansOptionBody}>
                <View style={styles.plansOptionCopy}>
                  <Text style={styles.plansOptionTitle}>Monthly Plan</Text>
                  <Text style={styles.plansPrice}>{monthlyPackage.product.priceString} /mo</Text>
                </View>
                <View style={[styles.plansRadio, plan === 'monthly' && styles.plansRadioSelected]}>
                  {plan === 'monthly' && <View style={styles.plansRadioDot} />}
                </View>
              </View>
            </TouchableOpacity>}
            {(!annualPackage || !monthlyPackage) && (
              <>
                <Text accessibilityRole="alert" style={styles.plansError}>
                  Plans are temporarily unavailable. Retry loading the current store offering.
                </Text>
                <TouchableOpacity accessibilityRole="button" onPress={retryRevenueCat} style={styles.proTrialPlans}>
                  <Text style={styles.proTrialPlansText}>Retry</Text>
                </TouchableOpacity>
              </>
            )}
            <View style={styles.plansCancelRow}>
              <Text style={styles.plansCheck}>✓</Text>
              <Text style={styles.plansCancelText}>No commitment, cancel anytime</Text>
            </View>
            {!!billingError && <Text accessibilityRole="alert" style={styles.plansError}>{billingError}</Text>}
            <TouchableOpacity
              accessibilityRole="button"
              disabled={billingBusy || !selectedPackage}
              onPress={() => {
                if (!selectedPackage) return;
                void purchaseSubscription(selectedPackage, undefined, true);
              }}
              style={[styles.plansContinue, (billingBusy || !selectedPackage) && styles.proTrialContinueDisabled]}
            >
              <Text style={styles.plansContinueText}>{billingBusy ? 'Connecting to store…' : 'Continue'}</Text>
              <Text style={styles.plansContinueArrow}>›</Text>
            </TouchableOpacity>
            <Text style={styles.plansCancelNote}>Cancel anytime</Text>
          </View>
        </View>
      </Modal>
    );
  };

  const activeAlarmScreen = screen === 'ringing' || screen === 'alarm' || screen === 'wakeSuccess';
  const startupReady = startupProgressLoaded
    && (billingStatus === 'ready' || (billingStatus === 'error' && localAppUnlocked));
  const visibleScreen = startupProgressLoaded
    && billingStatus === 'ready'
    && !hasPremium
    && screen !== 'welcome'
    && screen !== 'proof'
    && screen !== 'paywall'
    && !activeAlarmScreen
    ? 'paywall'
    : screen;
  const screenContent = (!startupReady && !activeAlarmScreen)
    ? <View style={styles.startupLoading}><WayykupIcon size={88} /></View>
    : startupProgressError && !activeAlarmScreen
      ? (
        <View style={styles.startupLoading}>
          <WayykupIcon size={72} />
          <Text style={styles.startupErrorTitle}>YOUR SAVED SETUP IS SAFE</Text>
          <Text style={styles.startupErrorMessage}>{startupProgressError}</Text>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => {
              setStartupProgressLoaded(false);
              setStartupProgressError('');
              setProgressRetryCount((count) => count + 1);
            }}
            style={styles.startupRetryButton}
          >
            <Text style={styles.startupRetryText}>TRY AGAIN</Text>
          </TouchableOpacity>
        </View>
      )
      : billingStatus === 'error' && !localAppUnlocked && !activeAlarmScreen
        ? (
          <View style={styles.startupLoading}>
            <WayykupIcon size={72} />
            <Text style={styles.startupErrorTitle}>SUBSCRIPTION STATUS UNAVAILABLE</Text>
            <Text style={styles.startupErrorMessage}>{billingError || 'Wayykup must verify your subscription before continuing.'}</Text>
            {Boolean(REVENUECAT_API_KEY) && (
              <>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={retryRevenueCat}
                  style={styles.startupRetryButton}
                >
                  <Text style={styles.startupRetryText}>TRY AGAIN</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => { void restorePurchases(); }}
                  style={styles.startupRestoreButton}
                >
                  <Text style={styles.startupRestoreText}>RESTORE PURCHASES</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )
    : visibleScreen === 'welcome'
    ? <OnboardingFlow onComplete={completeOnboarding} trackEvent={trackEvent} reduceMotion={reduceMotion} />
    : visibleScreen === 'proof'
      ? <SafeAreaView style={styles.safeArea}>{renderProof()}<StatusBar barStyle="dark-content" /></SafeAreaView>
      : visibleScreen === 'paywall'
      ? <View style={[styles.safeArea, { paddingTop: Math.max(insets.top, 12), paddingBottom: Math.max(insets.bottom, 8) }]}>{renderPaywall()}{renderPlansModal()}<StatusBar barStyle="dark-content" /></View>
        : visibleScreen === 'home' || visibleScreen === 'editor'
          ? renderHome()
          : visibleScreen === 'ringing'
            ? renderRinging()
          : visibleScreen === 'alarm'
            ? renderAlarm()
            : visibleScreen === 'wakeSuccess'
              ? renderWakeSuccess()
              : visibleScreen === 'streak'
                ? renderStreakMoment()
                : visibleScreen === 'stats'
                ? renderStats()
                : renderSettings();
  const screenTranslateY = screenEntrance.interpolate({ inputRange: [0, 1], outputRange: [12, 0] });

  return (
    <Animated.View style={[styles.screenTransition, { opacity: screenEntrance, transform: [{ translateY: screenTranslateY }] }]}>
      {screenContent}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screenTransition: { flex: 1 },
  startupLoading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: PAPER },
  startupErrorTitle: { color: INK, fontSize: 13, fontWeight: '900', letterSpacing: 1.1, textAlign: 'center', marginTop: 24 },
  startupErrorMessage: { color: MUTED, fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 10, marginHorizontal: 32 },
  startupRetryButton: { minHeight: 48, minWidth: 150, alignItems: 'center', justifyContent: 'center', backgroundColor: RED, borderRadius: 8, marginTop: 24, paddingHorizontal: 24 },
  startupRetryText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  startupRestoreButton: { minHeight: 42, alignItems: 'center', justifyContent: 'center', marginTop: 8, paddingHorizontal: 20 },
  startupRestoreText: { color: INK, fontSize: 10, fontWeight: '900', letterSpacing: 0.9 },
  safeArea: { flex: 1, backgroundColor: PAPER },
  onboarding: { flex: 1, backgroundColor: PAPER, paddingHorizontal: 26, paddingTop: 16, paddingBottom: 18, justifyContent: 'space-between' },
  onboardingTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  wordmarkLockup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wordmark: { color: INK, fontSize: 17, fontWeight: '900', letterSpacing: 2 },
  wordmarkSmall: { color: INK, fontSize: 16, fontWeight: '900', letterSpacing: 1.7 },
  wordmarkDot: { color: RED },
  tag: { backgroundColor: '#EFEEEA', borderRadius: 4, paddingHorizontal: 9, paddingVertical: 6 },
  tagText: { color: '#65615D', fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  darkTag: { backgroundColor: '#363330' },
  darkTagText: { color: '#F8F6F2' },
  heroGraphic: { height: 236, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  orbit: { width: 218, height: 218, borderWidth: 1, borderColor: '#D9D5D0', borderRadius: 109, alignItems: 'center', justifyContent: 'center' },
  orbitInner: { width: 174, height: 174, borderRadius: 87, backgroundColor: RED, alignItems: 'center', justifyContent: 'center' },
  bolt: { color: '#FFFFFF', fontSize: 76, fontWeight: '300', lineHeight: 82 },
  graphicCaption: { color: '#FFFFFF', fontSize: 8, fontWeight: '800', letterSpacing: 2, marginTop: -4 },
  graphicStamp: { position: 'absolute', right: 25, bottom: 11, height: 57, width: 57, backgroundColor: INK, borderRadius: 29, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '9deg' }] },
  stampText: { color: '#FFFFFF', fontSize: 9, lineHeight: 12, textAlign: 'center', fontWeight: '900', letterSpacing: 1 },
  onboardingCopy: { marginTop: 2, marginBottom: 12 },
  eyebrow: { color: RED, fontSize: 9, fontWeight: '900', letterSpacing: 1.8, marginBottom: 12 },
  onboardingTitle: { color: INK, fontSize: 46, lineHeight: 48, fontWeight: '900', letterSpacing: -2 },
  redText: { color: RED },
  bodyCopy: { color: MUTED, fontSize: 14, lineHeight: 21, marginTop: 11 },
  actionButton: { backgroundColor: RED, minHeight: 58, borderRadius: 5, paddingHorizontal: 19, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  buttonDisabled: { opacity: 0.55 },
  actionText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900', letterSpacing: 1.25 },
  actionArrow: { color: '#FFFFFF', fontSize: 18, fontWeight: '600' },
  secondaryButton: { backgroundColor: '#EBE9E5', justifyContent: 'center' },
  secondaryText: { color: INK },
  compactButton: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 14 },
  compactText: { fontSize: 10, textAlign: 'center' },
  footerNote: { color: '#98938E', textAlign: 'center', fontSize: 8, fontWeight: '800', letterSpacing: 1.7, marginTop: 14 },
  backText: { color: INK, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  proofIntro: { marginTop: 38 },
  sectionTitle: { color: INK, fontSize: 44, lineHeight: 46, fontWeight: '900', letterSpacing: -1.7 },
  proofList: { marginTop: 26, borderTopWidth: 1, borderColor: '#E1DFDA' },
  proofRow: { minHeight: 78, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: '#E1DFDA' },
  proofIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#ECEAE6', alignItems: 'center', justifyContent: 'center', marginRight: 13 },
  proofIconText: { color: RED, fontSize: 21, fontWeight: '700' },
  proofCopy: { flex: 1 },
  proofName: { color: INK, fontSize: 12, fontWeight: '900', letterSpacing: 1 },
  proofDetail: { color: MUTED, fontSize: 11, marginTop: 4 },
  proofIndex: { color: '#ABA7A1', fontSize: 10, fontWeight: '800' },
  onboardingBottom: { marginTop: 14 },
  trialIntroScroll: { flex: 1, backgroundColor: '#F1F0F6' },
  trialIntro: { flexGrow: 1, backgroundColor: '#F1F0F6', paddingHorizontal: 24, paddingTop: 20, paddingBottom: 13, alignItems: 'center' },
  trialIntroCompact: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 },
  trialReminder: { flexGrow: 1, backgroundColor: '#F1F0F6', paddingHorizontal: 33, paddingTop: 10, paddingBottom: 13, alignItems: 'center', justifyContent: 'space-between' },
  trialReminderCompact: { paddingHorizontal: 24, paddingTop: 2, paddingBottom: 8 },
  trialReminderTitle: { width: '100%', color: '#171018', fontFamily: 'Georgia', fontWeight: '700', textAlign: 'center', marginTop: 14 },
  trialReminderArt: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center', minHeight: 200 },
  proTrialScreen: { flexGrow: 1, backgroundColor: '#F1F0F6', paddingHorizontal: 27, paddingTop: 5, paddingBottom: 15, justifyContent: 'space-between' },
  proTrialScreenCompact: { paddingHorizontal: 20, paddingTop: 0, paddingBottom: 8 },
  proTrialHeader: { width: '100%', minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  proTrialRestore: { color: '#171018', fontSize: 13, fontWeight: '600', textDecorationLine: 'underline' },
  proTrialClose: { width: 38, height: 42, alignItems: 'flex-end', justifyContent: 'center' },
  proTrialCloseGlyph: { color: '#171018', fontSize: 32, lineHeight: 36, fontWeight: '300' },
  proTrialContent: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 10, paddingBottom: 12 },
  proTrialAlarmIcon: { width: 76, height: 76, borderRadius: 38, backgroundColor: '#F9A13C', alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  proTrialTitle: { color: '#171018', fontFamily: 'Georgia', fontSize: 35, lineHeight: 40, fontWeight: '700', textAlign: 'center' },
  proTrialPrice: { color: '#171018', fontSize: 16, fontWeight: '700', textAlign: 'center', marginTop: 10 },
  proTrialBilled: { color: '#68636D', fontSize: 12, textAlign: 'center', marginTop: 3 },
  proTrialSectionTitle: { width: '100%', color: '#171018', fontSize: 17, fontWeight: '700', marginTop: 24, marginBottom: 8 },
  proTrialTimeline: { width: '100%', position: 'relative' },
  proTrialTimelineLine: { position: 'absolute', top: 31, bottom: 31, left: 25, width: 2, backgroundColor: '#F2A440' },
  proTrialTimelineRow: { minHeight: 76, flexDirection: 'row', alignItems: 'center' },
  proTrialTimelineIcon: { zIndex: 1, width: 52, height: 52, borderRadius: 26, backgroundColor: '#F3A13C', alignItems: 'center', justifyContent: 'center', marginRight: 13 },
  proTrialTimelineCopy: { flex: 1, paddingVertical: 9 },
  proTrialTimelineTitle: { color: '#171018', fontSize: 14, fontWeight: '700' },
  proTrialTimelineDetail: { color: '#716C76', fontSize: 12, lineHeight: 17, marginTop: 3 },
  proTrialFooter: { width: '100%', alignItems: 'center' },
  proTrialContinueDisabled: { opacity: 0.55 },
  proTrialPlans: { paddingVertical: 10, paddingHorizontal: 16 },
  proTrialPlansText: { color: '#171018', fontSize: 13, fontWeight: '600', textDecorationLine: 'underline' },
  plansModalRoot: { flex: 1, justifyContent: 'flex-end' },
  plansModalBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.48)' },
  plansSheet: { width: '100%', maxWidth: 620, alignSelf: 'center', backgroundColor: '#FFFFFF', borderTopLeftRadius: 25, borderTopRightRadius: 25, paddingHorizontal: 23, paddingTop: 16 },
  currentPlanSheet: { width: '100%', maxWidth: 620, alignSelf: 'center', backgroundColor: '#FFFFFF', borderTopLeftRadius: 25, borderTopRightRadius: 25, paddingHorizontal: 24, paddingTop: 34 },
  currentPlanEyebrow: { color: RED, fontSize: 11, fontWeight: '800', letterSpacing: 1.2, textAlign: 'center', marginTop: 10 },
  currentPlanTitle: { color: INK, fontSize: 26, fontWeight: '800', textAlign: 'center', marginTop: 12 },
  currentPlanPrice: { color: INK, fontSize: 16, fontWeight: '700', textAlign: 'center', marginTop: 8 },
  currentPlanStatus: { color: MUTED, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 10 },
  currentPlanAction: { minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 25, backgroundColor: INK, marginTop: 22 },
  currentPlanActionText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800', letterSpacing: 0.6 },
  currentPlanClose: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  currentPlanCloseText: { color: MUTED, fontSize: 12, fontWeight: '700', letterSpacing: 0.6 },
  plansSheetHandle: { position: 'absolute', top: 8, width: 40, height: 4, borderRadius: 2, backgroundColor: '#E1E1E5', alignSelf: 'center' },
  plansOption: { width: '100%', minHeight: 70, borderRadius: 16, borderWidth: 2, borderColor: '#E8E8EA', backgroundColor: '#FFFFFF', overflow: 'hidden', marginTop: 10 },
  plansOptionSelected: { borderColor: '#F2A21A' },
  plansYearly: { marginTop: 26 },
  plansBestDeal: { minHeight: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F5A20B' },
  plansBestDealText: { color: '#211820', fontSize: 11, fontWeight: '900', letterSpacing: 0.4 },
  plansOptionBody: { flex: 1, minHeight: 66, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 10 },
  plansOptionCopy: { flex: 1, gap: 7 },
  plansOptionTitle: { color: '#171018', fontSize: 16, fontWeight: '700' },
  plansPriceLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  plansPrice: { color: '#171018', fontSize: 15, fontWeight: '800' },
  plansMonthlyEquivalent: { color: '#171018', fontSize: 14, fontWeight: '800' },
  plansRadio: { width: 21, height: 21, borderRadius: 11, borderWidth: 2, borderColor: '#C8C8CC', alignItems: 'center', justifyContent: 'center', marginLeft: 12 },
  plansRadioSelected: { borderColor: '#F2A21A' },
  plansRadioDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: '#F2A21A' },
  plansCancelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 18, marginBottom: 16 },
  plansCheck: { color: '#171018', fontSize: 22, fontWeight: '600', marginRight: 9 },
  plansCancelText: { color: '#171018', fontSize: 14, fontWeight: '700' },
  plansError: { color: '#B3261E', fontSize: 12, textAlign: 'center', marginBottom: 10 },
  plansContinue: { width: '100%', minHeight: 69, borderRadius: 38, backgroundColor: '#171018', alignItems: 'center', justifyContent: 'center', flexDirection: 'row' },
  plansContinueText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  plansContinueArrow: { position: 'absolute', right: 24, color: '#FFFFFF', fontSize: 34, lineHeight: 38, top: 13 },
  plansCancelNote: { color: '#85838A', fontSize: 13, fontWeight: '600', textAlign: 'center', marginTop: 14 },
  giftOfferScreen: { flexGrow: 1, backgroundColor: '#F1F0F6', paddingHorizontal: 28, paddingTop: 16, paddingBottom: 8, justifyContent: 'space-between', alignItems: 'center' },
  giftOfferScreenCompact: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 4 },
  giftOfferHeader: { width: '100%', minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  giftOfferHeaderLabel: { color: MUTED, fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  giftOfferClose: { width: 42, height: 42, borderRadius: 22, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  giftOfferTitle: { width: '100%', color: '#171018', fontFamily: 'Georgia', fontWeight: '700', textAlign: 'center' },
  giftArtworkStage: { width: '100%', maxWidth: 390, minHeight: 230, alignSelf: 'center', justifyContent: 'center', alignItems: 'center' },
  giftSparkle: { position: 'absolute', zIndex: 1, color: '#F1A21B', fontSize: 28, fontWeight: '700' },
  giftSparkleLeft: { left: '12%', top: '25%' },
  giftSparkleRight: { right: '12%', top: '38%', fontSize: 21 },
  giftOfferFooter: { width: '100%', alignItems: 'center' },
  giftOfferTerms: { color: '#55515A', fontSize: 12, lineHeight: 18, textAlign: 'center', marginBottom: 14 },
  giftOfferClaim: { width: '100%', minHeight: 66, borderRadius: 38, backgroundColor: '#E93436', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, shadowColor: '#E93436', shadowOpacity: 0.27, shadowRadius: 13, shadowOffset: { width: 0, height: 6 }, elevation: 5 },
  giftOfferClaimText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  giftOfferError: { color: '#9B2F2F', fontSize: 10, lineHeight: 14, textAlign: 'center', marginTop: 6 },
  giftOfferLegal: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', marginTop: 14, marginBottom: 2 },
  trialTitle: { color: '#171018', fontFamily: 'Georgia', fontWeight: '700', textAlign: 'center' },
  trialPhoneArea: { width: '100%', flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  trialPhone: { maxWidth: 330, maxHeight: 490, borderRadius: 56, borderWidth: 3, borderColor: '#F07A38', backgroundColor: '#09090B', padding: 7, shadowColor: '#181217', shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 8 },
  trialPhoneScreen: { flex: 1, borderRadius: 46, overflow: 'hidden', backgroundColor: '#000000' },
  trialClockPanel: { height: '42%', backgroundColor: '#F1F0F6', paddingHorizontal: '11%' },
  trialStatusBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: '7%' },
  trialStatusTime: { color: '#171018', fontSize: 8, fontWeight: '700' },
  trialStatusIcons: { color: '#171018', fontSize: 7, fontWeight: '800' },
  trialClockContent: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: '8%' },
  trialClockTime: { color: '#171018', fontFamily: 'Georgia', fontSize: 36, lineHeight: 42, fontWeight: '700' },
  trialClockDate: { color: '#77727C', fontSize: 6, marginTop: 6 },
  trialChallengePanel: { flex: 1, backgroundColor: '#000000', alignItems: 'center' },
  trialChallengeTopbar: { width: '82%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: '10%' },
  trialChallengeBack: { color: '#FFFFFF', fontSize: 25, lineHeight: 28 },
  trialChallengeSound: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  trialChallengeTarget: { alignItems: 'center', marginTop: '6%' },
  trialChallengeEmoji: { fontSize: 30, lineHeight: 38 },
  trialChallengeName: { color: '#FFFFFF', fontSize: 13, fontWeight: '700', marginTop: 2 },
  trialScanFrame: { width: '57%', height: '25%', marginTop: '8%' },
  trialScanCorner: { position: 'absolute', width: '40%', height: '45%', borderColor: '#FFFFFF', borderWidth: 2.5 },
  trialScanTopLeft: { top: 0, left: 0, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 11 },
  trialScanTopRight: { top: 0, right: 0, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 11 },
  trialFooter: { width: '100%', alignItems: 'center', paddingTop: 2 },
  trialContinue: { width: '100%', minHeight: 67, borderRadius: 38, backgroundColor: '#211820', alignItems: 'center', justifyContent: 'center', flexDirection: 'row' },
  trialContinueText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  trialContinueArrow: { color: '#FFFFFF', fontSize: 34, lineHeight: 38, position: 'absolute', right: 27, top: 13 },
  trialCancelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 14 },
  trialCheck: { color: '#171018', fontSize: 24, lineHeight: 26, fontWeight: '500', marginRight: 10 },
  trialCancelText: { color: '#171018', fontSize: 14, fontWeight: '600' },
  trialLegalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', marginTop: 14 },
  trialLegalText: { color: '#8E8B94', fontSize: 10, textDecorationLine: 'underline' },
  trialLegalLink: { fontWeight: '600' },
  trialError: { color: '#B3261E', fontSize: 11, textAlign: 'center', marginTop: 5 },
  waterfall: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 28 },
  waterfallHero: { paddingTop: 26, paddingBottom: 18, alignItems: 'center' },
  waterfallIcon: { fontSize: 34, color: RED, marginBottom: 9, textAlign: 'center' },
  waterfallTitle: { color: INK, fontSize: 33, lineHeight: 38, fontWeight: '900', letterSpacing: -1.1, textAlign: 'center' },
  waterfallTimeline: { marginTop: 10, borderRadius: 14, backgroundColor: '#F6F5F3', paddingVertical: 10, paddingHorizontal: 10 },
  waterfallTimelineRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#E6E1DD' },
  waterfallTimelineDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: RED, color: '#FFFFFF', fontSize: 12, lineHeight: 26, fontWeight: '800', textAlign: 'center', marginRight: 10 },
  waterfallTimelineCopy: { flex: 1 },
  waterfallTimelineTitle: { color: INK, fontSize: 12, fontWeight: '800' },
  waterfallTimelineDetail: { color: MUTED, fontSize: 10, lineHeight: 16, marginTop: 3 },
  waterfallActions: { marginTop: 18, gap: 7 },
  terms: { color: '#96918B', fontSize: 9, textAlign: 'center', marginTop: 10 },
  restorePurchases: { alignItems: 'center', padding: 12 },
  restoreText: { color: '#807B75', fontSize: 8, fontWeight: '900', letterSpacing: 1.1 },
  billingError: { color: '#B3261E', fontSize: 10, lineHeight: 15, textAlign: 'center', marginTop: 9 },
  referenceStatusBar: { height: 34, paddingHorizontal: 24, paddingTop: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: PAPER },
  referenceStatusTime: { color: '#111111', fontSize: 15, fontWeight: '700' },
  referenceStatusIcons: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusSignal: { color: INK, fontSize: 12, fontWeight: '900', letterSpacing: -2 },
  statusWifi: { color: INK, fontSize: 16, fontWeight: '900', transform: [{ rotate: '45deg' }] },
  statusBattery: { width: 25, height: 13, borderRadius: 4, backgroundColor: INK, alignItems: 'center', justifyContent: 'center', marginLeft: 1 },
  statusBatteryText: { color: '#FFFFFF', fontSize: 8, fontWeight: '900' },
  referenceHomeScroll: { flex: 1 },
  referenceHome: { flexGrow: 1, paddingTop: 8, paddingBottom: 18 },
  referenceHomeContent: { flex: 1 },
  referenceClockArea: { width: '100%', alignItems: 'center', justifyContent: 'center' },
  referenceAlarmListScroll: { flex: 1 },
  referenceHeader: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  referenceHeaderPill: { minHeight: 40, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 9, borderRadius: 22, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#F2F1F3', shadowColor: '#777777', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 3 }, elevation: 3 },
  referenceHeaderPillCompact: { minHeight: 38, paddingHorizontal: 11, gap: 7 },
  referenceHeaderIcon: { color: INK, fontSize: 20, lineHeight: 22 },
  referenceProfileIcon: { color: INK, fontSize: 22, lineHeight: 22 },
  referenceHeaderLabel: { color: INK, fontSize: 14, fontWeight: '600' },
  referenceHeaderLabelCompact: { fontSize: 12 },
  referenceClockBlock: { alignItems: 'center', marginTop: 26 },
  referenceClock: { color: '#050505', fontSize: 130, lineHeight: 110, fontWeight: '900', letterSpacing: -6, includeFontPadding: false },
  referenceDate: { color: '#77777D', fontSize: 18, lineHeight: 24, fontWeight: '600', marginTop: -1 },
  referenceAddAlarm: { alignItems: 'center', marginTop: 24, marginBottom: 27 },
  referenceAlarmSection: { width: '100%' },
  referenceAlarmSectionHeader: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
  referenceAlarmSectionTitle: { color: INK, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  referenceAddCompact: { minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 15, borderRadius: 22, backgroundColor: RED },
  referenceAddCompactPlus: { color: '#FFFFFF', fontSize: 19, lineHeight: 22, fontWeight: '500' },
  referenceAddCompactLabel: { color: '#FFFFFF', fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  nativeAlarmHealthBanner: { minHeight: 62, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15, paddingVertical: 10, marginTop: 10, borderRadius: 16, backgroundColor: '#FFF5F2', borderWidth: 1, borderColor: '#FFD4CB' },
  nativeAlarmHealthDot: { width: 9, height: 9, borderRadius: 5, marginRight: 11, backgroundColor: RED },
  nativeAlarmHealthCopy: { flex: 1 },
  nativeAlarmHealthTitle: { color: RED, fontSize: 9, fontWeight: '900', letterSpacing: 1.1 },
  nativeAlarmHealthMessage: { color: INK, fontSize: 12, lineHeight: 16, marginTop: 3 },
  nativeAlarmHealthAction: { color: RED, fontSize: 10, fontWeight: '900', letterSpacing: 0.8, marginLeft: 10 },
  alarmSwipeHint: { color: '#8C8B91', fontSize: 11, marginBottom: 12, marginTop: 2 },
  referenceAddCircle: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#FF1717', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FFD2D2', shadowColor: '#FF1717', shadowOpacity: 0.22, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 5 },
  referenceAddPlus: { color: '#FFFFFF', fontSize: 34, lineHeight: 38, fontWeight: '400', marginTop: -2 },
  referenceAddLabel: { color: '#111111', fontSize: 18, fontWeight: '700', marginTop: 7 },
  alarmCardList: { gap: 12 },
  referenceAlarmCard: { backgroundColor: '#FFFFFF', borderRadius: 24, paddingHorizontal: 19, paddingVertical: 0, borderWidth: 1, borderColor: '#F3F3F5', shadowColor: '#707070', shadowOpacity: 0.05, shadowRadius: 18, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  alarmSwipeContainer: { justifyContent: 'center', overflow: 'hidden', backgroundColor: '#FFFFFF' },
  alarmSwipeActionReveal: { position: 'absolute', top: 0, bottom: 0, alignItems: 'stretch', justifyContent: 'center', zIndex: 0 },
  alarmSwipeAction: { flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  alarmSwipeActionButton: { flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', gap: 2 },
  alarmSwipeEdit: { backgroundColor: INK },
  alarmSwipeDelete: { backgroundColor: RED },
  alarmSwipeActionLabel: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  alarmSwipeEditIcon: { color: '#FFFFFF', fontSize: 19, lineHeight: 22, fontWeight: '700' },
  alarmSwipeDeleteIcon: { color: '#FFFFFF', fontSize: 25, lineHeight: 23, fontWeight: '400' },
  referenceAlarmRow: { minHeight: 96, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 2, backgroundColor: '#FFFFFF' },
  referenceAlarmDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E2E2E5' },
  referenceAlarmDetails: { flex: 1, justifyContent: 'center', minWidth: 0, paddingVertical: 12 },
  referenceAlarmTime: { color: '#080808', fontSize: 37, lineHeight: 40, fontWeight: '800', letterSpacing: -1 },
  referenceAlarmMeta: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 3, minWidth: 0 },
  referenceTaskChip: { maxWidth: '57%', minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#FFE9E9', paddingHorizontal: 9, borderRadius: 16 },
  referenceTaskIcon: { color: '#FF1717', fontSize: 15, fontWeight: '800' },
  referenceTaskLabel: { color: '#E71B1B', fontSize: 14, fontWeight: '600' },
  referenceMetaDot: { color: '#929299', fontSize: 15, fontWeight: '700' },
  referenceMetaText: { color: '#77777D', fontSize: 14, flexShrink: 1 },
  referenceToggle: { width: 51, height: 30, borderRadius: 16, backgroundColor: '#D7D7D9', justifyContent: 'center', paddingHorizontal: 3, marginLeft: 8 },
  referenceToggleOn: { backgroundColor: '#FF1717' },
  referenceToggleThumb: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#FFFFFF', shadowColor: '#000000', shadowOpacity: 0.16, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
  referenceToggleThumbOn: { backgroundColor: '#FFFFFF' },
  referenceEmptyCard: { minHeight: 100, borderRadius: 24, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  referenceEmptyText: { color: MUTED, fontSize: 14 },
  referenceHomeIndicator: { height: 30, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 5 },
  referenceHomeIndicatorLine: { width: 139, height: 5, borderRadius: 3, backgroundColor: '#050505' },
  editor: { paddingHorizontal: 23, paddingTop: 10, paddingBottom: 30 },
  editorTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navBack: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#ECEAE6', alignItems: 'center', justifyContent: 'center' },
  navBackText: { color: INK, fontSize: 18, lineHeight: 21 },
  editorTopTitle: { color: INK, fontSize: 9, fontWeight: '900', letterSpacing: 1.6 },
  editorHeading: { color: INK, fontSize: 36, lineHeight: 37, fontWeight: '900', letterSpacing: -1.1, marginTop: 24, marginBottom: 20 },
  timePicker: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: INK, minHeight: 166, borderRadius: 5, marginTop: 10, marginBottom: 20 },
  timeUnit: { alignItems: 'center', width: 98 },
  timeAdjust: { width: 31, height: 27, alignItems: 'center', justifyContent: 'center' },
  adjustText: { color: '#98948F', fontSize: 18, fontWeight: '500' },
  timeDigit: { color: '#FFFFFF', fontSize: 48, lineHeight: 54, fontWeight: '900', letterSpacing: -1 },
  timeUnitLabel: { color: '#8B8781', fontSize: 7, fontWeight: '900', letterSpacing: 1.4, marginTop: 4 },
  timeColon: { color: RED, fontSize: 39, fontWeight: '800', marginTop: -10 },
  editorSection: { marginBottom: 19 },
  editorSectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 9 },
  editorLabel: { color: INK, fontSize: 9, fontWeight: '900', letterSpacing: 1.3 },
  editorHint: { color: '#9B9690', fontSize: 7, fontWeight: '800', letterSpacing: 1 },
  daysRow: { flexDirection: 'row', justifyContent: 'space-between' },
  dayButton: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#ECEAE6', alignItems: 'center', justifyContent: 'center' },
  daySelected: { backgroundColor: INK },
  dayText: { color: '#77736D', fontSize: 10, fontWeight: '900' },
  dayTextSelected: { color: '#FFFFFF' },
  taskOption: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 9, minHeight: 55, borderWidth: 1, borderColor: '#E4E1DC', borderRadius: 4, backgroundColor: '#FFFFFF', marginBottom: 6 },
  taskOptionSelected: { borderColor: RED, backgroundColor: '#FFFAF9' },
  taskIconBox: { width: 33, height: 33, borderRadius: 4, backgroundColor: '#F0EEEA', alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  taskIconSelected: { backgroundColor: '#FBE8E5' },
  taskOptionIcon: { color: '#79756F', fontSize: 16, fontWeight: '800' },
  taskIconRed: { color: RED },
  taskOptionCopy: { flex: 1 },
  taskOptionTitle: { color: INK, fontSize: 11, fontWeight: '900' },
  taskOptionDetail: { color: MUTED, fontSize: 9, marginTop: 3 },
  difficultyGroup: { marginTop: 3 },
  difficultyOptions: { flexDirection: 'row', gap: 7, marginTop: 7 },
  difficultyButton: { flex: 1, minHeight: 34, borderRadius: 4, backgroundColor: '#ECEAE6', alignItems: 'center', justifyContent: 'center' },
  difficultySelected: { backgroundColor: INK },
  difficultyText: { color: '#706C66', fontSize: 8, fontWeight: '900', letterSpacing: 0.8 },
  difficultyTextSelected: { color: '#FFFFFF' },
  objectPickerPanel: { padding: 10, backgroundColor: '#F1EFEB', borderRadius: 4, marginTop: 2 },
  objectPickerHint: { color: MUTED, fontSize: 9, lineHeight: 14, marginBottom: 8 },
  huntItemGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  huntItemOption: { width: '23%', minHeight: 54, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#D5D1D8', borderRadius: 7, backgroundColor: '#FFFFFF', paddingHorizontal: 2 },
  huntItemOptionSelected: { borderColor: '#168A4A', backgroundColor: '#E8F8EE' },
  huntItemEmoji: { fontSize: 18 },
  huntItemName: { color: '#706C66', fontSize: 7, fontWeight: '700', marginTop: 2, textAlign: 'center' },
  huntItemNameSelected: { color: '#116B3A' },
  huntItemCheck: { position: 'absolute', top: 2, right: 4, color: '#168A4A', fontSize: 9, fontWeight: '900' },
  soundOptions: { flexDirection: 'row', gap: 7 },
  soundOption: { flex: 1, minHeight: 37, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ECEAE6', borderRadius: 4 },
  soundSelected: { backgroundColor: INK },
  soundText: { color: '#706C66', fontSize: 8, fontWeight: '900' },
  soundTextSelected: { color: '#FFFFFF' },
  savageToggle: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#ECEAE6', borderRadius: 5, paddingHorizontal: 10, paddingVertical: 9, marginBottom: 17 },
  savageIcon: { width: 32, height: 32, backgroundColor: INK, borderRadius: 4, alignItems: 'center', justifyContent: 'center', marginRight: 9 },
  savageIconText: { color: RED, fontSize: 17, fontWeight: '900' },
  savageCopy: { flex: 1 },
  savageTitle: { color: INK, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  savageDetail: { color: MUTED, fontSize: 8, marginTop: 4 },
  deleteAlarm: { alignItems: 'center', padding: 13, marginTop: 2 },
  deleteText: { color: RED, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  editorFootnote: { color: '#A09B95', textAlign: 'center', fontSize: 8, marginTop: 9 },
  editorModal: { flex: 1, justifyContent: 'flex-end' },
  editorBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.42)' },
  alarmSheet: { height: '90%', maxHeight: 820, width: '100%', maxWidth: 620, alignSelf: 'center', backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden', paddingTop: 9 },
  sheetHandle: { width: 38, height: 4, borderRadius: 2, backgroundColor: '#D5D5D8', alignSelf: 'center', marginBottom: 8 },
  sheetHeader: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, borderBottomWidth: 1, borderBottomColor: '#F0F0F2' },
  sheetHeaderButton: { width: 62, paddingVertical: 8 },
  sheetCancel: { color: '#6E6E75', fontSize: 15, fontWeight: '500' },
  sheetTitle: { color: '#19191D', fontSize: 17, fontWeight: '700' },
  sheetAdd: { color: '#FF1717', fontSize: 15, fontWeight: '700', textAlign: 'right' },
  sheetContent: { paddingHorizontal: 22, paddingTop: 12, paddingBottom: 26 },
  wheelPicker: { height: 210, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#F7F7F9', borderRadius: 16, overflow: 'hidden', marginBottom: 20 },
  wheelColumn: { width: 68, height: 210, overflow: 'hidden' },
  wheelRow: { height: 42, alignItems: 'center', justifyContent: 'center' },
  wheelText: { color: '#C3C3C8', fontSize: 19, fontWeight: '500', fontVariant: ['tabular-nums'] },
  wheelTextSelected: { color: '#19191D', fontSize: 23, fontWeight: '700' },
  wheelColon: { color: '#19191D', fontSize: 23, fontWeight: '600', marginHorizontal: 3 },
  wheelSelection: { position: 'absolute', top: 84, left: 12, right: 12, height: 42, backgroundColor: '#EBEBEF', borderRadius: 10 },
  sheetSection: { marginBottom: 17 },
  sheetSectionTitle: { color: '#202024', fontSize: 16, fontWeight: '700', marginBottom: 10 },
  sheetDaysRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 7 },
  sheetDay: { flex: 1, height: 40, borderRadius: 20, backgroundColor: '#F1F1F3', alignItems: 'center', justifyContent: 'center' },
  sheetDaySelected: { backgroundColor: '#FF1717' },
  sheetDayText: { color: '#7D7D83', fontSize: 13, fontWeight: '600' },
  sheetDayTextSelected: { color: '#FFFFFF' },
  sheetOptionRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, backgroundColor: '#F7F7F9', borderRadius: 13 },
  sheetOptionDivider: { marginTop: 8 },
  sheetOptionIcon: { width: 38, height: 38, borderRadius: 11, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  sheetOptionGlyph: { color: '#FF1717', fontSize: 19, fontWeight: '700' },
  sheetOptionCopy: { flex: 1 },
  sheetOptionTitle: { color: '#202024', fontSize: 14, fontWeight: '700' },
  sheetOptionSubtitle: { color: '#818188', fontSize: 12, marginTop: 3 },
  sheetChevron: { color: '#99999F', fontSize: 23, paddingHorizontal: 5 },
  sheetInlineOptions: { marginHorizontal: 12, backgroundColor: '#F7F7F9', borderBottomLeftRadius: 12, borderBottomRightRadius: 12, paddingHorizontal: 12 },
  sheetInlineOption: { minHeight: 43, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: '#E8E8EB' },
  missionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, paddingTop: 10 },
  missionCard: { width: '48%', minHeight: 158, borderWidth: 1, borderColor: '#E5E8E5', borderRadius: 16, padding: 11, backgroundColor: '#FFFFFF', position: 'relative' },
  missionCardSelected: { borderColor: '#218B57', borderWidth: 2, backgroundColor: '#F0FAF4' },
  missionCardUnavailable: { opacity: 0.58 },
  missionIconWrap: { width: 36, height: 36, borderRadius: 12, backgroundColor: '#F0F3F0', alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  missionIconWrapSelected: { backgroundColor: '#DDF3E5' },
  missionIcon: { color: '#404742', fontSize: 22, fontWeight: '800' },
  missionIconSelected: { color: '#16814B' },
  missionTitle: { color: INK, fontSize: 10, fontWeight: '900', letterSpacing: 0.3 },
  missionDescription: { color: MUTED, fontSize: 9, lineHeight: 13, marginTop: 4, minHeight: 25 },
  missionMetaRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  missionMeta: { color: '#6E776F', fontSize: 7, fontWeight: '900', letterSpacing: 0.35 },
  missionSelectedMark: { position: 'absolute', top: 10, right: 10, color: '#16814B', fontWeight: '900', fontSize: 15 },
  challengeSettings: { backgroundColor: '#F8FAF8', borderRadius: 12, marginTop: 9, paddingVertical: 10 },
  challengeSettingsLabel: { color: '#555E57', fontSize: 8, fontWeight: '900', letterSpacing: 1, paddingHorizontal: 12 },
  legacyChallengeNotice: { backgroundColor: '#FFF7E6', borderRadius: 11, marginTop: 9, padding: 12 },
  legacyChallengeNoticeTitle: { color: '#8C5C00', fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },
  legacyChallengeNoticeBody: { color: '#6F5E3F', fontSize: 10, lineHeight: 15, marginTop: 5 },
  sheetInlineText: { color: '#55555B', fontSize: 13 },
  soundPreviewButton: { color: '#FF1717', fontSize: 12, fontWeight: '800' },
  sheetInlineTextSelected: { color: '#FF1717', fontWeight: '700' },
  sheetInlineCheck: { color: '#FF1717', fontSize: 17, fontWeight: '700' },
  sheetDifficulty: { flexDirection: 'row', gap: 8, paddingTop: 10, paddingHorizontal: 12 },
  sheetDifficultyButton: { flex: 1, minHeight: 35, borderRadius: 9, backgroundColor: '#F1F1F3', alignItems: 'center', justifyContent: 'center' },
  sheetDifficultySelected: { backgroundColor: '#FF1717' },
  sheetDifficultyText: { color: '#66666D', fontSize: 12, fontWeight: '600' },
  sheetDifficultyTextSelected: { color: '#FFFFFF' },
  sheetSavageRow: { minHeight: 70, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, backgroundColor: '#FFF5F5', borderRadius: 13, marginBottom: 9 },
  sheetSavageIcon: { width: 38, height: 38, borderRadius: 11, backgroundColor: '#FFE2E2', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  sheetSavageGlyph: { color: '#FF1717', fontSize: 19, fontWeight: '800' },
  sheetSavageCopy: { flex: 1 },
  sheetSavageTitle: { color: '#202024', fontSize: 14, fontWeight: '700' },
  sheetSavageSubtitle: { color: '#818188', fontSize: 11, marginTop: 3 },
  sheetFootnote: { color: '#A1A1A6', fontSize: 11, textAlign: 'center', marginTop: 9 },
  ringingScreen: { flex: 1, backgroundColor: INK, paddingHorizontal: 26, paddingTop: 18, paddingBottom: 24, justifyContent: 'space-between' },
  ringingTop: { minHeight: 38, flexDirection: 'row', alignItems: 'center' },
  ringingStatus: { color: '#FFFFFF', fontSize: 10, fontWeight: '900', letterSpacing: 1.3 },
  ringingCenter: { alignItems: 'center', justifyContent: 'center', flex: 1 },
  ringingEyebrow: { color: '#FF8585', fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  ringingTime: { color: '#FFFFFF', fontSize: 70, lineHeight: 82, fontWeight: '900', letterSpacing: -2, marginTop: 14 },
  ringingScheduledTime: { color: '#C9C4C4', fontSize: 10, fontWeight: '800', letterSpacing: 1.2, marginTop: 1 },
  ringingTask: { color: '#FF2727', fontSize: 15, fontWeight: '900', letterSpacing: 1.2, marginTop: 14 },
  ringingHint: { color: '#C9C4C4', fontSize: 14, lineHeight: 21, textAlign: 'center', marginHorizontal: 16, marginTop: 18 },
  ringingSwipeTrack: { height: 66, borderRadius: 33, backgroundColor: '#34312F', justifyContent: 'center', marginBottom: 8, paddingHorizontal: 6 },
  ringingSwipeLabel: { color: '#B9B4B1', fontSize: 10, fontWeight: '900', letterSpacing: 1.2, textAlign: 'center' },
  ringingSwipeThumb: { position: 'absolute', left: 6, width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center', backgroundColor: RED },
  ringingSwipeGlyph: { color: '#FFFFFF', fontSize: 26, fontWeight: '900', letterSpacing: -5, marginRight: 4 },
  ringingFooter: { color: '#8C8683', fontSize: 8, fontWeight: '900', letterSpacing: 1.2, textAlign: 'center', marginBottom: 8 },
  wakeSuccessScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: PAPER, paddingHorizontal: 30, paddingVertical: 28 },
  wakeSuccessEyebrow: { color: RED, fontSize: 10, fontWeight: '900', letterSpacing: 1.8, marginTop: 26 },
  wakeSuccessTitle: { color: INK, fontSize: 40, fontWeight: '900', letterSpacing: -1.5, marginTop: 9 },
  wakeSuccessMessage: { color: MUTED, fontSize: 15, lineHeight: 23, textAlign: 'center', marginTop: 12, maxWidth: 310 },
  wakeSuccessDuration: { color: INK, fontSize: 10, fontWeight: '900', letterSpacing: 1.1, marginTop: 24 },
  wakeSuccessWarning: { color: RED, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 14 },
  wakeSuccessButton: { alignSelf: 'stretch', minHeight: 56, alignItems: 'center', justifyContent: 'center', backgroundColor: RED, borderRadius: 6, marginTop: 38, paddingHorizontal: 18 },
  wakeSuccessButtonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900', letterSpacing: 1.1 },
  huntScreen: { flex: 1, backgroundColor: '#F6F8F5' },
  huntScreenContent: { flexGrow: 1, width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 22, paddingTop: 12, paddingBottom: 28 },
  huntMissionTop: { alignItems: 'center', paddingBottom: 21 },
  huntLiveIndicator: { minHeight: 28, flexDirection: 'row', alignItems: 'center', alignSelf: 'center', paddingHorizontal: 11, borderRadius: 20, backgroundColor: '#E8F4EB' },
  huntLiveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#23834E', marginRight: 7 },
  huntLiveText: { color: '#28764A', fontSize: 9, fontWeight: '900', letterSpacing: 0.9 },
  huntMissionEyebrow: { color: '#7A827B', fontSize: 9, fontWeight: '900', letterSpacing: 1.7, marginTop: 13 },
  huntMissionTime: { color: '#202922', fontSize: 45, lineHeight: 52, fontWeight: '800', letterSpacing: -1.7, marginTop: 1, fontVariant: ['tabular-nums'] },
  huntAlarmLabel: { color: '#68726A', fontSize: 12, fontWeight: '600', marginTop: 1 },
  huntMissionMessage: { color: '#777F79', fontSize: 12, textAlign: 'center', marginTop: 6 },
  huntChallengeHeading: { flexDirection: 'row', alignItems: 'center', marginBottom: 15 },
  huntChallengeIcon: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: '#E1F1E5', marginRight: 12 },
  huntChallengeIconGlyph: { color: '#218B57', fontSize: 32, lineHeight: 36, fontWeight: '500' },
  huntChallengeHeadingCopy: { flex: 1 },
  huntChallengeTitle: { color: '#202922', fontSize: 20, fontWeight: '900', letterSpacing: 0.1 },
  huntChallengeSubtitle: { color: '#737D75', fontSize: 12, marginTop: 3 },
  huntTargetCard: { overflow: 'hidden', flexDirection: 'row', alignItems: 'stretch', minHeight: 154, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E7ECE7', borderRadius: 22, shadowColor: '#26372B', shadowOffset: { width: 0, height: 7 }, shadowOpacity: 0.07, shadowRadius: 16, elevation: 3 },
  huntTargetVisual: { width: '37%', minHeight: 154, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EAF5EC', padding: 10 },
  huntTargetArtwork: { fontSize: 56, lineHeight: 68, textAlign: 'center' },
  huntDifficultyPill: { minHeight: 22, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, marginTop: 8, borderRadius: 12, backgroundColor: '#D5EBDD' },
  huntDifficultyText: { color: '#28764A', fontSize: 8, fontWeight: '900', letterSpacing: 0.55 },
  huntTargetDetails: { flex: 1, justifyContent: 'center', paddingVertical: 15, paddingHorizontal: 15 },
  huntTargetEyebrow: { color: '#89928A', fontSize: 8, fontWeight: '900', letterSpacing: 1.4 },
  huntTargetName: { color: '#202922', fontSize: 19, lineHeight: 24, fontWeight: '900', letterSpacing: -0.3, marginTop: 3 },
  huntTargetInstructions: { color: '#727A73', fontSize: 11, lineHeight: 16, marginTop: 5 },
  huntChangeTarget: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginTop: 10, paddingVertical: 5, paddingRight: 7 },
  huntChangeTargetIcon: { color: '#218B57', fontSize: 15, fontWeight: '800', marginRight: 5 },
  huntChangeTargetText: { color: '#218B57', fontSize: 9, fontWeight: '900', letterSpacing: 0.65 },
  huntScannerSection: { marginTop: 21 },
  huntScannerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  huntScannerTitle: { color: '#313A33', fontSize: 10, fontWeight: '900', letterSpacing: 1.1 },
  huntScannerStep: { color: '#8B938C', fontSize: 8, fontWeight: '800', letterSpacing: 0.6 },
  huntViewfinder: { height: 220, overflow: 'hidden', position: 'relative', backgroundColor: '#DDE6DE', borderRadius: 20, borderWidth: 1, borderColor: '#E2E9E3' },
  huntCameraPreview: { flex: 1 },
  huntViewfinderOverlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  huntCorner: { position: 'absolute', width: 26, height: 26, borderColor: '#FFFFFF', borderWidth: 3 },
  huntCornerTopLeft: { left: 15, top: 15, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 8 },
  huntCornerTopRight: { right: 15, top: 15, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 8 },
  huntCornerBottomLeft: { left: 15, bottom: 15, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 8 },
  huntCornerBottomRight: { right: 15, bottom: 15, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 8 },
  huntAimGuide: { width: '55%', height: 104, alignItems: 'center', justifyContent: 'flex-end', borderWidth: 1, borderColor: '#FFFFFF99', borderRadius: 18, paddingBottom: 8, backgroundColor: '#FFFFFF12' },
  huntAimGuideText: { color: '#FFFFFF', fontSize: 8, fontWeight: '900', letterSpacing: 1.2, textShadowColor: '#00000099', textShadowRadius: 4 },
  huntScanLine: { position: 'absolute', top: 8, left: 25, right: 25, height: 2, borderRadius: 2, backgroundColor: '#8CF0AE', shadowColor: '#8CF0AE', shadowOpacity: 0.9, shadowRadius: 8, elevation: 3 },
  huntCameraStatus: { position: 'absolute', top: 13, alignSelf: 'center', minHeight: 24, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 9, borderRadius: 13, backgroundColor: '#17221BCC' },
  huntCameraStatusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#F2C36B', marginRight: 6 },
  huntCameraStatusDotReady: { backgroundColor: '#74D997' },
  huntCameraStatusText: { color: '#FFFFFF', fontSize: 8, fontWeight: '900', letterSpacing: 0.65 },
  huntScanButton: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: '#218B57', marginTop: 11, paddingHorizontal: 16, shadowColor: '#187345', shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.18, shadowRadius: 9, elevation: 3 },
  huntScanButtonDisabled: { opacity: 0.6 },
  huntScanButtonIcon: { color: '#FFFFFF', fontSize: 23, lineHeight: 25, fontWeight: '700', marginRight: 9 },
  huntScanButtonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  huntRetryNotice: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 9, marginTop: 10, borderRadius: 13, backgroundColor: '#FFF5E8', borderWidth: 1, borderColor: '#F5E3CB' },
  huntRetryIcon: { color: '#A96720', fontSize: 18, fontWeight: '800', marginRight: 8 },
  huntRetryText: { flex: 1, color: '#85551F', fontSize: 10, lineHeight: 15, fontWeight: '700' },
  huntPermissionMessage: { color: '#A35C2A', fontSize: 10, lineHeight: 15, textAlign: 'center', marginTop: 8 },
  huntCameraPlaceholder: { minHeight: 220, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 18, borderRadius: 20, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E7ECE7' },
  huntPlaceholderIcon: { width: 54, height: 54, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: '#EAF5EC' },
  huntPlaceholderGlyph: { color: '#218B57', fontSize: 36, lineHeight: 40 },
  huntPlaceholderTitle: { color: '#29332C', fontSize: 15, fontWeight: '800', marginTop: 10 },
  huntPlaceholderMessage: { color: '#768078', fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: 4, maxWidth: 270 },
  huntSuccessCard: { minHeight: 220, alignItems: 'center', justifyContent: 'center', padding: 24, borderRadius: 20, backgroundColor: '#EAF6ED', borderWidth: 1, borderColor: '#CDE8D4' },
  huntSuccessIcon: { width: 58, height: 58, alignItems: 'center', justifyContent: 'center', borderRadius: 29, backgroundColor: '#218B57' },
  huntSuccessCheck: { color: '#FFFFFF', fontSize: 34, lineHeight: 40, fontWeight: '800' },
  huntSuccessTitle: { color: '#1C7547', fontSize: 13, fontWeight: '900', letterSpacing: 1.1, marginTop: 13 },
  huntSuccessMessage: { color: '#536B5A', fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 5 },
  huntKeepRinging: { flexDirection: 'row', alignItems: 'center', marginTop: 18, paddingHorizontal: 13, paddingVertical: 12, borderRadius: 15, backgroundColor: '#EDF2EE' },
  huntKeepRingingIcon: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: '#DFEAE1', marginRight: 10 },
  huntKeepRingingGlyph: { color: '#497357', fontSize: 15, fontWeight: '800' },
  huntKeepRingingText: { flex: 1, color: '#657168', fontSize: 10, lineHeight: 15, fontWeight: '600' },
  alarmScreen: { flex: 1, backgroundColor: RED },
  alarmContent: { flexGrow: 1, backgroundColor: RED, paddingHorizontal: 22, paddingTop: 18, paddingBottom: 22 },
  alarmScreenTop: { flexDirection: 'row', alignItems: 'center' },
  liveAlarmDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#FFFFFF', marginRight: 7 },
  alarmScreenStatus: { color: '#FFFFFF', fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  alarmScreenNumber: { color: '#FFD4CE', fontSize: 8, fontWeight: '800', marginLeft: 'auto' },
  alarmBigTime: { color: '#FFFFFF', fontSize: 76, lineHeight: 90, fontWeight: '900', letterSpacing: -3, marginTop: 23 },
  alarmRule: { flexDirection: 'row', alignItems: 'center', marginBottom: 17 },
  ruleAccent: { width: 19, height: 2, backgroundColor: '#FFFFFF', marginRight: 8 },
  alarmRuleText: { color: '#FFE7E3', fontSize: 8, fontWeight: '900', letterSpacing: 1.5 },
  challengeCard: { backgroundColor: INK, borderRadius: 5, paddingHorizontal: 15, paddingTop: 13, paddingBottom: 15 },
  challengeHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 10, borderBottomWidth: 1, borderColor: '#393633' },
  challengeLabel: { color: '#A9A49D', fontSize: 8, fontWeight: '900', letterSpacing: 1.4 },
  challengeBody: { alignItems: 'center', paddingTop: 15 },
  challengePrompt: { color: '#F5F2ED', fontSize: 17, lineHeight: 20, textAlign: 'center', fontWeight: '900', letterSpacing: 0.3 },
  shakeMeter: { width: '100%', height: 9, borderRadius: 5, backgroundColor: '#373431', overflow: 'hidden', marginTop: 25 },
  shakeFill: { height: 9, backgroundColor: RED, borderRadius: 5 },
  shakeCount: { color: '#FFFFFF', fontSize: 32, fontWeight: '900', marginVertical: 12 },
  shakeTotal: { color: '#918C85', fontSize: 15, fontWeight: '700' },
  shakeButton: { width: '100%', minHeight: 61, backgroundColor: RED, borderRadius: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  cameraButtonDisabled: { opacity: 0.55 },
  shakeButtonIcon: { color: '#FFFFFF', fontSize: 19, marginRight: 8 },
  shakeButtonText: { color: '#FFFFFF', fontSize: 9, fontWeight: '900', letterSpacing: 1.1 },
  simulationNote: { color: '#8D8881', fontSize: 8, marginTop: 12, marginBottom: 13, textAlign: 'center' },
  alarmScreenFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 'auto', paddingTop: 17 },
  alarmFootMark: { marginRight: 7 },
  alarmFootText: { color: '#FFDAD4', fontSize: 8, fontWeight: '900', letterSpacing: 1.5 },
  statsOverview: { flex: 1, paddingHorizontal: 24, paddingTop: 46 },
  statsPageTitle: { color: INK, fontSize: 32, lineHeight: 39, fontWeight: '800', letterSpacing: -0.8 },
  statsEmptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 48 },
  statsEmptyTitle: { color: INK, fontSize: 20, fontWeight: '700', marginTop: 18 },
  statsEmptyDescription: { color: MUTED, fontSize: 14, textAlign: 'center', marginTop: 7 },
  statsStreakOverview: { marginTop: 30 },
  statsStreakCard: { minHeight: 128, flexDirection: 'row', alignItems: 'center', backgroundColor: INK, borderRadius: 16, paddingHorizontal: 22, paddingVertical: 18, marginTop: 12 },
  statsStreakIcon: { fontSize: 42, marginRight: 18 },
  statsStreakCopy: { flex: 1 },
  statsStreakValue: { color: '#FFFFFF', fontSize: 42, lineHeight: 46, fontWeight: '900', letterSpacing: -1.5 },
  statsStreakLabel: { color: '#FFC2B8', fontSize: 10, fontWeight: '900', letterSpacing: 1.4, marginTop: 1 },
  statsStreakDetail: { color: '#D5D1CE', fontSize: 11, marginTop: 8 },
  statsStreakNote: { color: MUTED, fontSize: 13, lineHeight: 19, marginTop: 13, paddingHorizontal: 4 },
  statsScreen: { flexGrow: 1, paddingHorizontal: 23, paddingTop: 10, paddingBottom: 27 },
  statsTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statsHero: { alignItems: 'center', marginTop: 36 },
  defeatedSeal: { width: 76, height: 76, backgroundColor: '#FBE8E5', borderRadius: 38, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  defeatedCheck: { color: RED, fontSize: 34, fontWeight: '700' },
  statsTitle: { color: INK, fontSize: 46, lineHeight: 47, fontWeight: '900', letterSpacing: -1.7, textAlign: 'center' },
  statsDescription: { color: MUTED, fontSize: 12, textAlign: 'center', marginTop: 9, marginBottom: 20 },
  statsMetrics: { flexDirection: 'row', gap: 9, marginTop: 2 },
  metricCard: { flex: 1, minHeight: 93, backgroundColor: INK, borderRadius: 5, justifyContent: 'center', paddingHorizontal: 12 },
  metricRed: { backgroundColor: RED },
  metricValue: { color: '#FFFFFF', fontSize: 27, fontWeight: '900', letterSpacing: -1 },
  metricLabel: { color: '#CCC7C0', fontSize: 7, fontWeight: '900', letterSpacing: 0.9, marginTop: 8 },
  statsQuote: { backgroundColor: '#ECEAE6', borderRadius: 5, paddingHorizontal: 16, paddingVertical: 15, marginTop: 13, marginBottom: 19 },
  quoteMark: { color: RED, fontSize: 29, lineHeight: 26, fontWeight: '900' },
  quoteText: { color: INK, fontSize: 14, lineHeight: 20, fontWeight: '800', marginTop: 3 },
  quoteCredit: { color: '#8A857F', fontSize: 7, fontWeight: '900', letterSpacing: 1.3, marginTop: 11 },
  settings: { flexGrow: 1, paddingHorizontal: 23, paddingTop: 10, paddingBottom: 30 },
  settingsPage: { flexGrow: 1, paddingHorizontal: 18, paddingTop: 45, paddingBottom: 28 },
  settingsPageTitle: { color: INK, fontSize: 36, lineHeight: 43, fontWeight: '900', letterSpacing: -1.1, marginBottom: 24 },
  settingsSectionLabel: { color: '#89858A', fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginTop: 25, marginBottom: 8, paddingHorizontal: 17 },
  settingsGroup: { backgroundColor: '#FFFFFF', borderRadius: 16, paddingHorizontal: 15, borderWidth: 1, borderColor: '#EFEDEF', shadowColor: '#3A3038', shadowOpacity: 0.045, shadowRadius: 12, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
  settingsListRow: { minHeight: 57, flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  settingsListIcon: { width: 32, height: 34, alignItems: 'flex-start', justifyContent: 'center', marginRight: 11 },
  settingsListIconText: { color: RED, fontSize: 20, fontWeight: '700' },
  settingsListIconNeutral: { color: '#59555B', fontSize: 20, fontWeight: '500' },
  settingsListLabel: { flex: 1, color: INK, fontSize: 15, fontWeight: '600' },
  settingsListValue: { color: RED, fontSize: 14, fontWeight: '600' },
  settingsListStatus: { color: '#8C888F', fontSize: 14 },
  settingsListStatusEnabled: { color: '#388454', fontWeight: '600' },
  settingsListDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#E8E6E9', marginLeft: 43 },
  settingsListCopy: { flex: 1, paddingVertical: 4, paddingRight: 8 },
  settingsListDetail: { color: MUTED, fontSize: 12, lineHeight: 17, marginTop: 4 },
  settingsManagePlan: { minHeight: 43, alignItems: 'center', justifyContent: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E8E6E9' },
  settingsManagePlanText: { color: RED, fontSize: 12, fontWeight: '800', letterSpacing: 0.6 },
  settingsCard: { backgroundColor: '#FFFFFF', borderRadius: 5, borderWidth: 1, borderColor: '#E7E4DF', padding: 13, marginBottom: 11 },
  settingRow: { flexDirection: 'row', alignItems: 'center', paddingTop: 13 },
  settingIcon: { width: 31, height: 31, borderRadius: 4, backgroundColor: '#FBE8E5', alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  planSettingIcon: { backgroundColor: INK },
  settingIconText: { color: RED, fontSize: 14, fontWeight: '900' },
  settingCopy: { flex: 1 },
  settingTitle: { color: INK, fontSize: 10, fontWeight: '900' },
  settingDetail: { color: MUTED, fontSize: 8, lineHeight: 12, marginTop: 3 },
  settingArrow: { color: '#8D8881', fontSize: 21, marginLeft: 6 },
  settingsDivider: { height: 1, backgroundColor: '#EFEDEA', marginTop: 12 },
  managePlan: { backgroundColor: '#F0EEEA', alignItems: 'center', padding: 10, borderRadius: 4, marginTop: 13 },
  managePlanText: { color: INK, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  aboutLine: { color: MUTED, fontSize: 9, marginTop: 9 },
});
