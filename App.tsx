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
  TextInput,
  TouchableOpacity,
  View,
  Platform,
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
  type SharedValue,
} from 'react-native-reanimated';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import { Accelerometer } from 'expo-sensors';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import Purchases from 'react-native-purchases';
import { isPurchasesError, PURCHASES_ERROR_CODE } from 'react-native-purchases';
import {
  initializeAnalytics,
  loadAlarms,
  loadAppProgress,
  persistAlarms,
  persistAppProgress,
  loadKeepAlarmPlayingPreference,
  persistKeepAlarmPlayingPreference,
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
  getPendingChallenge,
  importSound as importAlarmSound,
  isNativeAlarmAvailable,
  rearm as rearmNativeAlarm,
  startTestAlarm,
  type AlarmHealth,
  type RingStartedEvent,
} from './modules/wayykup-alarm';
import { StatsScreen } from './src/stats/StatsScreen';
import { StreakMoment } from './src/stats/StreakMoment';
import {
  calculateStreaks,
  countsTowardStreak,
  localDateKey,
  timeToWakeMs,
} from './src/stats/logic';
import {
  completeOccurrence,
  earnFreezeForStreak,
  getOccurrences,
  getStreakFreezes,
  markOccurrenceRinging,
  materializeOccurrences,
  reconcileOccurrences,
  recordFailedAttempt,
  recordRearm,
  resolveOccurrence,
  setMorningRating,
  spendFreeze,
  usedFreezeDates,
} from './src/stats/repository';
import { registerOccurrenceReconciliationTask } from './src/stats/background';
import type { Occurrence, StreakFreeze } from './src/stats/types';
import { OnboardingFlow, type OnboardingSetup } from './src/OnboardingFlow';
import { chooseHuntTarget, HUNT_ITEMS, matchesHuntObject } from './src/challenges/objects';

type Task = 'Math' | 'Shake' | 'QR scan' | 'Memory' | 'Object Hunt' | 'Toothbrush' | 'Push-ups' | 'Squats';
type MathDifficulty = 'Easy' | 'Medium' | 'Hard';
type Screen = 'welcome' | 'proof' | 'paywall' | 'home' | 'editor' | 'alarm' | 'stats' | 'streak' | 'settings';
type PaywallStage = 'intro' | 'reminder' | 'timeline' | 'plans' | 'gift' | 'discount';
type Alarm = {
  id: string;
  time: string;
  task: Task;
  days: string[];
  sound: string;
  customSoundUri?: string;
  customSoundName?: string;
  enabled: boolean;
  savage: boolean;
  qrCode?: string;
  huntItems?: string[];
  huntTarget?: string;
  mathDifficulty: MathDifficulty;
  shakeCount: number;
};

const RED = '#FF1717';
const INK = '#171717';
const MUTED = '#77736F';
const PAPER = '#F7F7F9';
const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const TASKS: { name: Task; icon: string; detail: string }[] = [
  { name: 'Object Hunt', icon: '⌕', detail: 'Find an object and take a photo' },
  { name: 'Toothbrush', icon: '▰', detail: 'Brush for two minutes' },
  { name: 'Push-ups', icon: '↗', detail: 'Complete ten controlled reps' },
  { name: 'Squats', icon: '↘', detail: 'Complete ten controlled reps' },
  { name: 'Math', icon: '∑', detail: 'Solve a problem to wake up' },
  { name: 'Shake', icon: '↯', detail: 'Shake it off. No shortcuts.' },
  { name: 'QR scan', icon: '▦', detail: 'Get up and scan your code' },
  { name: 'Memory', icon: '▤', detail: 'Repeat the sequence' },
];
const EXERCISE_REP_TARGET = 10;
const BRUSHING_DURATION_SECONDS = 120;
const MATH_CHALLENGES: Record<MathDifficulty, { equation: string; answer: number }> = {
  Easy: { equation: '12 + 19', answer: 31 },
  Medium: { equation: '78 × 4 + 12', answer: 324 },
  Hard: { equation: '136 × 7 − 44', answer: 908 },
};
const SOUNDS = [
  'Beacon',
  'Buzz Saw',
  'Kitchen Phone',
  'Pulse',
  'Air Raid',
  'Honk',
  'Inferno',
  'Redline',
  'Bugle Call',
  'Countdown',
  'Jackhammer',
  'Warpath',
];
const SOUND_ASSETS: Record<string, number> = {
  'Air raid': require('./assets/alarm-tone.wav'),
  'Bugle call': require('./assets/bugle-call.wav'),
  Redline: require('./assets/redline.wav'),
  Beacon: require('./assets/beacon.wav'),
  'Buzz Saw': require('./assets/buzz-saw.wav'),
  'Kitchen Phone': require('./assets/kitchen-phone.wav'),
  Pulse: require('./assets/pulse.wav'),
  'Air Raid': require('./assets/alarm-tone.wav'),
  Honk: require('./assets/honk.wav'),
  Inferno: require('./assets/inferno.wav'),
  'Bugle Call': require('./assets/bugle-call.wav'),
  Countdown: require('./assets/countdown.wav'),
  Jackhammer: require('./assets/jackhammer.wav'),
  Warpath: require('./assets/warpath.wav'),
};
const REVENUECAT_API_KEY = Platform.OS === 'ios'
  ? process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY
  : process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY;
const MIXPANEL_TOKEN = process.env.EXPO_PUBLIC_MIXPANEL_TOKEN;
const DISCOUNT_PACKAGE_ID = process.env.EXPO_PUBLIC_REVENUECAT_DISCOUNT_PACKAGE_ID;
const AnimatedTouchableOpacity = Animated.createAnimatedComponent(TouchableOpacity);

const starterAlarms: Alarm[] = [
  { id: 'alpha', time: '06:45', task: 'Math', days: ['0', '1', '2', '3', '4'], sound: 'Air raid', enabled: true, savage: true, mathDifficulty: 'Hard', shakeCount: 100 },
  { id: 'bravo', time: '05:30', task: 'Shake', days: ['0', '1', '2', '3', '4'], sound: 'Bugle call', enabled: true, savage: false, mathDifficulty: 'Easy', shakeCount: 100 },
  { id: 'charlie', time: '09:00', task: 'QR scan', days: [], sound: 'Redline', enabled: false, savage: false, mathDifficulty: 'Easy', shakeCount: 100 },
];

function formatClock12Hour(time: string) {
  const [hour, minute] = time.split(':').map(Number);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${suffix}`;
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

function taskLabel(task: Task, alarm?: Alarm) {
  switch (task) {
    case 'Math': return `Math ${alarm?.mathDifficulty ?? 'Medium'}`;
    case 'Shake': return `Shake ${alarm?.shakeCount ?? 100}`;
    case 'QR scan': return 'QR Scan';
    case 'Memory': return 'Memory';
    case 'Object Hunt': return 'Object Hunt';
    case 'Toothbrush': return 'Toothbrush';
    case 'Push-ups': return `Push-ups · ${EXERCISE_REP_TARGET} reps`;
    case 'Squats': return `Squats · ${EXERCISE_REP_TARGET} reps`;
  }
}
function taskIcon(task: Task) {
  return TASKS.find((item) => item.name === task)?.icon ?? '∑';
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
}: {
  target: string;
  onRecognized: (target: string) => void;
  onFailedAttempt: () => void;
}) {
  const cameraRef = useRef<CameraView | null>(null);
  const captureInProgress = useRef(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [message, setMessage] = useState('');

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
    try {
      const photo = await camera.takePictureAsync({ quality: 0.7 });
      const predictions = await classifyImage(photo.uri);
      if (matchesHuntObject(target, predictions)) {
        onRecognized(target);
      } else {
        onFailedAttempt();
        const label = predictions[0]?.label;
        setMessage(
          label
            ? `NOT RECOGNIZED · WAYYKUP SAW ${label.toUpperCase()}. TRY AGAIN.`
            : 'OBJECT NOT RECOGNIZED · MOVE CLOSER AND TRY AGAIN.',
        );
      }
    } catch (error) {
      console.error('Object Hunt image recognition failed.', error);
      setMessage('RECOGNITION FAILED · CHECK THE LIGHTING AND TRY AGAIN.');
    } finally {
      captureInProgress.current = false;
      setCapturing(false);
    }
  }, [cameraReady, onFailedAttempt, onRecognized, target]);

  return (
    <>
      <CameraView
        ref={cameraRef}
        style={styles.alarmCamera}
        onCameraReady={() => setCameraReady(true)}
      />
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Take a photo to recognize the ${target}`}
        disabled={!cameraReady || capturing}
        onPress={() => { void capture(); }}
        style={[styles.objectCaptureButton, (!cameraReady || capturing) && styles.buttonDisabled]}
      >
        <Text style={styles.objectCaptureButtonText}>
          {capturing ? 'IDENTIFYING OBJECT…' : 'TAKE PHOTO TO IDENTIFY'}
        </Text>
      </TouchableOpacity>
      {!!message && <Text style={styles.huntRecognitionMessage}>{message}</Text>}
    </>
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
  translateX,
  onPress,
}: {
  alarm: Alarm;
  action: 'edit' | 'delete';
  width: number;
  translateX: SharedValue<number>;
  onPress: () => void;
}) {
  const isEdit = action === 'edit';
  const actionStyle = useAnimatedStyle(() => {
    const progress = isEdit ? translateX.value / width : -translateX.value / width;
    return {
      opacity: interpolate(progress, [0, 1], [0, 1], Extrapolation.CLAMP),
      transform: [{ scale: interpolate(progress, [0, 1], [0.9, 1], Extrapolation.CLAMP) }],
    };
  }, [isEdit, width]);

  return (
    <ReanimatedAnimated.View
      style={[
        styles.alarmSwipeAction,
        isEdit ? styles.alarmSwipeEdit : styles.alarmSwipeDelete,
        { width },
        actionStyle,
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
          translateX={translateX}
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
          translateX={translateX}
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
  const [startupProgressLoaded, setStartupProgressLoaded] = useState(false);
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
  const [paywallReturnScreen, setPaywallReturnScreen] = useState<Screen>('proof');
  const [paywallStage, setPaywallStage] = useState<PaywallStage>('plans');
  const [onboardingAlarmId, setOnboardingAlarmId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Alarm>({
    id: '',
    time: '07:00',
    task: 'Math',
    days: ['0', '1', '2', '3', '4'],
    sound: SOUNDS[0],
    enabled: true,
    savage: false,
    mathDifficulty: 'Medium',
    shakeCount: 100,
  });
  const [now, setNow] = useState(() => new Date());
  const [answer, setAnswer] = useState('');
  const [wrongAnswers, setWrongAnswers] = useState(0);
  const [mathAttempts, setMathAttempts] = useState(0);
  const [mathCorrect, setMathCorrect] = useState(0);
  const [shakeCount, setShakeCount] = useState(0);
  const [exerciseReps, setExerciseReps] = useState(0);
  const [brushingSeconds, setBrushingSeconds] = useState(BRUSHING_DURATION_SECONDS);
  const [sensorAvailable, setSensorAvailable] = useState(true);
  const [linkingQr, setLinkingQr] = useState(false);
  const [qrError, setQrError] = useState('');
  const [activeHuntTarget, setActiveHuntTarget] = useState<string | null>(null);
  const [shuffleDisplayTarget, setShuffleDisplayTarget] = useState<string | null>(null);
  const [challengeShuffleVisible, setChallengeShuffleVisible] = useState(false);
  const [huntRecognized, setHuntRecognized] = useState(false);
  const [huntRecognitionMessage, setHuntRecognitionMessage] = useState('');
  const [qrScanned, setQrScanned] = useState(false);
  const [memoryEntry, setMemoryEntry] = useState('');
  const [memorySequenceVisible, setMemorySequenceVisible] = useState(false);
  const [snoozeLevels, setSnoozeLevels] = useState<Record<string, number>>({});
  const [challengeDurationSeconds, setChallengeDurationSeconds] = useState(0);
  const [availablePackages, setAvailablePackages] = useState<Parameters<typeof Purchases.purchasePackage>[0][]>([]);
  const [billingError, setBillingError] = useState('');
  const [billingBusy, setBillingBusy] = useState(false);
  const [hasPremium, setHasPremium] = useState(false);
  const [plan, setPlan] = useState<'yearly' | 'monthly' | 'weekly'>('yearly');
  const [plansModalVisible, setPlansModalVisible] = useState(false);
  const [lastAlarm, setLastAlarm] = useState<Alarm>(starterAlarms[0]);
  const snoozeLevel = snoozeLevels[lastAlarm.id] ?? 0;
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const alarmPlayer = useAudioPlayer(require('./assets/alarm-tone.wav'));
  const previousAcceleration = useRef<{ magnitude: number; timestamp: number; x: number; y: number; z: number } | null>(null);
  const lastExerciseRepAt = useRef(0);
  const exerciseMotionActive = useRef(false);
  const brushingEndsAt = useRef(0);
  const challengeCompleted = useRef(false);
  const challengeStartedAt = useRef(0);
  const activeChallengeAlarmId = useRef<string | null>(null);
  const activeOccurrenceId = useRef<string | null>(null);
  const activeRingStartedAt = useRef(0);
  const alarmsRef = useRef(alarms);
  const pendingNotificationAlarmId = useRef<{ alarmId: string; occurrenceId: string } | null>(null);
  const lastNotificationResponse = useRef<{ id: string; receivedAt: number } | null>(null);
  const screenEntrance = useRef(new Animated.Value(0)).current;
  const sheetTranslation = useRef(new Animated.Value(900)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const addButtonScale = useRef(new Animated.Value(1)).current;

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
        if (alarmHealth?.canRingNow && alarmHealth.testAlarmPassed) {
          await syncAlarmNotifications(alarms);
        } else {
          await materializeOccurrences(alarms);
        }
        await refreshStats();
      } catch (error) {
        console.error('Alarm schedule and occurrence history could not be synchronized.', error);
        setStatsError('Alarm history could not be synchronized.');
        if (alarmHealth?.canRingNow && alarmHealth.testAlarmPassed) {
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
      void refreshAlarmHealth();
      reconcileOccurrences()
        .then(() => materializeOccurrences(alarmsRef.current))
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
          const isUnmodifiedStarterData = savedAlarms.length === 2
            && savedAlarms[0].id === 'alpha'
            && savedAlarms[0].time === '06:00'
            && savedAlarms[0].task === 'Math'
            && savedAlarms[0].mathDifficulty === 'Medium'
            && savedAlarms[1].id === 'bravo'
            && savedAlarms[1].time === '07:30'
            && savedAlarms[1].task === 'Shake'
            && !savedAlarms[1].enabled;
          setAlarms(isUnmodifiedStarterData
            ? starterAlarms
            : savedAlarms.map((alarm) => ({ ...alarm, shakeCount: alarm.shakeCount ?? 100 })));
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
        if (progress?.onboardingComplete) {
          if (progress.appUnlocked) {
            setScreen('home');
          } else {
            setPaywallReturnScreen('home');
            setPaywallStage('plans');
            setScreen('paywall');
          }
          return;
        }

        if (progress === null) {
          const savedAlarms = await loadAlarms();
          const completedOnboardingAlarm = savedAlarms?.some((alarm) => alarm.id.startsWith('onboarding-')) ?? false;
          if (!active || !completedOnboardingAlarm) return;

          const migratedProgress = { onboardingComplete: true, appUnlocked: true };
          await persistAppProgress(migratedProgress);
          setScreen('home');
        }
      })
      .catch((error: unknown) => {
        console.error('Unable to restore app progress.', error);
        Alert.alert('Progress unavailable', 'Wayykup could not restore your previous app progress. Your saved alarms remain available.');
      })
      .finally(() => {
        if (active) setStartupProgressLoaded(true);
      });
    return () => { active = false; };
  }, []);

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
    if (startupProgressLoaded && hasPremium && screen === 'paywall' && paywallReturnScreen !== 'settings') {
      setScreen('home');
    }
  }, [hasPremium, paywallReturnScreen, screen, startupProgressLoaded]);

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
    try {
      Purchases.configure({ apiKey: REVENUECAT_API_KEY });
    } catch (error) {
      console.error('RevenueCat could not be configured.', error);
      setBillingError('Subscriptions are not configured for this build.');
      return;
    }
    Promise.all([Purchases.getOfferings(), Purchases.getCustomerInfo()])
      .then(([offerings, customerInfo]) => {
        if (!active) return;
        setAvailablePackages(offerings.current?.availablePackages ?? []);
        const isPremium = Boolean(customerInfo.entitlements.active.savage_plus);
        setHasPremium(isPremium);
        if (isPremium) {
          void persistAppProgress({ onboardingComplete: true, appUnlocked: true }).catch((error: unknown) => {
            console.error('Premium app access could not be saved.', error);
          });
        }
      })
      .catch((error: unknown) => {
        console.error('RevenueCat could not load offerings or customer info.', error);
        if (active) setBillingError('Plans are temporarily unavailable. Please try again later.');
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (screen !== 'alarm') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [screen]);

  useEffect(() => {
    if (screen !== 'alarm') return;
    if (activeOccurrenceId.current && isNativeAlarmAvailable && Platform.OS !== 'web') {
      alarmPlayer.pause();
      alarmPlayer.clearLockScreenControls();
      return;
    }
    if (keepAlarmPlayingDuringChallenges === false) {
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
        alarmPlayer.replace(lastAlarm.customSoundUri ?? SOUND_ASSETS[lastAlarm.sound] ?? SOUND_ASSETS['Air raid']);
        alarmPlayer.loop = true;
        alarmPlayer.volume = Math.min(1, 0.55 + (wrongAnswers + snoozeLevel) * 0.1);
        alarmPlayer.setActiveForLockScreen(
          true,
          { title: 'WAYYKUP', artist: lastAlarm.customSoundName ?? lastAlarm.sound },
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
  }, [screen, alarmPlayer, keepAlarmPlayingDuringChallenges, lastAlarm.customSoundUri, lastAlarm.sound]);

  useEffect(() => {
    if (screen !== 'alarm') return;
    alarmPlayer.volume = Math.min(1, 0.55 + (wrongAnswers + snoozeLevel) * 0.1);
  }, [alarmPlayer, screen, snoozeLevel, wrongAnswers]);

  useEffect(() => {
    if (screen !== 'alarm' || lastAlarm.task !== 'Memory') {
      setMemorySequenceVisible(false);
      return;
    }
    setMemorySequenceVisible(true);
    const timer = setTimeout(() => setMemorySequenceVisible(false), 1800);
    return () => clearTimeout(timer);
  }, [lastAlarm.task, screen]);

  const nextAlarm = useMemo(
    () => alarms.find((alarm) => alarm.enabled) ?? null,
    [alarms],
  );

  useEffect(() => {
    const isExercise = lastAlarm.task === 'Push-ups' || lastAlarm.task === 'Squats';
    if (screen !== 'alarm' || (lastAlarm.task !== 'Shake' && !isExercise)) return;
    previousAcceleration.current = null;
    lastExerciseRepAt.current = 0;
    exerciseMotionActive.current = false;
    let active = true;
    let sensorSubscription: { remove: () => void } | undefined;
    Accelerometer.isAvailableAsync()
      .then((available) => {
        if (!active) return;
        setSensorAvailable(available);
        if (!available) return;
        Accelerometer.setUpdateInterval(100);
        const subscription = Accelerometer.addListener(({ x, y, z, timestamp }) => {
          const magnitude = Math.sqrt(x * x + y * y + z * z);
          const previous = previousAcceleration.current;
          previousAcceleration.current = { magnitude, timestamp, x, y, z };
          if (!previous || timestamp - previous.timestamp < 0.2) return;
          if (!isExercise) {
            if (Math.abs(magnitude - previous.magnitude) < 1.15) return;
            setShakeCount((count) => Math.min(count + 1, lastAlarm.shakeCount));
            return;
          }

          const movement = Math.sqrt((x - previous.x) ** 2 + (y - previous.y) ** 2 + (z - previous.z) ** 2);
          if (movement < 0.07) exerciseMotionActive.current = false;
          if (movement >= 0.2 && !exerciseMotionActive.current && timestamp - lastExerciseRepAt.current >= 0.85) {
            exerciseMotionActive.current = true;
            lastExerciseRepAt.current = timestamp;
            setExerciseReps((count) => Math.min(count + 1, EXERCISE_REP_TARGET));
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
  }, [lastAlarm.shakeCount, lastAlarm.task, screen]);

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
      if (!health?.canRingNow) {
        Alert.alert(
          'Alarm permissions needed',
          'Enable notifications, exact alarms, and full-screen alarm access first. Use the alarm health panel to open the matching system setting.',
        );
        return;
      }
      await startTestAlarm();
      Alert.alert(
        '60-second test scheduled',
        'The native alarm will ring in 60 seconds. Complete its challenge to unlock alarm scheduling.',
      );
    } catch (error) {
      console.error('The 60-second native alarm test could not be scheduled.', error);
      Alert.alert('Test alarm unavailable', error instanceof Error ? error.message : 'Wayykup could not schedule the native ring test.');
    }
  };

  const openNewAlarm = () => {
    if (!isNativeAlarmAvailable || alarmHealth?.testAlarmPassed !== true) {
      Alert.alert(
        'Test the alarm first',
        'Complete Wayykup’s 60-second native ring test before adding an alarm.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Run test', onPress: () => { void beginAlarmTest(); } },
        ],
      );
      return;
    }
    setOpenAlarmSwipeId(null);
    setEditingId(null);
    setDraft({
      id: '',
      time: '07:00',
      task: 'Math',
      days: ['0', '1', '2', '3', '4'],
      sound: SOUNDS[0],
      enabled: true,
      savage: false,
      qrCode: '',
      huntItems: ['Toothbrush'],
      huntTarget: 'Toothbrush',
      mathDifficulty: 'Medium',
      shakeCount: 100,
    });
    setLinkingQr(false);
    setExpandedEditorSection(null);
    setScreen('editor');
  };

  const openEditAlarm = (alarm: Alarm) => {
    setOpenAlarmSwipeId(null);
    setEditingId(alarm.id);
    setDraft({ ...alarm });
    setLinkingQr(false);
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
    if (!editingId && (!isNativeAlarmAvailable || alarmHealth?.testAlarmPassed !== true)) {
      Alert.alert('Test the alarm first', 'Complete the 60-second ring test before creating an alarm.');
      return;
    }
    const huntTargets = draft.huntItems?.length ? draft.huntItems : draft.huntTarget ? [draft.huntTarget] : [];
    if (draft.task === 'Object Hunt' && !huntTargets.length) {
      Alert.alert('Choose an object', 'Select at least one target object for Object Hunt before saving this challenge.');
      return;
    }
    if (editingId) {
      setAlarms((current) => current.map((alarm) => (alarm.id === editingId ? draft : alarm)));
      trackEvent('alarm_updated', { task: draft.task, time: draft.time });
    } else {
      setAlarms((current) => [...current, { ...draft, id: Date.now().toString() }]);
      trackEvent('alarm_created', { task: draft.task, time: draft.time });
    }
    try {
      const granted = await requestAlarmNotifications();
      await refreshAlarmHealth();
      if (!granted) {
        Alert.alert(
          'Alarm permissions incomplete',
          'Your alarm details were saved, but Wayykup will not schedule a ring until all required alarm permissions are enabled.',
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
  ) => {
    if (!alarm) {
      Alert.alert('No active alarm', 'Create or enable an alarm before starting a wake-up drill.');
      return;
    }
    if (alarm.task === 'QR scan' && !alarm.qrCode) {
      Alert.alert('QR code not linked', 'Edit this alarm and scan your physical QR code before starting the challenge.');
      return;
    }
    const configuredHuntItems = alarm.huntItems?.length ? alarm.huntItems : alarm.huntTarget ? [alarm.huntTarget] : [];
    const huntTarget = chooseHuntTarget(configuredHuntItems);
    if (alarm.task === 'Object Hunt' && !huntTarget) {
      Alert.alert('Choose an object', 'Edit this alarm and select at least one target object before starting Object Hunt.');
      return;
    }
    setLastAlarm(alarm);
    const sameOccurrence = occurrenceId !== null && activeOccurrenceId.current === occurrenceId;
    activeChallengeAlarmId.current = alarm.id;
    activeOccurrenceId.current = occurrenceId;
    if (!sameOccurrence) activeRingStartedAt.current = firstRingAt;
    setAnswer('');
    setWrongAnswers(0);
    setMathAttempts(0);
    setMathCorrect(0);
    setShakeCount(0);
    setExerciseReps(0);
    setBrushingSeconds(BRUSHING_DURATION_SECONDS);
    brushingEndsAt.current = Date.now() + (BRUSHING_DURATION_SECONDS * 1000);
    setQrScanned(false);
    setQrError('');
    setHuntRecognitionMessage('');
    setActiveHuntTarget(huntTarget);
    setShuffleDisplayTarget(null);
    setChallengeShuffleVisible(alarm.task === 'Object Hunt');
    setHuntRecognized(false);
    challengeCompleted.current = false;
    lastExerciseRepAt.current = 0;
    exerciseMotionActive.current = false;
    setMemoryEntry('');
    challengeStartedAt.current = Date.now();
    setScreen('alarm');
  };

  const startChallengeRef = useRef(startChallenge);
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
    const testTasks: Task[] = ['Math', 'Shake', 'QR scan', 'Memory', 'Object Hunt', 'Toothbrush', 'Push-ups', 'Squats'];
    const testTask = testTasks.find((task) => task === event.challenge) ?? 'Math';
    const alarm: Alarm | null = savedAlarm ?? (event.testAlarm ? {
      id: event.alarmId,
      time: '07:00',
      task: testTask,
      days: [],
      sound: event.sound,
      enabled: true,
      savage: false,
      mathDifficulty: 'Easy',
      shakeCount: 50,
    } : null);
    if (!alarm) {
      pendingNotificationAlarmId.current = { alarmId: event.alarmId, occurrenceId: event.occurrenceId };
      return;
    }
    if (activeChallengeAlarmId.current === event.alarmId) return;
    startChallengeRef.current(alarm, event.occurrenceId, event.at);
  }, [refreshStats]);

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

  const finishChallenge = useCallback(async (mathAnsweredCorrectly = false) => {
    if (challengeCompleted.current) return;
    challengeCompleted.current = true;
    activeChallengeAlarmId.current = null;
    const completedAt = Date.now();
    const challengeDurationMs = Math.max(
      0,
      completedAt - (activeRingStartedAt.current || challengeStartedAt.current),
    );
    const occurrenceId = activeOccurrenceId.current;
    activeOccurrenceId.current = null;
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
      setScreen('stats');
      return;
    }

    try {
      const previousOccurrence = occurrences
        .filter((item) => item.id !== occurrenceId && item.status === 'completed' && item.completedAt != null)
        .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0];
      const previousWakeDurationMs = previousOccurrence ? timeToWakeMs(previousOccurrence) : null;
      const streakBefore = calculateStreaks(occurrences, usedFreezeDates(streakFreezes), completedAt).current;
      await completeOccurrence(occurrenceId, completedAt, {
        shakesCounted: lastAlarm.task === 'Shake' ? shakeCount : undefined,
        steps: lastAlarm.task === 'Push-ups' || lastAlarm.task === 'Squats' ? exerciseReps : undefined,
        mathCorrect: lastAlarm.task === 'Math' ? mathCorrect + (mathAnsweredCorrectly ? 1 : 0) : undefined,
        mathAttempts: lastAlarm.task === 'Math' ? mathAttempts + (mathAnsweredCorrectly ? 1 : 0) : undefined,
        challengeDurationMs,
      });
      await cancelNativeAlarmChain(lastAlarm.id, 'completed');
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
        setScreen('streak');
      } else {
        setScreen('stats');
      }
    } catch (error) {
      console.error('Completed alarm could not be recorded in local stats.', error);
      setStatsError('This wake-up could not be saved to Stats.');
      Alert.alert('Wake-up not saved', 'The challenge is complete, but Wayykup could not save this alarm session locally.');
      setScreen('stats');
    }
  }, [
    exerciseReps,
    lastAlarm.days.length,
    lastAlarm.id,
    lastAlarm.task,
    alarmHealth?.deviceModel,
    mathAttempts,
    mathCorrect,
    occurrences,
    refreshAlarmHealth,
    shakeCount,
    snoozeLevel,
    streakFreezes,
  ]);

  const recordChallengeFailure = useCallback((isMathAttempt = false) => {
    setWrongAnswers((count) => count + 1);
    if (isMathAttempt) setMathAttempts((count) => count + 1);
    const occurrenceId = activeOccurrenceId.current;
    if (!occurrenceId) return;
    recordFailedAttempt(occurrenceId)
      .then(() => refreshStats())
      .catch((error: unknown) => {
        console.error('Failed wake-up attempt could not be recorded.', error);
        Alert.alert('Attempt not saved', 'Wayykup could not save this failed attempt to your local wake-up history.');
      });
  }, [refreshStats]);

  useEffect(() => {
    if (screen !== 'alarm' || !challengeShuffleVisible || !activeHuntTarget) return;
    let index = 0;
    let timeout: ReturnType<typeof setTimeout>;
    const advance = () => {
      if (index >= 9) {
        setShuffleDisplayTarget(activeHuntTarget);
        timeout = setTimeout(() => setChallengeShuffleVisible(false), 500);
        return;
      }
      const availableTargets = lastAlarm.huntItems?.length
        ? lastAlarm.huntItems
        : [activeHuntTarget];
      setShuffleDisplayTarget(availableTargets[index % availableTargets.length]);
      timeout = setTimeout(advance, 90 + index * 36);
      index += 1;
    };
    advance();
    return () => clearTimeout(timeout);
  }, [activeHuntTarget, challengeShuffleVisible, lastAlarm.huntItems, screen]);

  useEffect(() => {
    if (screen !== 'alarm' || lastAlarm.task !== 'Object Hunt' || !huntRecognized) return;
    const timeout = setTimeout(() => finishChallenge(), 1100);
    return () => clearTimeout(timeout);
  }, [finishChallenge, huntRecognized, lastAlarm.task, screen]);

  useEffect(() => {
    if (screen !== 'alarm' || lastAlarm.task !== 'Toothbrush') return;
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((brushingEndsAt.current - Date.now()) / 1000));
      setBrushingSeconds(remaining);
      if (remaining === 0) {
        clearInterval(interval);
        finishChallenge();
      }
    }, 250);
    return () => clearInterval(interval);
  }, [finishChallenge, lastAlarm.task, screen]);

  useEffect(() => {
    if (screen === 'alarm' && lastAlarm.task === 'Shake' && shakeCount >= lastAlarm.shakeCount) {
      finishChallenge();
    }
    if (
      screen === 'alarm'
      && (lastAlarm.task === 'Push-ups' || lastAlarm.task === 'Squats')
      && exerciseReps >= EXERCISE_REP_TARGET
    ) {
      finishChallenge();
    }
  }, [exerciseReps, finishChallenge, lastAlarm.shakeCount, lastAlarm.task, screen, shakeCount]);

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
          challenge: typeof challenge === 'string' ? challenge : 'Math',
          sound: typeof sound === 'string' ? sound : 'Air raid',
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

  const snoozeAlarm = async () => {
    if (!lastAlarm.savage) return;
    try {
      if (!isNativeAlarmAvailable || !alarmHealth?.canRingNow) {
        Alert.alert('Snooze unavailable', 'Native alarm permissions are required to re-arm this alarm.');
        return;
      }
      await rearmNativeAlarm(lastAlarm.id, 300_000);
      if (activeOccurrenceId.current) {
        await recordRearm(activeOccurrenceId.current);
        await refreshStats();
      }
      setSnoozeLevels((levels) => ({ ...levels, [lastAlarm.id]: snoozeLevel + 1 }));
      trackEvent('alarm_snoozed', { task: lastAlarm.task, snooze_count: snoozeLevel + 1 });
      activeChallengeAlarmId.current = null;
      alarmPlayer.pause();
      setScreen('home');
    } catch (error) {
      console.error('Could not schedule native snooze.', error);
      Alert.alert('Snooze failed', error instanceof Error ? error.message : 'The operating system did not accept the native re-arm.');
    }
  };

  const emergencyBypass = () => {
    Alert.alert(
      'Emergency exit',
      'Leaving the challenge will be recorded as a bypass and will break your wake streak.',
      [
        { text: 'Keep going', style: 'cancel' },
        {
          text: 'Bypass alarm',
          style: 'destructive',
          onPress: () => {
            challengeCompleted.current = true;
            const occurrenceId = activeOccurrenceId.current;
            activeOccurrenceId.current = null;
            activeChallengeAlarmId.current = null;
            const exit = async () => {
              if (occurrenceId) {
                try {
                  await resolveOccurrence(occurrenceId, 'bypassed');
                  await cancelNativeAlarmChain(lastAlarm.id, 'bypassed');
                  await refreshStats();
                } catch (error) {
                  console.error('Emergency alarm bypass could not be recorded.', error);
                  Alert.alert('Bypass not saved', 'The challenge was closed, but the bypass could not be recorded in your wake history.');
                }
              }
              setScreen('home');
            };
            void exit();
          },
        },
      ],
    );
  };

  const purchaseSubscription = async (
    packageOverride?: Parameters<typeof Purchases.purchasePackage>[0],
    failureStage?: PaywallStage,
    refreshOfferings = false,
    packageTypeOverride?: (typeof Purchases.PACKAGE_TYPE)[keyof typeof Purchases.PACKAGE_TYPE],
  ) => {
    setBillingError('');
    setBillingBusy(true);
    try {
      if (!REVENUECAT_API_KEY) {
        if (__DEV__ && !failureStage) {
          setHasPremium(true);
          void persistAppProgress({ onboardingComplete: true, appUnlocked: true }).catch((error: unknown) => {
            console.error('Development app access could not be saved.', error);
          });
          setScreen('home');
          return;
        }
        setBillingError('Subscriptions are not configured for this build. Please contact support.');
        if (failureStage) setPaywallStage(failureStage);
        return;
      }

      let packages = availablePackages;
      if (refreshOfferings) {
        const offerings = await Purchases.getOfferings();
        packages = offerings.current?.availablePackages ?? [];
        setAvailablePackages(packages);
      }

      const wantedType = packageTypeOverride ?? (plan === 'yearly'
        ? Purchases.PACKAGE_TYPE.ANNUAL
        : plan === 'monthly'
          ? Purchases.PACKAGE_TYPE.MONTHLY
          : Purchases.PACKAGE_TYPE.WEEKLY);
      const selectedPackage = packageOverride
        ? packages.find((item) => item.identifier === packageOverride.identifier)
        : packages.find((item) => item.packageType === wantedType);
      if (!selectedPackage) {
        setBillingError('This plan is not available in the current RevenueCat offering.');
        if (failureStage) setPaywallStage(failureStage);
        return;
      }

      const result = await Purchases.purchasePackage(selectedPackage);
      if (!result.customerInfo.entitlements.active.savage_plus) {
        setBillingError('Purchase completed, but the Savage Plus entitlement was not returned.');
        if (failureStage) setPaywallStage(failureStage);
        return;
      }
      setHasPremium(true);
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
      if (customerInfo.entitlements.active.savage_plus) {
        setHasPremium(true);
        void persistAppProgress({ onboardingComplete: true, appUnlocked: true }).catch((error: unknown) => {
          console.error('Restored app access could not be saved.', error);
          Alert.alert('Progress could not be saved', 'Your purchase is active, but Wayykup may not remember your app access next time.');
        });
        trackEvent('subscription_restored');
        setScreen('home');
      } else {
        setBillingError('No active Savage Plus subscription was found.');
      }
    } catch (error) {
      console.error('Purchase restoration failed.', error);
      setBillingError(error instanceof Error ? error.message : 'Purchases could not be restored.');
    }
  };

  const beginQrLinking = async () => {
    setQrError('');
    if (cameraPermission?.granted) {
      setLinkingQr(true);
      return;
    }
    try {
      const permission = await requestCameraPermission();
      if (permission.granted) setLinkingQr(true);
      else setQrError('Camera permission is needed to link a QR code.');
    } catch (error) {
      console.error('Camera permission could not be requested.', error);
      setQrError('Camera access is unavailable on this device.');
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

  const completeOnboarding = ({ alarm, notificationGranted, keepAlarmPlaying }: OnboardingSetup) => {
    const newAlarm: Alarm = {
      ...alarm,
      shakeCount: alarm.shakeCount ?? 100,
    };
    setDraft(newAlarm);
    setOnboardingAlarmId(newAlarm.id);
    setAlarms((current) => [
      ...current.filter((item) => !['alpha', 'bravo', 'charlie'].includes(item.id)),
      newAlarm,
    ]);
    setNotificationsAllowed(notificationGranted);
    setKeepAlarmPlayingDuringChallenges(keepAlarmPlaying);
    persistKeepAlarmPlayingPreference(keepAlarmPlaying).catch((error: unknown) => {
      console.error('Onboarding alarm playback preference could not be saved.', error);
      Alert.alert('Could not save setting', 'The alarm playback preference could not be saved. You can update it later in Settings.');
    });
    setPaywallReturnScreen('home');
    setPaywallStage('intro');
    void persistAppProgress({ onboardingComplete: true, appUnlocked: false }).catch((error: unknown) => {
      console.error('Onboarding completion could not be saved.', error);
      Alert.alert('Progress could not be saved', 'Wayykup may ask you to repeat setup the next time it opens.');
    });
    trackEvent('onboarding_completed', { task: newAlarm.task, time: newAlarm.time });
    setScreen(hasPremium ? 'home' : 'paywall');
  };

  const continueWithoutPremium = () => {
    if (onboardingAlarmId && !hasPremium && (draft.task === 'Shake' || draft.task === 'QR scan')) {
      setAlarms((current) => current.map((alarm) => alarm.id === onboardingAlarmId
        ? { ...alarm, task: 'Math', qrCode: undefined }
        : alarm));
      setDraft((current) => current.id === onboardingAlarmId
        ? { ...current, task: 'Math', qrCode: undefined }
        : current);
    }
    trackEvent('paywall_continued_without_purchase');
    void persistAppProgress({ onboardingComplete: true, appUnlocked: true }).catch((error: unknown) => {
      console.error('App access could not be saved.', error);
      Alert.alert('Progress could not be saved', 'Wayykup may not remember your app access the next time it opens.');
    });
    setScreen('home');
  };

  const renderWelcome = () => (
    <View style={styles.onboarding}>
      <View style={styles.onboardingTop}>
        <Text style={styles.wordmark}>WAYYKUP<Text style={styles.wordmarkDot}>.</Text></Text>
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
          <View key={task.name} style={styles.proofRow}>
            <View style={styles.proofIcon}><Text style={styles.proofIconText}>{task.icon}</Text></View>
            <View style={styles.proofCopy}><Text style={styles.proofName}>{task.name.toUpperCase()}</Text><Text style={styles.proofDetail}>{task.detail}</Text></View>
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
    const annualPackage = availablePackages.find((item) => item.packageType === Purchases.PACKAGE_TYPE.ANNUAL);
    const annualProduct = annualPackage?.product;
    const introOffer = annualProduct?.introPrice;
    const discountPackage = DISCOUNT_PACKAGE_ID
      ? availablePackages.find((item) => item.identifier === DISCOUNT_PACKAGE_ID)
      : undefined;

    if (paywallStage !== 'plans') {
      const isIntro = paywallStage === 'intro';
      const isReminder = paywallStage === 'reminder';
      const isTimeline = paywallStage === 'timeline';
      const isGift = paywallStage === 'gift';
      const isDiscount = paywallStage === 'discount';

      if (isIntro) {
        return (
          <ScrollView
            style={styles.trialIntroScroll}
            contentContainerStyle={[styles.trialIntro, compactViewport && styles.trialIntroCompact]}
            showsVerticalScrollIndicator={false}
          >
            <Text style={[styles.trialTitle, { fontSize: Math.min(43, windowWidth * 0.11), lineHeight: Math.min(49, windowWidth * 0.125), marginTop: compactViewport ? 10 : 56 }]}>Try Wayykup{'\n'}for free</Text>
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
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Go back"
              onPress={() => setPaywallStage('intro')}
              style={styles.trialReminderBack}
            >
              <Text style={styles.trialReminderBackGlyph}>‹</Text>
            </TouchableOpacity>
            <Text style={[styles.trialReminderTitle, { fontSize: Math.min(42, windowWidth * 0.095), lineHeight: Math.min(50, windowWidth * 0.105) }]}>
              We&apos;ll send you{'\n'}a reminder before your{'\n'}free trial ends
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
        const introPeriod = introOffer
          ? `${introOffer.periodNumberOfUnits} ${introOffer.periodUnit.toLowerCase()}${introOffer.periodNumberOfUnits === 1 ? '' : 's'}`
          : null;
        const hasFreeTrial = introOffer?.price === 0;
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
            : introOffer
              ? [{
                  kind: 'bell' as const,
                  title: 'Intro offer',
                  detail: `${introOffer.priceString} for ${introPeriod}.`,
                }]
              : [{
                  kind: 'bell' as const,
                  title: 'No free trial',
                  detail: 'Your subscription starts when you confirm your purchase.',
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
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Go back"
                onPress={() => setPaywallStage('reminder')}
                style={styles.proTrialBack}
              >
                <Text style={styles.proTrialBackGlyph}>‹</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" onPress={() => { void restorePurchases(); }}>
                <Text style={styles.proTrialRestore}>Restore</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Dismiss and view special offer"
                onPress={() => {
                  setBillingError('');
                  setPaywallStage('gift');
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
              {!annualPackage && (
                <Text style={styles.proTrialUnavailable}>The annual plan is unavailable right now. You can review other plans.</Text>
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
            <Text style={[styles.giftOfferTitle, { fontSize: Math.min(37, windowWidth * 0.083), lineHeight: Math.min(45, windowWidth * 0.097) }]}>
              Try Wayykup and{'\n'}win your mornings
            </Text>
            <AnimatedGiftArtwork height={Math.min(380, Math.max(230, availableHeight * (compactViewport ? 0.34 : 0.43)))} />
            <View style={styles.giftOfferFooter}>
              <AnimatedOfferButton
                busy={billingBusy}
                onPress={() => {
                  if (discountPackage) {
                    void purchaseSubscription(discountPackage, 'gift', true);
                  } else {
                    setBillingError('A separate special offer is not configured. Choose from the available plans.');
                    setPlan('yearly');
                    setPlansModalVisible(true);
                  }
                }}
              />
              <TouchableOpacity
                accessibilityRole="button"
                onPress={continueWithoutPremium}
                style={styles.giftOfferContinue}
              >
                <Text style={styles.giftOfferContinueText}>Continue</Text>
              </TouchableOpacity>
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
          <Text style={styles.wordmarkSmall}>WAYYKUP<Text style={styles.wordmarkDot}>.</Text></Text>
          <View style={styles.waterfallHero}>
            <Text style={styles.waterfallIcon}>{isIntro ? '◴' : isTimeline ? '✦' : isGift ? '🎁' : '✦'}</Text>
            <Text style={styles.eyebrow}>{isGift ? 'A THANK-YOU OFFER' : 'YOUR MORNING, REBUILT'}</Text>
            <Text style={styles.waterfallTitle}>
              {isIntro ? 'Your wake-up plan is ready.' : isTimeline ? 'Unlock Wayykup Pro.' : isGift ? 'Win back your mornings.' : 'Your annual offer.'}
            </Text>
            <Text style={styles.bodyCopy}>
              {isIntro
                ? 'Your first alarm is set. Choose a plan to unlock the full set of wake-up challenges and sounds.'
                : isTimeline
                  ? 'Your store purchase sheet will show any eligible introductory offer and the exact renewal terms.'
                    : isGift
                      ? discountPackage
                        ? 'A special annual package is available through your store.'
                        : 'No additional discount package is configured right now. You can continue with basic alarms, or review the available plans.'
                      : 'The store will show the localized price and billing period before you confirm.'}
            </Text>
          </View>

          {(isTimeline || isDiscount) && (
            <View style={styles.waterfallTimeline}>
              <View style={styles.waterfallTimelineRow}><Text style={styles.waterfallTimelineDot}>1</Text><View style={styles.waterfallTimelineCopy}><Text style={styles.waterfallTimelineTitle}>Today</Text><Text style={styles.waterfallTimelineDetail}>Full access starts after purchase.</Text></View></View>
              <View style={styles.waterfallTimelineRow}><Text style={styles.waterfallTimelineDot}>2</Text><View style={styles.waterfallTimelineCopy}><Text style={styles.waterfallTimelineTitle}>Intro offer, if eligible</Text><Text style={styles.waterfallTimelineDetail}>{annualPackage?.product.introPrice ? `${annualPackage.product.introPrice.priceString} for ${annualPackage.product.introPrice.periodNumberOfUnits} ${annualPackage.product.introPrice.periodUnit.toLowerCase()} period${annualPackage.product.introPrice.periodNumberOfUnits === 1 ? '' : 's'}.` : 'No introductory offer is configured for the annual plan.'}</Text></View></View>
              <View style={styles.waterfallTimelineRow}><Text style={styles.waterfallTimelineDot}>3</Text><View style={styles.waterfallTimelineCopy}><Text style={styles.waterfallTimelineTitle}>Renewal</Text><Text style={styles.waterfallTimelineDetail}>{annualPackage ? `${annualPackage.product.priceString} per year, as shown by your store.` : 'Annual pricing is currently unavailable.'}</Text></View></View>
            </View>
          )}

          {isDiscount && discountPackage && (
            <View style={styles.discountCard}>
              <Text style={styles.discountBanner}>ANNUAL PACKAGE</Text>
              <Text style={styles.discountProduct}>{discountPackage.product.title}</Text>
              <Text style={styles.discountPrice}>{discountPackage.product.priceString}</Text>
              <Text style={styles.discountDetail}>Final price and renewal terms are confirmed in the store purchase sheet.</Text>
            </View>
          )}

          <View style={styles.waterfallActions}>
            {isIntro && <ActionButton label="CONTINUE" onPress={() => setPaywallStage('reminder')} />}
            {isReminder && <ActionButton label="CONTINUE" onPress={() => setPaywallStage('timeline')} />}
            {isTimeline && <ActionButton label={billingBusy ? 'CONNECTING TO APP STORE…' : 'CONTINUE TO STORE'} onPress={() => purchaseSubscription()} disabled={billingBusy || (!annualPackage && !__DEV__)} />}
            {isGift && discountPackage && <ActionButton label="CLAIM MY SPECIAL OFFER" onPress={() => setPaywallStage('discount')} />}
            {isGift && <ActionButton label={discountPackage ? 'CONTINUE WITH BASIC' : 'CONTINUE'} onPress={continueWithoutPremium} secondary={Boolean(discountPackage)} />}
            {isDiscount && discountPackage && <ActionButton label={billingBusy ? 'CONNECTING TO APP STORE…' : 'CONTINUE'} onPress={() => purchaseSubscription(discountPackage)} disabled={billingBusy} />}
            {isDiscount && <ActionButton label="CONTINUE WITH BASIC" onPress={continueWithoutPremium} secondary />}
            {(isTimeline || isDiscount) && !!billingError && <Text accessibilityRole="alert" style={styles.billingError}>{billingError}</Text>}
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
    }

    return (
    <ScrollView contentContainerStyle={styles.paywall} showsVerticalScrollIndicator={false}>
      <View style={styles.paywallTop}>
        <TouchableOpacity onPress={() => setScreen(paywallReturnScreen)}><Text style={styles.backText}>← BACK</Text></TouchableOpacity>
        <Tag>03 / 03 · SAVAGE PLUS</Tag>
      </View>
      <View style={styles.paywallHero}>
        <View style={styles.paywallSeal}><Text style={styles.sealIcon}>✳</Text><Text style={styles.sealLabel}>EARLY{'\n'}ACCESS</Text></View>
        <Text style={styles.eyebrow}>YOUR OLD ROUTINE ENDS HERE</Text>
        <Text style={styles.paywallTitle}>Unlock the{'\n'}Ultimate{'\n'}<Text style={styles.redText}>Wake-Up Call.</Text></Text>
        <Text style={styles.bodyCopy}>No soft landings. Just a better morning on the other side.</Text>
      </View>
      <View style={styles.perkList}>
        {[
          ['∞', 'Unlimited alarms', 'Set your whole week up right'],
          ['↯', 'Every wake-up task', 'Math, shake, QR & memory'],
          ['!', 'Extreme sounds', 'Make snooze a distant memory'],
        ].map(([icon, title, detail]) => (
          <View key={title} style={styles.perkRow}>
            <View style={styles.perkIcon}><Text style={styles.perkIconText}>{icon}</Text></View>
            <View style={styles.perkCopy}><Text style={styles.perkTitle}>{title}</Text><Text style={styles.perkDetail}>{detail}</Text></View>
            <Text style={styles.checkmark}>✓</Text>
          </View>
        ))}
      </View>
      <View style={styles.planOptions}>
        <TouchableOpacity onPress={() => setPlan('yearly')} style={[styles.planCard, plan === 'yearly' && styles.planSelected]}>
          <View style={styles.planHeading}><Text style={styles.planName}>YEARLY</Text><Tag>{annualPackage?.product.introPrice ? 'INTRO OFFER' : 'ANNUAL'}</Tag></View>
          <View style={styles.planPriceLine}><Text style={styles.planPrice}>{annualPackage?.product.priceString ?? 'Unavailable'}</Text><Text style={styles.planPeriod}> / year</Text></View>
          <Text style={styles.planSub}>{annualPackage ? 'Store checkout confirms any introductory offer and renewal terms.' : 'Annual pricing is not configured in this store.'}</Text>
          <View style={styles.planCardRadio}><View style={[styles.radio, plan === 'yearly' && styles.radioOn]}>{plan === 'yearly' && <View style={styles.radioDot} />}</View></View>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setPlan('weekly')} style={[styles.planCard, plan === 'weekly' && styles.planSelected]}>
          <View style={styles.planHeading}><Text style={styles.planName}>WEEKLY</Text><Text style={styles.weeklyLabel}>FLEXIBLE</Text></View>
          <View style={styles.planPriceLine}><Text style={styles.planPrice}>{availablePackages.find((item) => item.packageType === Purchases.PACKAGE_TYPE.WEEKLY)?.product.priceString ?? 'Unavailable'}</Text><Text style={styles.planPeriod}> / week</Text></View>
          <Text style={styles.planSub}>The store confirms the weekly renewal terms before purchase.</Text>
          <View style={styles.planCardRadio}><View style={[styles.radio, plan === 'weekly' && styles.radioOn]}>{plan === 'weekly' && <View style={styles.radioDot} />}</View></View>
        </TouchableOpacity>
      </View>
      <ActionButton
        label={billingBusy ? 'CONNECTING TO APP STORE…' : !REVENUECAT_API_KEY && __DEV__ ? 'CONTINUE IN DEVELOPMENT PREVIEW' : 'CONTINUE TO STORE'}
        onPress={purchaseSubscription}
        disabled={billingBusy || (!REVENUECAT_API_KEY && !__DEV__)}
      />
      {REVENUECAT_API_KEY && <TouchableOpacity onPress={restorePurchases} style={styles.restorePurchases}><Text style={styles.restoreText}>RESTORE PURCHASES</Text></TouchableOpacity>}
      {!!billingError && <Text accessibilityRole="alert" style={styles.billingError}>{billingError}</Text>}
      <Text style={styles.terms}>Any trial and renewal price are shown in the store checkout before you confirm.</Text>
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
          : !alarmHealth.testAlarmPassed
            ? 'Run the 60-second ring test to unlock alarm scheduling.'
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
                  } else if (alarmHealth?.testAlarmPassed !== true && alarmHealth?.canRingNow) {
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
                        nextLabel={index === 0 ? nextAlarmCountdown(alarm, now) : repeatLabel(alarm.days)}
                        openSwipeId={openAlarmSwipeId}
                        onSwipeOpen={handleAlarmSwipeOpen}
                        onEdit={() => openEditAlarm(alarm)}
                        onDelete={() => deleteAlarm(alarm)}
                        onToggle={() => {
                          setOpenAlarmSwipeId(null);
                          setAlarms((current) => current.map((item) => item.id === alarm.id ? { ...item, enabled: !item.enabled } : item));
                          trackEvent(alarm.enabled ? 'alarm_disabled' : 'alarm_enabled', { task: alarm.task, time: alarm.time });
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
        <View style={[styles.referenceTabBar, { width: windowWidth < 360 ? '90%' : '82%', minHeight: 60 * layoutScale, padding: 4 * layoutScale }]}>
          <TouchableOpacity accessibilityRole="button" accessibilityState={{ selected: true }} onPress={() => setScreen('home')} style={[styles.referenceTab, styles.referenceTabActive]}>
            <Text style={[styles.referenceTabIconActive, { fontSize: 24 * layoutScale }]} >◴</Text><Text style={[styles.referenceTabLabelActive, { fontSize: 11 * layoutScale }]}>Alarms</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" onPress={() => setScreen('stats')} style={styles.referenceTab}>
            <Text style={[styles.referenceTabIcon, { fontSize: 23 * layoutScale }]}>▥</Text><Text style={[styles.referenceTabLabel, { fontSize: 11 * layoutScale }]}>Stats</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" onPress={() => setScreen('settings')} style={styles.referenceTab}>
            <Text style={[styles.referenceTabIcon, { fontSize: 23 * layoutScale }]}>⚙</Text><Text style={[styles.referenceTabLabel, { fontSize: 11 * layoutScale }]}>Settings</Text>
          </TouchableOpacity>
        </View>
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
      setLinkingQr(false);
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
    const openPremium = () => {
      setPaywallReturnScreen('editor');
      setPlan('yearly');
      setPaywallStage('plans');
      setScreen('paywall');
    };
    const selectTask = (task: Task) => {
      if ((task === 'Shake' || task === 'QR scan') && !hasPremium) {
        openPremium();
        return;
      }
      setLinkingQr(false);
      setDraft((current) => ({ ...current, task }));
    };
    const chooseDeviceSong = async () => {
      if (!isNativeAlarmAvailable) {
        Alert.alert('Development build required', 'Custom alarm sounds need the Wayykup development build. Expo Go cannot keep a selected song available to the native alarm.');
        return;
      }
      try {
        const result = await DocumentPicker.getDocumentAsync({
          type: 'audio/*',
          copyToCacheDirectory: true,
        });
        if (result.canceled) return;
        const asset = result.assets[0];
        if (!asset) throw new Error('The selected audio file could not be read.');
        if (asset.mimeType && !asset.mimeType.startsWith('audio/')) {
          throw new Error('Choose an audio file to use as your alarm sound.');
        }
        const imported = await importAlarmSound(asset.uri, asset.name);
        setDraft((current) => ({
          ...current,
          sound: imported.displayName,
          customSoundUri: imported.uri,
          customSoundName: imported.name,
        }));
      } catch (error) {
        console.error('Phone audio could not be added as an alarm sound.', error);
        Alert.alert('Could not use that song', error instanceof Error ? error.message : 'Wayykup could not import the selected audio file.');
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
                  <View style={styles.sheetOptionCopy}><Text style={styles.sheetOptionTitle}>Sound</Text><Text style={styles.sheetOptionSubtitle}>{draft.sound}</Text></View>
                  <Text style={styles.sheetChevron}>{expandedEditorSection === 'sound' ? '⌄' : '›'}</Text>
                </TouchableOpacity>
                {expandedEditorSection === 'sound' && <View style={styles.sheetInlineOptions}>
                  {SOUNDS.map((sound) => <TouchableOpacity key={sound} onPress={() => setDraft((current) => ({ ...current, sound, customSoundUri: undefined, customSoundName: undefined }))} style={styles.sheetInlineOption}><Text style={[styles.sheetInlineText, draft.sound === sound && !draft.customSoundUri && styles.sheetInlineTextSelected]}>{sound}</Text>{draft.sound === sound && !draft.customSoundUri && <Text style={styles.sheetInlineCheck}>✓</Text>}</TouchableOpacity>)}
                  <TouchableOpacity accessibilityRole="button" onPress={() => { void chooseDeviceSong(); }} style={styles.sheetInlineOption}>
                    <Text style={[styles.sheetInlineText, draft.customSoundUri && styles.sheetInlineTextSelected]}>Choose from phone…</Text>
                    {draft.customSoundUri && <Text style={styles.sheetInlineCheck}>✓</Text>}
                  </TouchableOpacity>
                </View>}

                <TouchableOpacity onPress={() => setExpandedEditorSection(expandedEditorSection === 'task' ? null : 'task')} style={[styles.sheetOptionRow, styles.sheetOptionDivider]}>
                  <View style={styles.sheetOptionIcon}><Text style={styles.sheetOptionGlyph}>{TASKS.find((task) => task.name === draft.task)?.icon ?? '∑'}</Text></View>
                  <View style={styles.sheetOptionCopy}><Text style={styles.sheetOptionTitle}>Wake-Up Task</Text><Text style={styles.sheetOptionSubtitle}>{taskLabel(draft.task, draft)}</Text></View>
                  <Text style={styles.sheetChevron}>{expandedEditorSection === 'task' ? '⌄' : '›'}</Text>
                </TouchableOpacity>
                {expandedEditorSection === 'task' && TASKS.map((task) => {
                  const locked = !hasPremium && (task.name === 'Shake' || task.name === 'QR scan');
                  const selected = draft.task === task.name;
                  return (
                    <TouchableOpacity key={task.name} onPress={() => (locked ? openPremium() : selectTask(task.name))} style={styles.sheetInlineOption}>
                      <Text style={[styles.sheetInlineText, selected && styles.sheetInlineTextSelected]}>{taskLabel(task.name, draft)}</Text>
                      {locked ? <Text style={styles.sheetLock}>♙ Premium</Text> : selected ? <Text style={styles.sheetInlineCheck}>✓</Text> : null}
                    </TouchableOpacity>
                  );
                })}
                {expandedEditorSection === 'task' && draft.task === 'Math' && <View style={styles.sheetDifficulty}>{(['Easy', 'Medium', 'Hard'] as MathDifficulty[]).map((difficulty) => <TouchableOpacity key={difficulty} onPress={() => setDraft((current) => ({ ...current, mathDifficulty: difficulty }))} style={[styles.sheetDifficultyButton, draft.mathDifficulty === difficulty && styles.sheetDifficultySelected]}><Text style={[styles.sheetDifficultyText, draft.mathDifficulty === difficulty && styles.sheetDifficultyTextSelected]}>{difficulty}</Text></TouchableOpacity>)}</View>}
                {expandedEditorSection === 'task' && draft.task === 'Shake' && <View style={styles.sheetDifficulty}>{[50, 100, 200].map((count) => <TouchableOpacity key={count} onPress={() => setDraft((current) => ({ ...current, shakeCount: count }))} style={[styles.sheetDifficultyButton, draft.shakeCount === count && styles.sheetDifficultySelected]}><Text style={[styles.sheetDifficultyText, draft.shakeCount === count && styles.sheetDifficultyTextSelected]}>{count}</Text></TouchableOpacity>)}</View>}
                {expandedEditorSection === 'task' && draft.task === 'QR scan' && <View style={styles.qrLinkPanel}>
                  <Text style={styles.qrLinkLabel}>{draft.qrCode ? 'QR CODE LINKED' : 'LINK YOUR PHYSICAL QR CODE'}</Text>
                  {linkingQr && cameraPermission?.granted ? <><CameraView style={styles.linkCamera} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => { if (!data) return; setDraft((current) => ({ ...current, qrCode: data })); setLinkingQr(false); setQrError(''); }} /><TouchableOpacity onPress={() => setLinkingQr(false)}><Text style={styles.cancelScan}>CANCEL SCAN</Text></TouchableOpacity></> : <ActionButton label={draft.qrCode ? 'RE-LINK QR CODE' : 'SCAN YOUR QR CODE'} onPress={beginQrLinking} compact />}
                  {!!qrError && <Text style={styles.qrError}>{qrError}</Text>}
                </View>}
                {expandedEditorSection === 'task' && draft.task === 'Object Hunt' && <View style={styles.objectPickerPanel}>
                   <Text style={styles.qrLinkLabel}>CHOOSE OBJECTS TO FIND</Text>
                   <Text style={styles.objectPickerHint}>Wayykup will shuffle one target when the alarm rings and identify it from a camera photo.</Text>
                   <View style={styles.huntItemGrid}>
                     {HUNT_ITEMS.map((item) => {
                       const selected = draft.huntItems?.includes(item.name) ?? false;
                       return (
                         <TouchableOpacity
                           key={item.name}
                           accessibilityRole="checkbox"
                           accessibilityState={{ selected }}
                           onPress={() => {
                             const currentTargets = draft.huntItems ?? [];
                             const nextTargets = selected
                               ? currentTargets.filter((target) => target !== item.name)
                               : [...currentTargets, item.name];
                             setDraft((current) => ({
                               ...current,
                               huntItems: nextTargets,
                               huntTarget: selected
                                 ? nextTargets[0] ?? ''
                                 : item.name,
                             }));
                           }}
                           style={[styles.huntItemOption, selected && styles.huntItemOptionSelected]}
                         >
                           <Text style={styles.huntItemEmoji}>{item.image}</Text>
                           <Text style={[styles.huntItemName, selected && styles.huntItemNameSelected]}>{item.name}</Text>
                           {selected && <Text style={styles.huntItemCheck}>✓</Text>}
                         </TouchableOpacity>
                       );
                     })}
                   </View>
                </View>}
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

  const renderAlarm = () => {
    const mathChallenge = MATH_CHALLENGES[lastAlarm.mathDifficulty];
    const huntTarget = activeHuntTarget ?? lastAlarm.huntTarget ?? lastAlarm.huntItems?.[0] ?? 'your object';
    const submitAnswer = () => {
      if (Number(answer) === mathChallenge.answer) {
        setMathAttempts((count) => count + 1);
        setMathCorrect((count) => count + 1);
        finishChallenge(true);
      } else {
        recordChallengeFailure(true);
        setAnswer('');
      }
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
    return (
      <SafeAreaView style={styles.alarmScreen}>
        <ScrollView contentContainerStyle={styles.alarmContent} keyboardShouldPersistTaps="handled">
          <View style={styles.alarmScreenTop}><View style={styles.liveAlarmDot} /><Text style={styles.alarmScreenStatus}>WAKE-UP PROTOCOL ACTIVE</Text><Text style={styles.alarmScreenNumber}>01 / 01</Text></View>
          <Text style={styles.alarmBigTime}>{lastAlarm.time}</Text>
          <View style={styles.alarmRule}><View style={styles.ruleAccent} /><Text style={styles.alarmRuleText}>GET UP. GET IT DONE.</Text></View>
          <View style={styles.challengeCard}>
            <View style={styles.challengeHeader}><Text style={styles.challengeLabel}>YOUR CHALLENGE</Text><Tag dark>{lastAlarm.task.toUpperCase()}</Tag></View>
            {lastAlarm.task === 'Math' && (
              <View style={styles.challengeBody}>
                <Text style={styles.challengePrompt}>NO CALCULATOR.{'\n'}NO EXCUSES.</Text>
                <Text style={styles.mathProblem}>{mathChallenge.equation} = ?</Text>
                <TextInput value={answer} onChangeText={setAnswer} keyboardType="number-pad" placeholder="YOUR ANSWER" placeholderTextColor="#6F6C68" style={styles.answerInput} returnKeyType="done" onSubmitEditing={submitAnswer} />
                {wrongAnswers > 0 && <Text style={styles.wrongAnswer}>WRONG. VOLUME UP × {wrongAnswers + 1}</Text>}
                <ActionButton label="SUBMIT ANSWER" onPress={submitAnswer} />
              </View>
            )}
            {lastAlarm.task === 'Object Hunt' && (
              <View style={styles.challengeBody}>
                {huntRecognized ? (
                  <View
                    accessibilityRole="summary"
                    accessibilityLabel={`Object recognized: ${huntTarget}`}
                    style={styles.objectRecognizedCard}
                  >
                    <Text style={styles.objectRecognizedCheck}>✓</Text>
                    <Text style={styles.objectRecognizedTitle}>OBJECT RECOGNIZED</Text>
                    <Text style={styles.objectRecognizedName}>{huntTarget.toUpperCase()}</Text>
                  </View>
                ) : cameraPermission?.granted ? (
                  <ObjectHuntCamera
                    target={huntTarget}
                    onRecognized={(target) => {
                      setHuntRecognized(true);
                      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
                        .catch((error: unknown) => console.warn('Object-recognition haptic failed:', error));
                      trackEvent('object_hunt_object_recognized', { target });
                    }}
                    onFailedAttempt={recordChallengeFailure}
                  />
                ) : (
                  <TouchableOpacity onPress={allowObjectHuntCamera} style={styles.cameraPermissionPrompt}>
                    <Text style={styles.scanGlyph}>⌕</Text><Text style={styles.shakeButtonText}>ALLOW CAMERA ACCESS</Text>
                  </TouchableOpacity>
                )}
                {!huntRecognized && <Text style={styles.challengePrompt}>FIND YOUR {huntTarget.toUpperCase()}.{'\n'}CENTER IT AND TAKE A PHOTO.</Text>}
                {!!huntRecognitionMessage && !cameraPermission?.granted && (
                  <Text style={styles.huntRecognitionMessage}>{huntRecognitionMessage}</Text>
                )}
              </View>
            )}
            {lastAlarm.task === 'Toothbrush' && (
              <View style={styles.challengeBody}>
                <Text style={styles.challengePrompt}>BRUSH FOR TWO MINUTES.</Text>
                <Text style={styles.brushingTimer}>
                  {Math.floor(brushingSeconds / 60)}:{String(brushingSeconds % 60).padStart(2, '0')}
                </Text>
                <View style={styles.shakeMeter}>
                  <View style={[styles.shakeFill, { width: `${((BRUSHING_DURATION_SECONDS - brushingSeconds) / BRUSHING_DURATION_SECONDS) * 100}%` }]} />
                </View>
                <Text style={styles.simulationNote}>KEEP BRUSHING. THE ALARM STOPS WHEN THE TIMER ENDS.</Text>
              </View>
            )}
            {(lastAlarm.task === 'Push-ups' || lastAlarm.task === 'Squats') && (
              <View style={styles.challengeBody}>
                <Text style={styles.challengePrompt}>COMPLETE TEN{'\n'}CONTROLLED REPS.</Text>
                <View style={styles.shakeMeter}>
                  <View style={[styles.shakeFill, { width: `${(exerciseReps / EXERCISE_REP_TARGET) * 100}%` }]} />
                </View>
                <Text style={styles.shakeCount}>
                  {String(exerciseReps).padStart(2, '0')} <Text style={styles.shakeTotal}>/ {EXERCISE_REP_TARGET}</Text>
                </Text>
                <Text style={styles.simulationNote}>
                  {sensorAvailable ? 'KEEP YOUR PHONE SECURE ON YOUR BODY AND MOVE THROUGH EACH REP.' : 'MOTION SENSING IS UNAVAILABLE ON THIS DEVICE.'}
                </Text>
                {!sensorAvailable && <TouchableOpacity onPress={() => setExerciseReps((count) => Math.min(count + 1, EXERCISE_REP_TARGET))} style={styles.shakeButton}><Text style={styles.shakeButtonText}>LOG COMPLETED REP</Text></TouchableOpacity>}
                {__DEV__ && sensorAvailable && <TouchableOpacity onPress={() => setExerciseReps((count) => Math.min(count + 1, EXERCISE_REP_TARGET))} style={styles.shakeButton}><Text style={styles.shakeButtonText}>SIMULATE ONE REP</Text></TouchableOpacity>}
              </View>
            )}
            {lastAlarm.task === 'Shake' && (
              <View style={styles.challengeBody}>
                <Text style={styles.challengePrompt}>SHAKE IT OFF.</Text>
                <View style={styles.shakeMeter}><View style={[styles.shakeFill, { width: `${Math.min(shakeCount / lastAlarm.shakeCount, 1) * 100}%` }]} /></View>
                <Text style={styles.shakeCount}>{String(Math.min(shakeCount, lastAlarm.shakeCount)).padStart(2, '0')} <Text style={styles.shakeTotal}>/ {lastAlarm.shakeCount}</Text></Text>
                <Text style={styles.simulationNote}>{sensorAvailable ? 'SHAKE YOUR PHONE TO FILL THE METER.' : 'Accelerometer is unavailable on this device.'}</Text>
                {__DEV__ && <TouchableOpacity onPress={() => setShakeCount((count) => Math.min(count + 5, lastAlarm.shakeCount))} style={styles.shakeButton}><Text style={styles.shakeButtonIcon}>↯</Text><Text style={styles.shakeButtonText}>SIMULATE FIVE SHAKES</Text></TouchableOpacity>}
              </View>
            )}
            {lastAlarm.task === 'QR scan' && (
              <View style={styles.challengeBody}>
                {cameraPermission?.granted ? (
                  <CameraView
                    style={styles.alarmCamera}
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={({ data }) => {
                      if (qrScanned) return;
                      setQrScanned(true);
                      if (data === lastAlarm.qrCode) finishChallenge();
                      else {
                        setQrError('That is not your linked QR code. Keep looking.');
                        setTimeout(() => setQrScanned(false), 1200);
                      }
                    }}
                  />
                ) : (
                  <TouchableOpacity onPress={() => {
                    requestCameraPermission()
                      .then((permission) => {
                        if (!permission.granted) setQrError('Camera permission is needed to scan your linked code.');
                      })
                      .catch((error: unknown) => {
                        console.error('Camera permission request failed.', error);
                        setQrError('Camera access is unavailable on this device.');
                      });
                  }} style={styles.cameraPermissionPrompt}>
                    <Text style={styles.scanGlyph}>▦</Text><Text style={styles.shakeButtonText}>ALLOW CAMERA ACCESS</Text>
                  </TouchableOpacity>
                )}
                <Text style={styles.challengePrompt}>FIND YOUR QR CODE{'\n'}TO STOP THE ALARM.</Text>
                {!!qrError && <Text style={styles.qrError}>{qrError}</Text>}
              </View>
            )}
            {lastAlarm.task === 'Memory' && (
              <View style={styles.challengeBody}>
                <Text style={styles.challengePrompt}>REPEAT THE{'\n'}SEQUENCE.</Text>
                <View style={styles.memoryPattern}>{['1', '3', '2'].map((digit, index) => <View key={digit} style={[styles.memoryTile, index === 1 && memorySequenceVisible && styles.memoryTileActive]}><Text style={[styles.memoryDigit, index === 1 && memorySequenceVisible && styles.memoryDigitActive]}>{memorySequenceVisible ? digit : '·'}</Text></View>)}</View>
                <Text style={styles.simulationNote}>ENTER THE SEQUENCE: {memoryEntry || '—'}</Text>
                <View style={styles.memoryKeypad}>{['1', '2', '3'].map((digit) => <TouchableOpacity key={digit} onPress={() => {
                  const nextEntry = `${memoryEntry}${digit}`;
                  if (nextEntry.length === 3) {
                    if (nextEntry === '132') finishChallenge();
                    else {
                      setMemoryEntry('');
                      recordChallengeFailure();
                    }
                  } else {
                    setMemoryEntry(nextEntry);
                  }
                }} style={styles.memoryKey}><Text style={styles.memoryKeyText}>{digit}</Text></TouchableOpacity>)}</View>
                {wrongAnswers > 0 && <Text style={styles.wrongAnswer}>WRONG SEQUENCE. TRY AGAIN.</Text>}
              </View>
            )}
          </View>
          {lastAlarm.savage && <TouchableOpacity onPress={snoozeAlarm} style={styles.snoozeButton}><Text style={styles.snoozeText}>SNOOZE 5 MIN · VOLUME PENALTY +{snoozeLevel + 1}</Text></TouchableOpacity>}
          <TouchableOpacity accessibilityRole="button" onPress={emergencyBypass} style={styles.emergencyBypass}>
            <Text style={styles.emergencyBypassText}>EMERGENCY BYPASS</Text>
          </TouchableOpacity>
          <View style={styles.alarmScreenFoot}><Text style={styles.alarmFootMark}>S.</Text><Text style={styles.alarmFootText}>NO EXIT UNTIL IT’S DONE.</Text></View>
        </ScrollView>
        <Modal
          visible={challengeShuffleVisible}
          transparent
          animationType="fade"
          statusBarTranslucent
          onRequestClose={() => {}}
        >
          <View style={styles.challengeShuffleOverlay} accessibilityViewIsModal accessibilityLabel="Challenge shuffle in progress">
            <Text style={styles.challengeShuffleEyebrow}>WAKE-UP CHALLENGE</Text>
            <Text style={styles.challengeShuffleTitle}>SHUFFLING OBJECTS</Text>
            <View style={styles.challengeShuffleCard}>
              <Text style={styles.challengeShuffleEmoji}>
                {HUNT_ITEMS.find((item) => item.name === shuffleDisplayTarget)?.image ?? '⌕'}
              </Text>
              <Text style={styles.challengeShuffleName}>
                {(shuffleDisplayTarget ?? 'GET READY').toUpperCase()}
              </Text>
            </View>
            <Text style={styles.challengeShuffleHint}>THE ALARM STAYS ON UNTIL WAYYKUP RECOGNIZES YOUR TARGET.</Text>
          </View>
        </Modal>
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
        showSettingsNotice('Camera access is off', 'Allow camera access in your device settings to use QR scanning.');
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
              <Text style={styles.settingsListDetail}>Complete the test challenge before scheduling your first alarm.</Text>
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
              <Text style={styles.settingsListLabel}>Wayykup Pro · {plan === 'yearly' ? 'Yearly' : plan === 'monthly' ? 'Monthly' : 'Weekly'}</Text>
              <Text style={styles.settingsListDetail}>{hasPremium ? 'Subscription managed by RevenueCat.' : 'Unlock the complete Wayykup experience.'}</Text>
            </View>
          </View>
          <TouchableOpacity onPress={() => { setPaywallReturnScreen('settings'); setPlan('yearly'); setPaywallStage('plans'); setScreen('paywall'); }} style={styles.settingsManagePlan}>
            <Text style={styles.settingsManagePlanText}>{hasPremium ? 'MANAGE SUBSCRIPTION' : 'VIEW PLANS'}  ›</Text>
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
            <View style={styles.settingsListIcon}><Text style={styles.settingsListIconText}>W.</Text></View>
            <Text style={styles.settingsListLabel}>Wayykup</Text>
            <Text style={styles.settingsListStatus}>Version 1.0.0</Text>
          </View>
        </View>
      </ScrollView>
      <View style={styles.referenceTabBar}>
        <TouchableOpacity accessibilityRole="button" onPress={() => setScreen('home')} style={styles.referenceTab}>
          <Text style={styles.referenceTabIcon}>◴</Text><Text style={styles.referenceTabLabel}>Alarms</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" onPress={() => setScreen('stats')} style={styles.referenceTab}>
          <Text style={styles.referenceTabIcon}>▥</Text><Text style={styles.referenceTabLabel}>Stats</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityState={{ selected: true }} onPress={() => setScreen('settings')} style={[styles.referenceTab, styles.referenceTabActive]}>
          <Text style={styles.referenceTabIconActive}>⚙</Text><Text style={styles.referenceTabLabelActive}>Settings</Text>
        </TouchableOpacity>
      </View>
      {Platform.OS === 'web' && <View style={styles.referenceHomeIndicator}><View style={styles.referenceHomeIndicatorLine} /></View>}
      <StatusBar barStyle="dark-content" />
    </SafeAreaView>
  );

  const renderPlansModal = () => {
    const annualPackage = availablePackages.find((item) => item.packageType === Purchases.PACKAGE_TYPE.ANNUAL);
    const monthlyPackage = availablePackages.find((item) => item.packageType === Purchases.PACKAGE_TYPE.MONTHLY);
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
            <TouchableOpacity
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
                    <Text style={styles.plansPrice}>{annualPackage?.product.priceString ?? 'Unavailable'} /yr</Text>
                    {!!annualPackage?.product.pricePerMonthString && (
                      <Text style={styles.plansMonthlyEquivalent}>{annualPackage.product.pricePerMonthString}/mo</Text>
                    )}
                  </View>
                </View>
                <View style={[styles.plansRadio, plan === 'yearly' && styles.plansRadioSelected]}>
                  {plan === 'yearly' && <View style={styles.plansRadioDot} />}
                </View>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => setPlan('monthly')}
              style={[styles.plansOption, plan === 'monthly' && styles.plansOptionSelected]}
            >
              <View style={styles.plansOptionBody}>
                <View style={styles.plansOptionCopy}>
                  <Text style={styles.plansOptionTitle}>Monthly Plan</Text>
                  <Text style={styles.plansPrice}>{monthlyPackage?.product.priceString ?? 'Unavailable'} /mo</Text>
                </View>
                <View style={[styles.plansRadio, plan === 'monthly' && styles.plansRadioSelected]}>
                  {plan === 'monthly' && <View style={styles.plansRadioDot} />}
                </View>
              </View>
            </TouchableOpacity>
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

  const screenContent = !startupProgressLoaded
    ? <View style={styles.startupLoading}><Text style={styles.wordmark}>WAYYKUP<Text style={styles.wordmarkDot}>.</Text></Text></View>
    : screen === 'welcome'
    ? <OnboardingFlow onComplete={completeOnboarding} trackEvent={trackEvent} reduceMotion={reduceMotion} />
    : screen === 'proof'
      ? <SafeAreaView style={styles.safeArea}>{renderProof()}<StatusBar barStyle="dark-content" /></SafeAreaView>
      : screen === 'paywall'
      ? <View style={[styles.safeArea, { paddingTop: Math.max(insets.top, 12), paddingBottom: Math.max(insets.bottom, 8) }]}>{renderPaywall()}{renderPlansModal()}<StatusBar barStyle="dark-content" /></View>
        : screen === 'home' || screen === 'editor'
          ? renderHome()
          : screen === 'alarm'
            ? renderAlarm()
              : screen === 'streak'
                ? renderStreakMoment()
                : screen === 'stats'
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
  safeArea: { flex: 1, backgroundColor: PAPER },
  onboarding: { flex: 1, backgroundColor: PAPER, paddingHorizontal: 26, paddingTop: 16, paddingBottom: 18, justifyContent: 'space-between' },
  onboardingTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
  paywall: { paddingHorizontal: 23, paddingTop: 16, paddingBottom: 25 },
  trialIntroScroll: { flex: 1, backgroundColor: '#F1F0F6' },
  trialIntro: { flexGrow: 1, backgroundColor: '#F1F0F6', paddingHorizontal: 24, paddingTop: 20, paddingBottom: 13, alignItems: 'center' },
  trialIntroCompact: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 },
  trialReminder: { flexGrow: 1, backgroundColor: '#F1F0F6', paddingHorizontal: 33, paddingTop: 10, paddingBottom: 13, alignItems: 'center', justifyContent: 'space-between' },
  trialReminderCompact: { paddingHorizontal: 24, paddingTop: 2, paddingBottom: 8 },
  trialReminderBack: { alignSelf: 'flex-start', width: 40, height: 45, justifyContent: 'center' },
  trialReminderBackGlyph: { color: '#171018', fontSize: 46, lineHeight: 50, fontWeight: '300' },
  trialReminderTitle: { width: '100%', color: '#171018', fontFamily: 'Georgia', fontWeight: '700', textAlign: 'center', marginTop: 14 },
  trialReminderArt: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center', minHeight: 200 },
  proTrialScreen: { flexGrow: 1, backgroundColor: '#F1F0F6', paddingHorizontal: 27, paddingTop: 5, paddingBottom: 15, justifyContent: 'space-between' },
  proTrialScreenCompact: { paddingHorizontal: 20, paddingTop: 0, paddingBottom: 8 },
  proTrialHeader: { width: '100%', minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  proTrialBack: { width: 42, height: 42, justifyContent: 'center' },
  proTrialBackGlyph: { color: '#171018', fontSize: 43, lineHeight: 47, fontWeight: '300' },
  proTrialRestore: { color: '#171018', fontSize: 13, fontWeight: '600', textDecorationLine: 'underline' },
  proTrialClose: { width: 38, height: 42, alignItems: 'flex-end', justifyContent: 'center' },
  proTrialCloseGlyph: { color: '#171018', fontSize: 32, lineHeight: 36, fontWeight: '300' },
  proTrialContent: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 10, paddingBottom: 12 },
  proTrialAlarmIcon: { width: 76, height: 76, borderRadius: 38, backgroundColor: '#F9A13C', alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  proTrialTitle: { color: '#171018', fontFamily: 'Georgia', fontSize: 35, lineHeight: 40, fontWeight: '700', textAlign: 'center' },
  proTrialPrice: { color: '#171018', fontSize: 16, fontWeight: '700', textAlign: 'center', marginTop: 10 },
  proTrialBilled: { color: '#68636D', fontSize: 12, textAlign: 'center', marginTop: 3 },
  proTrialUnavailable: { color: '#8E3B32', fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 7 },
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
  giftOfferScreen: { flexGrow: 1, backgroundColor: '#F1F0F6', paddingHorizontal: 28, paddingTop: 32, paddingBottom: 8, justifyContent: 'space-between', alignItems: 'center' },
  giftOfferScreenCompact: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 4 },
  giftOfferTitle: { width: '100%', color: '#171018', fontFamily: 'Georgia', fontWeight: '700', textAlign: 'center' },
  giftArtworkStage: { width: '100%', maxWidth: 390, minHeight: 230, alignSelf: 'center', justifyContent: 'center', alignItems: 'center' },
  giftSparkle: { position: 'absolute', zIndex: 1, color: '#F1A21B', fontSize: 28, fontWeight: '700' },
  giftSparkleLeft: { left: '12%', top: '25%' },
  giftSparkleRight: { right: '12%', top: '38%', fontSize: 21 },
  giftOfferFooter: { width: '100%', alignItems: 'center' },
  giftOfferClaim: { width: '100%', minHeight: 66, borderRadius: 38, backgroundColor: '#E93436', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, shadowColor: '#E93436', shadowOpacity: 0.27, shadowRadius: 13, shadowOffset: { width: 0, height: 6 }, elevation: 5 },
  giftOfferClaimText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  giftOfferContinue: { width: '100%', minHeight: 58, borderRadius: 34, borderWidth: 2, borderColor: '#171018', alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  giftOfferContinueText: { color: '#171018', fontSize: 16, fontWeight: '700' },
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
  paywallTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  paywallHero: { marginTop: 29 },
  paywallSeal: { position: 'absolute', right: 4, top: 6, width: 68, height: 68, borderRadius: 34, backgroundColor: INK, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '7deg' }] },
  sealIcon: { color: RED, fontSize: 20, lineHeight: 21 },
  sealLabel: { color: '#FFFFFF', fontSize: 7, lineHeight: 9, fontWeight: '900', textAlign: 'center', letterSpacing: 1 },
  paywallTitle: { color: INK, fontSize: 40, lineHeight: 42, fontWeight: '900', letterSpacing: -1.5 },
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
  discountCard: { marginTop: 14, backgroundColor: '#FFF7F3', borderRadius: 12, borderWidth: 1, borderColor: '#F7D8CD', padding: 14 },
  discountBanner: { color: RED, fontSize: 8, fontWeight: '900', letterSpacing: 1.2, marginBottom: 8 },
  discountProduct: { color: INK, fontSize: 18, fontWeight: '900' },
  discountPrice: { color: INK, fontSize: 26, fontWeight: '900', marginTop: 4, letterSpacing: -0.8 },
  discountDetail: { color: MUTED, fontSize: 10, lineHeight: 16, marginTop: 6 },
  waterfallActions: { marginTop: 18, gap: 7 },
  perkList: { marginTop: 19, marginBottom: 17, borderTopWidth: 1, borderColor: '#E1DFDA' },
  perkRow: { flexDirection: 'row', alignItems: 'center', minHeight: 58, borderBottomWidth: 1, borderColor: '#E1DFDA' },
  perkIcon: { width: 31, height: 31, borderRadius: 16, backgroundColor: '#FBE8E5', alignItems: 'center', justifyContent: 'center', marginRight: 11 },
  perkIconText: { color: RED, fontSize: 16, fontWeight: '700' },
  perkCopy: { flex: 1 },
  perkTitle: { color: INK, fontSize: 12, fontWeight: '800' },
  perkDetail: { color: MUTED, fontSize: 10, marginTop: 3 },
  checkmark: { color: RED, fontSize: 15, fontWeight: '800', marginRight: 5 },
  planOptions: { gap: 8, marginBottom: 15 },
  planCard: { position: 'relative', borderWidth: 1, borderColor: '#DEDBD6', backgroundColor: '#FFFFFF', borderRadius: 5, paddingVertical: 11, paddingHorizontal: 13 },
  planSelected: { borderWidth: 1.5, borderColor: RED, backgroundColor: '#FFFBFA' },
  planHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 },
  planName: { color: INK, fontSize: 9, fontWeight: '900', letterSpacing: 1.5 },
  weeklyLabel: { color: '#8B8781', fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  planPriceLine: { flexDirection: 'row', alignItems: 'baseline' },
  planPrice: { color: INK, fontSize: 20, fontWeight: '900', letterSpacing: -0.5 },
  planPeriod: { color: MUTED, fontSize: 11 },
  planSub: { color: MUTED, fontSize: 9, marginTop: 2 },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: '#C6C1BA', alignItems: 'center', justifyContent: 'center' },
  planCardRadio: { position: 'absolute', right: 13, top: 28 },
  radioOn: { borderColor: RED },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: RED },
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
  alarmSwipeActionReveal: { position: 'absolute', top: 0, bottom: 0 },
  alarmSwipeAction: { alignItems: 'center', justifyContent: 'center' },
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
  referenceTabBar: { width: '82%', maxWidth: 360, minHeight: 60, alignSelf: 'center', marginBottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', padding: 4, borderRadius: 36, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#FFFFFF', shadowColor: '#555555', shadowOpacity: 0.12, shadowRadius: 18, shadowOffset: { width: 0, height: 5 }, elevation: 5 },
  referenceTab: { flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', borderRadius: 32, gap: 1 },
  referenceTabActive: { backgroundColor: '#FFF0F0' },
  referenceTabIcon: { color: '#77777D', fontSize: 23, lineHeight: 26 },
  referenceTabLabel: { color: '#77777D', fontSize: 11, fontWeight: '600' },
  referenceTabIconActive: { color: '#FF1717', fontSize: 24, lineHeight: 26 },
  referenceTabLabelActive: { color: '#F31616', fontSize: 11, fontWeight: '600' },
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
  qrLinkPanel: { padding: 10, backgroundColor: '#F1EFEB', borderRadius: 4, marginTop: 2 },
  objectPickerPanel: { padding: 10, backgroundColor: '#F1EFEB', borderRadius: 4, marginTop: 2 },
  qrLinkLabel: { color: INK, fontSize: 8, fontWeight: '900', letterSpacing: 1, marginBottom: 8 },
  objectPickerHint: { color: MUTED, fontSize: 9, lineHeight: 14, marginBottom: 8 },
  linkCamera: { width: '100%', height: 190, borderRadius: 4, overflow: 'hidden' },
  huntItemGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  huntItemOption: { width: '23%', minHeight: 54, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#D5D1D8', borderRadius: 7, backgroundColor: '#FFFFFF', paddingHorizontal: 2 },
  huntItemOptionSelected: { borderColor: '#168A4A', backgroundColor: '#E8F8EE' },
  huntItemEmoji: { fontSize: 18 },
  huntItemName: { color: '#706C66', fontSize: 7, fontWeight: '700', marginTop: 2, textAlign: 'center' },
  huntItemNameSelected: { color: '#116B3A' },
  huntItemCheck: { position: 'absolute', top: 2, right: 4, color: '#168A4A', fontSize: 9, fontWeight: '900' },
  cancelScan: { color: RED, fontSize: 8, fontWeight: '900', textAlign: 'center', padding: 10, letterSpacing: 1 },
  qrError: { color: '#E65B4D', fontSize: 9, fontWeight: '700', textAlign: 'center', marginVertical: 8 },
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
  sheetInlineText: { color: '#55555B', fontSize: 13 },
  sheetInlineTextSelected: { color: '#FF1717', fontWeight: '700' },
  sheetInlineCheck: { color: '#FF1717', fontSize: 17, fontWeight: '700' },
  sheetLock: { color: '#929299', fontSize: 11, fontWeight: '600' },
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
  mathProblem: { color: '#FFFFFF', fontSize: 26, fontWeight: '900', marginVertical: 18, letterSpacing: 0.5 },
  answerInput: { width: '100%', height: 48, backgroundColor: '#292724', borderWidth: 1, borderColor: '#514C46', borderRadius: 4, textAlign: 'center', color: '#FFFFFF', fontSize: 17, fontWeight: '800', letterSpacing: 2, marginBottom: 11 },
  wrongAnswer: { color: '#FF8072', fontSize: 9, fontWeight: '900', letterSpacing: 1, marginBottom: 11 },
  shakeMeter: { width: '100%', height: 9, borderRadius: 5, backgroundColor: '#373431', overflow: 'hidden', marginTop: 25 },
  shakeFill: { height: 9, backgroundColor: RED, borderRadius: 5 },
  shakeCount: { color: '#FFFFFF', fontSize: 32, fontWeight: '900', marginVertical: 12 },
  shakeTotal: { color: '#918C85', fontSize: 15, fontWeight: '700' },
  brushingTimer: { color: '#FFFFFF', fontSize: 58, fontWeight: '900', letterSpacing: -2, marginTop: 17 },
  shakeButton: { width: '100%', minHeight: 61, backgroundColor: RED, borderRadius: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  cameraButtonDisabled: { opacity: 0.55 },
  shakeButtonIcon: { color: '#FFFFFF', fontSize: 19, marginRight: 8 },
  shakeButtonText: { color: '#FFFFFF', fontSize: 9, fontWeight: '900', letterSpacing: 1.1 },
  simulationNote: { color: '#8D8881', fontSize: 8, marginTop: 12, marginBottom: 13, textAlign: 'center' },
  alarmCamera: { width: '100%', height: 220, marginBottom: 16, borderRadius: 4, overflow: 'hidden' },
  objectCaptureButton: { width: '100%', minHeight: 48, backgroundColor: RED, alignItems: 'center', justifyContent: 'center', borderRadius: 5, marginBottom: 12 },
  objectCaptureButtonText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  huntRecognitionMessage: { color: '#FFC2B8', fontSize: 9, lineHeight: 14, fontWeight: '900', textAlign: 'center', letterSpacing: 0.5, marginTop: 6 },
  cameraPermissionPrompt: { width: '100%', height: 145, alignItems: 'center', justifyContent: 'center', backgroundColor: '#292724', marginBottom: 14, borderRadius: 4 },
  fakeScanner: { width: 146, height: 146, backgroundColor: '#262421', marginBottom: 18, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  scanGlyph: { color: '#FFFFFF', fontSize: 63, fontWeight: '300' },
  objectRecognizedCard: { width: '100%', minHeight: 220, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E7F8EE', borderColor: '#43B76B', borderWidth: 2, borderRadius: 12, marginBottom: 14, padding: 20 },
  objectRecognizedCheck: { width: 58, height: 58, overflow: 'hidden', borderRadius: 30, backgroundColor: '#168A4A', color: '#FFFFFF', textAlign: 'center', textAlignVertical: 'center', fontSize: 40, fontWeight: '900', marginBottom: 12 },
  objectRecognizedTitle: { color: '#116B3A', fontSize: 13, fontWeight: '900', letterSpacing: 1.2, textAlign: 'center' },
  objectRecognizedName: { color: '#174B2F', fontSize: 20, fontWeight: '900', marginTop: 8 },
  challengeShuffleOverlay: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: 'rgba(20, 12, 12, 0.96)' },
  challengeShuffleEyebrow: { color: '#FFC8BD', fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  challengeShuffleTitle: { color: '#FFFFFF', fontSize: 25, fontWeight: '900', letterSpacing: 1, marginTop: 10, textAlign: 'center' },
  challengeShuffleCard: { width: '100%', maxWidth: 300, minHeight: 220, alignItems: 'center', justifyContent: 'center', backgroundColor: '#2A2221', borderColor: '#FF8072', borderWidth: 1, borderRadius: 18, marginVertical: 28 },
  challengeShuffleEmoji: { fontSize: 68 },
  challengeShuffleName: { color: '#FFFFFF', fontSize: 21, fontWeight: '900', letterSpacing: 1.2, marginTop: 12 },
  challengeShuffleHint: { maxWidth: 280, color: '#F2DAD6', fontSize: 11, fontWeight: '800', letterSpacing: 1, lineHeight: 17, textAlign: 'center' },
  scanLine: { position: 'absolute', left: 12, right: 12, height: 1, backgroundColor: RED },
  scanCornerTopLeft: { position: 'absolute', left: 9, top: 9, width: 18, height: 18, borderLeftWidth: 3, borderTopWidth: 3, borderColor: RED },
  scanCornerTopRight: { position: 'absolute', right: 9, top: 9, width: 18, height: 18, borderRightWidth: 3, borderTopWidth: 3, borderColor: RED },
  scanCornerBottomLeft: { position: 'absolute', left: 9, bottom: 9, width: 18, height: 18, borderLeftWidth: 3, borderBottomWidth: 3, borderColor: RED },
  scanCornerBottomRight: { position: 'absolute', right: 9, bottom: 9, width: 18, height: 18, borderRightWidth: 3, borderBottomWidth: 3, borderColor: RED },
  memoryPattern: { flexDirection: 'row', gap: 9, marginTop: 19, marginBottom: 7 },
  memoryKeypad: { flexDirection: 'row', gap: 9, marginTop: 9 },
  memoryKey: { width: 58, height: 48, borderRadius: 4, backgroundColor: '#373431', alignItems: 'center', justifyContent: 'center' },
  memoryKeyText: { color: '#FFFFFF', fontSize: 18, fontWeight: '900' },
  memoryTile: { width: 52, height: 52, borderRadius: 5, backgroundColor: '#393633', alignItems: 'center', justifyContent: 'center' },
  memoryTileActive: { backgroundColor: RED },
  memoryDigit: { color: '#D1CCC5', fontSize: 17, fontWeight: '900' },
  memoryDigitActive: { color: '#FFFFFF' },
  snoozeButton: { marginTop: 12, borderWidth: 1, borderColor: '#FFCAC2', borderRadius: 4, minHeight: 42, justifyContent: 'center', alignItems: 'center' },
  snoozeText: { color: '#FFFFFF', fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  emergencyBypass: { alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 },
  emergencyBypassText: { color: '#FFDAD4', fontSize: 10, fontWeight: '800', letterSpacing: 1.1, textDecorationLine: 'underline' },
  alarmScreenFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 'auto', paddingTop: 17 },
  alarmFootMark: { color: '#FFFFFF', fontSize: 14, fontWeight: '900', marginRight: 7 },
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
