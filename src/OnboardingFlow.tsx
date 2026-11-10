import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Linking,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View,
  useWindowDimensions,
  type ScrollViewInstance,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
                                                                                                                                                                    import { useCameraPermissions } from 'expo-camera';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import Svg, { Circle, ClipPath, Defs, Ellipse, G, Path } from 'react-native-svg';
import { ALARM_SOUNDS, alarmSoundAsset } from './alarmSounds';
import {
  DEFAULT_ALARM_SOUND_ID,
  isAlarmSoundId,
  migrateAlarmSoundId,
  type AlarmSoundId,
} from './alarmSoundIds';
import {
  getAlarmHealth,
  persistKeepAlarmPlayingPreference,
  requestAlarmNotifications,
  type AlarmRecord,
} from './nativeServices';
import { chooseHuntTargetForDifficulty, huntTargetsForDifficulty, HUNT_ITEMS } from './challenges/objects';
import { WayykupIcon } from './components/WayykupIcon';
import {
  CHALLENGE_OPTIONS,
  type ChallengeConfiguration,
  type ObjectHuntDifficulty,
} from './challenges/registry';

const RED = '#F29A00';
const INK = '#1A131A';
const MUTED = '#89868D';
const AnimatedTouchableOpacity = Animated.createAnimatedComponent(TouchableOpacity);
const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const SOUND_CATEGORIES = [...new Set(ALARM_SOUNDS.map((sound) => sound.category))];
const TESTIMONIALS = [
  { quote: 'This app changed my morning.', author: 'Wayykup user' },
  { quote: 'I got up so fast.', author: 'Arga meja' },
];
const STEPS = [
  'welcome',
  'source',
  'rating',
  'age',
  'gender',
  'wakeTime',
  'reason',
  'bedTime',
  'alarmReaction',
  'value',
  'alarmCount',
  'help',
  'savings',
  'reframe',
  'setup',
  'time',
  'repeat',
  'sound',
  'notifications',
  'challenge',
  'homeItems',
  'cameraAccess',
  'objectPick',
  'alarmPlayback',
  'commitIntro',
  'commit',
  'fingerprint',
] as const;

type Step = typeof STEPS[number];
type WakeTask = (typeof CHALLENGE_OPTIONS)[number]['task'];
type Answers = {
  source: string;
  rating: string;
  age: string;
  gender: string;
  wakeTime: string;
  reason: string;
  bedTime: string;
  alarmReaction: string;
  alarmCount: string;
  help: string;
};

const ANSWER_KEYS: (keyof Answers)[] = [
  'source',
  'rating',
  'age',
  'gender',
  'wakeTime',
  'reason',
  'bedTime',
  'alarmReaction',
  'alarmCount',
  'help',
];

const CHALLENGE_ART = {
  yell_to_stop: { art: 'yell', color: '#DDF3E5' },
  push_up: { art: 'pushups', color: '#E6F1E7' },
  shake_phone: { art: 'shake', color: '#E2F4EC' },
  object_hunt: { art: 'object', color: '#E7F5E9' },
} as const;
const CHALLENGES = CHALLENGE_OPTIONS.map((challenge) => ({
  ...challenge,
  ...CHALLENGE_ART[challenge.type],
  difficulty: challenge.difficulty.toUpperCase(),
  duration: challenge.duration.toUpperCase(),
}));
const ONBOARDING_DRAFT_KEY = 'wayykup:onboarding-draft:v1';

function formatOnboardingTime(hour: number, minute: number, period: 'AM' | 'PM') {
  return `${hour}:${String(minute).padStart(2, '0')} ${period}`;
}

type OnboardingDraft = {
  step: Step | 'scanIntro' | 'scan' | 'qrLink';
  answers: Answers;
  hour: number;
  minute: number;
  period: 'AM' | 'PM';
  repeatDays: string[];
  huntItems: string[];
  huntTarget: string;
  objectDifficulty?: ObjectHuntDifficulty;
  shakeTarget?: 10 | 25 | 50 | 100 | 200;
  pushUpTarget?: 5 | 10 | 15 | 20;
  challengePhrase?: "I'M AWAKE!" | 'GOOD MORNING!' | "I'M UP!" | 'WAKE UP!';
  sound: AlarmSoundId;
  task: WakeTask | null;
  notificationGranted: boolean;
  keepAlarmPlaying: boolean | null;
};

function isOnboardingDraft(value: unknown): value is OnboardingDraft {
  if (typeof value !== 'object' || value === null) return false;
  const draft = value as Record<string, unknown>;
  const answers = draft.answers;
  return (STEPS.includes(draft.step as Step) || draft.step === 'scanIntro' || draft.step === 'scan' || draft.step === 'qrLink')
    && typeof answers === 'object'
    && answers !== null
    && ANSWER_KEYS.every((key) => typeof (answers as Record<string, unknown>)[key] === 'string')
    && typeof draft.hour === 'number'
    && Number.isInteger(draft.hour)
    && draft.hour >= 1
    && draft.hour <= 12
    && typeof draft.minute === 'number'
    && Number.isInteger(draft.minute)
    && draft.minute >= 0
    && draft.minute <= 59
    && (draft.period === 'AM' || draft.period === 'PM')
    && Array.isArray(draft.repeatDays)
    && draft.repeatDays.every((day) => ['0', '1', '2', '3', '4', '5', '6'].includes(day))
    && Array.isArray(draft.huntItems)
    && draft.huntItems.length <= HUNT_ITEMS.length
    && draft.huntItems.every((item) => HUNT_ITEMS.some((knownItem) => knownItem.name === item))
    && typeof draft.huntTarget === 'string'
    && typeof draft.sound === 'string'
    && (draft.task === null || typeof draft.task === 'string')
    && (draft.objectDifficulty === undefined || ['easy', 'medium', 'hard'].includes(String(draft.objectDifficulty)))
    && (draft.shakeTarget === undefined || [10, 25, 50, 100, 200].includes(Number(draft.shakeTarget)))
    && (draft.pushUpTarget === undefined || [5, 10, 15, 20].includes(Number(draft.pushUpTarget)))
    && (draft.challengePhrase === undefined || ["I'M AWAKE!", 'GOOD MORNING!', "I'M UP!", 'WAKE UP!'].includes(String(draft.challengePhrase)))
    && typeof draft.notificationGranted === 'boolean'
    && (draft.keepAlarmPlaying === null || typeof draft.keepAlarmPlaying === 'boolean');
}

function currentOnboardingTask(task: unknown): WakeTask | null {
  switch (task) {
    case 'Yell to Stop':
    case 'Yell to Wake':
      return 'Yell to Stop';
    case 'Push-up Challenge':
    case 'Push-ups':
      return 'Push-up Challenge';
    case 'Shake Your Phone':
    case 'Shake':
      return 'Shake Your Phone';
    case 'Object Hunt':
      return 'Object Hunt';
    default:
      return null;
  }
}

function ChallengeIllustration({ type }: { type: (typeof CHALLENGES)[number]['art'] }) {
  return (
    <Svg width="100%" height="100%" viewBox="0 0 240 230" preserveAspectRatio="xMidYMid slice">
      {type === 'object' && (
        <>
          <Path d="M0 0H240V230H0Z" fill="#FFE7BB" />
          <Path d="M0 192H240V230H0Z" fill="#C9945D" />
          <Path d="M0 193C61 183 169 183 240 192" fill="none" stroke="#66462D" strokeWidth={3} />
          <Path d="M27 33V67M27 33H61M213 33V67M213 33H179M27 163V129M27 163H61M213 163V129M213 163H179" fill="none" stroke="#29271C" strokeWidth={3} strokeLinecap="round" />
          <Path d="M120 144C104 106 88 71 59 57C66 91 77 119 105 145Z" fill="#799044" stroke="#293B26" strokeWidth={3} />
          <Path d="M118 145C116 97 120 47 132 18C145 54 143 101 125 146Z" fill="#71893B" stroke="#293B26" strokeWidth={3} />
          <Path d="M124 145C137 104 156 71 184 61C180 95 160 127 129 148Z" fill="#8EA04A" stroke="#293B26" strokeWidth={3} />
          <Path d="M111 147C91 125 75 110 52 108C64 132 84 147 111 155Z" fill="#657D35" stroke="#293B26" strokeWidth={3} />
          <Path d="M128 149C151 127 171 112 194 108C180 134 159 149 130 157Z" fill="#627A37" stroke="#293B26" strokeWidth={3} />
          <Path d="M120 137V84M104 120L72 75M136 117L169 78M106 143L67 119M138 144L177 119" fill="none" stroke="#C9B53C" strokeWidth={2} />
          <Path d="M93 145H150L144 205C143 216 100 216 99 205Z" fill="#E9D7B5" stroke="#554434" strokeWidth={3} />
          <Path d="M94 150C110 156 135 156 150 150" fill="none" stroke="#A68C69" strokeWidth={2} />
          <Path d="M116 101H136M126 91V111" stroke="#F2B51C" strokeWidth={3} strokeLinecap="round" />
        </>
      )}
      {type === 'yell' && (
        <>
          <Path d="M0 0H240V230H0Z" fill="#D8ECF3" />
          <Path d="M25 0V230M145 0V230M0 68H240M0 161H240" stroke="#A9CEDB" strokeWidth={2} />
          <Path d="M0 190C64 181 174 186 240 201V230H0Z" fill="#B5D6E2" />
          <Path d="M31 158C60 144 98 132 136 136L210 179C224 188 214 203 197 198L115 177C77 190 49 186 31 174C23 169 23 162 31 158Z" fill="#F9F6EC" stroke="#37444A" strokeWidth={3} />
          <Path d="M157 151L205 177C222 186 216 201 201 198L155 186Z" fill="#138BAA" stroke="#37444A" strokeWidth={3} />
          <Path d="M196 174L215 184L203 194L187 185Z" fill="#EF9B24" />
          <Path d="M37 156C34 145 38 114 42 100C44 91 52 92 54 100L53 145M50 145L51 89C52 79 60 80 61 89L62 143M59 143L65 86C66 77 74 79 74 88L72 145M69 145L79 95C81 86 89 89 87 98L82 150M79 151L94 111C98 103 105 107 102 115L91 158" fill="#F5F1E8" stroke="#37444A" strokeWidth={3} strokeLinejoin="round" />
          <Path d="M39 98C49 89 80 92 98 107L92 119C73 107 54 106 39 116Z" fill="#FFFFFF" stroke="#37444A" strokeWidth={2} />
          <Path d="M43 98C56 103 80 104 96 113" fill="none" stroke="#BFE6EF" strokeWidth={5} />
        </>
      )}
      {type === 'pushups' && (
        <>
          <Path d="M0 0H240V230H0Z" fill="#FFD4B7" />
          <Path d="M0 175H240V230H0Z" fill="#E9A36C" />
          <Path d="M0 176C71 167 167 169 240 177" fill="none" stroke="#80543B" strokeWidth={3} />
          <Path d="M36 40V91M36 40H84M204 40V91M204 40H156" fill="none" stroke="#8A674C" strokeWidth={2} />
          <Path d="M167 47H194V83H167Z" fill="#F4E9D3" stroke="#755B46" strokeWidth={2} />
          <Circle cx={181} cy={59} r={7} fill="#E7A449" />
          <Path d="M25 177C77 158 166 157 226 176V199C159 186 80 190 25 201Z" fill="#D96526" stroke="#7C371D" strokeWidth={3} />
          <Path d="M54 147C86 128 115 125 145 136L176 152L153 168L104 168L75 184L57 177L81 159L54 160Z" fill="#17312E" stroke="#1D2825" strokeWidth={3} />
          <Circle cx={79} cy={124} r={17} fill="#D9945E" stroke="#493329" strokeWidth={3} />
          <Path d="M63 119C66 99 91 101 99 116L91 120L83 113L74 124Z" fill="#332A25" />
          <Path d="M94 153L125 160L147 181L166 183L172 177L157 168L143 147L116 135Z" fill="#B87547" stroke="#493329" strokeWidth={3} />
          <Path d="M153 153L178 157L199 175L216 178L220 185L195 187L174 177L151 168Z" fill="#B87547" stroke="#493329" strokeWidth={3} />
          <Path d="M73 166L54 188L42 189L43 182L56 163Z" fill="#D9945E" stroke="#493329" strokeWidth={3} />
          <Path d="M102 164L95 192L82 195L79 188L87 164Z" fill="#D9945E" stroke="#493329" strokeWidth={3} />
          <Path d="M171 153L191 157L204 170L197 176L182 168Z" fill="#262B29" />
        </>
      )}
      {type === 'shake' && (
        <>
          <Path d="M0 0H240V230H0Z" fill="#E1E3C8" />
          <Path d="M0 179H240V230H0Z" fill="#C9CCAD" />
          <Path d="M0 179C71 169 166 170 240 179" fill="none" stroke="#777A5E" strokeWidth={3} />
          <Path d="M168 43H205V85H168Z" fill="#F4EAD6" stroke="#82765C" strokeWidth={2} />
          <Circle cx={185} cy={56} r={10} fill="#8DA27A" />
          <Ellipse cx={108} cy={205} rx={71} ry={19} fill="#E6D6B6" />
          <Path d="M213 148V177M197 161H229M202 177L194 190M222 177L230 190" stroke="#425D3C" strokeWidth={4} strokeLinecap="round" />
          <Path d="M196 155C191 144 195 132 208 126M213 147C223 135 232 130 238 127" fill="none" stroke="#597348" strokeWidth={7} strokeLinecap="round" />
          <Circle cx={106} cy={76} r={16} fill="#BC7146" stroke="#3A3329" strokeWidth={2} />
          <Path d="M91 74C89 54 112 50 125 62L120 71L105 67L96 82Z" fill="#302B25" />
          <Path d="M104 91L140 107L156 130L141 141L119 121L94 113Z" fill="#F8F8F0" stroke="#333831" strokeWidth={3} />
          <Path d="M117 103L82 106L53 91L31 92L28 98L53 109L91 119L126 121Z" fill="#BC7146" stroke="#44382E" strokeWidth={3} />
          <Path d="M149 129L171 146L170 172L153 188L141 183L151 165L148 145L131 136Z" fill="#46543E" stroke="#333831" strokeWidth={3} />
          <Path d="M155 184L178 184L188 190L185 196L151 196L143 191Z" fill="#F8F8F0" stroke="#4A4940" strokeWidth={2} />
          <Path d="M101 117L122 125L113 153L95 171L77 169L93 147L88 122Z" fill="#46543E" stroke="#333831" strokeWidth={3} />
          <Path d="M78 166L101 168L111 175L106 181L72 178L67 173Z" fill="#F8F8F0" stroke="#4A4940" strokeWidth={2} />
        </>
      )}
    </Svg>
  );
}

function DnaIllustration() {
  const firstStrand = 'M24 50 C76 18 112 22 160 60 C208 98 244 140 292 128 C340 116 376 54 424 42 C472 30 508 62 576 100';
  const secondStrand = 'M24 110 C76 142 112 138 160 100 C208 62 244 20 292 32 C340 44 376 106 424 118 C472 130 508 98 576 58';
  const rungs = [
    'M46 39 L46 121', 'M80 30 L80 133', 'M115 34 L115 129',
    'M150 53 L150 107', 'M185 78 L185 82', 'M220 111 L220 49',
    'M255 134 L255 27', 'M290 130 L290 31', 'M325 111 L325 49',
    'M360 78 L360 82', 'M395 49 L395 111', 'M430 41 L430 119',
    'M465 43 L465 117', 'M500 60 L500 100', 'M535 80 L535 78',
  ];

  return (
    <Svg width="100%" height={170} viewBox="0 0 600 180" preserveAspectRatio="xMidYMid meet" accessibilityLabel="Illustration of a DNA double helix">
      <Path d="M25 151 C140 169 454 168 576 149" stroke="#91D9F3" strokeWidth={8} strokeLinecap="round" opacity={0.7} />
      {rungs.map((path, index) => (
        <Path key={`rung-outline-${index}`} d={path} stroke="#17131B" strokeWidth={18} strokeLinecap="round" />
      ))}
      {rungs.map((path, index) => (
        <Path key={`rung-fill-${index}`} d={path} stroke="#52DCEB" strokeWidth={11} strokeLinecap="round" />
      ))}
      {rungs.map((path, index) => (
        <Path key={`rung-shine-${index}`} d={path} stroke="#C9FBFF" strokeWidth={2} strokeLinecap="round" opacity={0.9} />
      ))}
      {[firstStrand, secondStrand].map((path, index) => (
        <Path key={`strand-outline-${index}`} d={path} fill="none" stroke="#17131B" strokeWidth={31} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {[firstStrand, secondStrand].map((path, index) => (
        <Path key={`strand-color-${index}`} d={path} fill="none" stroke="#8A16E8" strokeWidth={24} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {[firstStrand, secondStrand].map((path, index) => (
        <Path key={`strand-shine-${index}`} d={path} fill="none" stroke="#C455FF" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />
      ))}
    </Svg>
  );
}

function SunriseIllustration() {
  const rays = [
    'M200 25 L200 58',
    'M104 68 L127 91',
    'M296 68 L273 91',
    'M57 164 L91 168',
    'M343 164 L309 168',
  ];
  const sunTexture = Array.from({ length: 11 }, (_, index) => {
    const x = 119 + index * 16;
    return `M${x} 94 L${x + 84} 238`;
  });
  const cloudTexture = Array.from({ length: 16 }, (_, index) => {
    const x = 98 + index * 13;
    return `M${x} 244 L${x + 100} 365`;
  });
  const cloudPath = 'M87 285 C62 282 45 264 45 239 C45 212 66 191 93 188 C103 152 136 128 175 128 C207 128 235 146 249 172 C262 163 279 158 297 158 C340 158 374 190 374 230 C398 239 413 260 413 284 C413 317 386 344 352 344 L112 344 C76 344 48 320 48 290 C48 288 48 286 49 284 Z';

  return (
    <Svg
      width="100%"
      height={370}
      viewBox="0 0 460 400"
      preserveAspectRatio="xMidYMid meet"
      accessibilityLabel="Hand-drawn golden sun rising behind a shaded white cloud"
    >
      <Defs>
        <ClipPath id="sunClip"><Circle cx={230} cy={174} r={102} /></ClipPath>
        <ClipPath id="cloudClip"><Path d={cloudPath} /></ClipPath>
      </Defs>
      <Path d="M66 374 C151 390 315 390 398 373" stroke="#90AFC1" strokeWidth={12} strokeLinecap="round" opacity={0.28} />
      {rays.map((ray, index) => (
        <Path key={`ray-outline-${index}`} d={ray} stroke="#17131B" strokeWidth={22} strokeLinecap="round" />
      ))}
      {rays.map((ray, index) => (
        <Path key={`ray-gold-${index}`} d={ray} stroke="#F8AF22" strokeWidth={13} strokeLinecap="round" />
      ))}
      <Circle cx={230} cy={174} r={104} fill="#F7B52C" stroke="#17131B" strokeWidth={5} />
      <G clipPath="url(#sunClip)">
        {sunTexture.map((line, index) => (
          <Path key={`sun-texture-${index}`} d={line} stroke="#FFD36A" strokeWidth={2} opacity={0.62} />
        ))}
      </G>
      <Path d={cloudPath} fill="#FEFDFC" stroke="#17131B" strokeWidth={5} strokeLinejoin="round" />
      <G clipPath="url(#cloudClip)">
        {cloudTexture.map((line, index) => (
          <Path key={`cloud-texture-${index}`} d={line} stroke="#CDD1D5" strokeWidth={1.5} opacity={index % 2 ? 0.3 : 0.48} />
        ))}
      </G>
    </Svg>
  );
}

function AlarmNotificationIcon() {
  return <WayykupIcon size={52} />;
}

function NotificationReveal() {
  const [backCard] = useState(() => new Animated.Value(0));
  const [frontCard] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const backAnimation = Animated.spring(backCard, {
      toValue: 1,
      delay: 350,
      useNativeDriver: true,
      speed: 11,
      bounciness: 7,
    });
    const frontAnimation = Animated.spring(frontCard, {
      toValue: 1,
      delay: 1050,
      useNativeDriver: true,
      speed: 10,
      bounciness: 8,
    });
    backAnimation.start(({ finished }) => {
      if (finished) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft)
          .catch((error: unknown) => console.warn('Notification preview haptic failed:', error));
      }
    });
    frontAnimation.start(({ finished }) => {
      if (finished) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
          .catch((error: unknown) => console.warn('Notification preview haptic failed:', error));
      }
    });

    return () => {
      backAnimation.stop();
      frontAnimation.stop();
    };
  }, [backCard, frontCard]);

  return (
    <View style={styles.notificationStack}>
      <Animated.View
        style={[
          styles.mockNotificationBack,
          {
            opacity: backCard,
            transform: [
              { translateY: backCard.interpolate({ inputRange: [0, 1], outputRange: [-300, 0] }) },
              { scale: backCard.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) },
            ],
          },
        ]}
      >
        <AlarmNotificationIcon />
        <Text style={styles.notificationBackText}>Time to wake up! ⏰</Text>
      </Animated.View>
      <Animated.View
        style={[
          styles.mockNotificationFront,
          {
            opacity: frontCard,
            transform: [
              { translateY: frontCard.interpolate({ inputRange: [0, 1], outputRange: [-360, 0] }) },
              { scale: frontCard.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
            ],
          },
        ]}
      >
        <AlarmNotificationIcon />
        <View style={styles.notificationCopy}>
          <View style={styles.notificationHeader}>
            <Text style={styles.notificationApp}>WAYYKUP ALARM</Text>
            <Text style={styles.notificationNow}>now</Text>
          </View>
          <Text style={styles.notificationText}>Good Morning! ☀️</Text>
        </View>
      </Animated.View>
    </View>
  );
}

function CinematicItem({ children, index = 0, style }: { children: React.ReactNode; index?: number; style?: object }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.sequence([
      Animated.delay(index * 55),
      Animated.spring(progress, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 3 }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [index, progress]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) },
            { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.975, 1] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

function SavingsReveal({
  answers,
  onComplete,
}: {
  answers: Answers;
  onComplete: (complete: boolean) => void;
}) {
  const [intro] = useState(() => new Animated.Value(0));
  const [pattern] = useState(() => new Animated.Value(0));
  const [hero] = useState(() => new Animated.Value(0));
  const [metrics] = useState(() => Array.from({ length: 3 }, () => new Animated.Value(0)));
  const reaction = answers.alarmReaction.replace(/^I /, '').replace(/^I wake up but /, '');
  useEffect(() => {
    const activeAnimations: Animated.CompositeAnimation[] = [];
    const play = (animation: Animated.CompositeAnimation, onFinish: () => void) => {
      activeAnimations.push(animation);
      animation.start(({ finished }) => {
        if (finished) onFinish();
      });
    };
    const impact = (style: Haptics.ImpactFeedbackStyle) => {
      Haptics.impactAsync(style)
        .catch((error: unknown) => console.warn('Onboarding haptic feedback failed:', error));
    };

    play(Animated.timing(intro, {
      toValue: 1,
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }), () => {
      impact(Haptics.ImpactFeedbackStyle.Soft);
      play(Animated.delay(180), () => {
        play(Animated.spring(pattern, { toValue: 1, useNativeDriver: true, speed: 15, bounciness: 4 }), () => {
          impact(Haptics.ImpactFeedbackStyle.Light);
          play(Animated.delay(180), () => {
            play(Animated.spring(hero, { toValue: 1, useNativeDriver: true, speed: 12, bounciness: 5 }), () => {
              impact(Haptics.ImpactFeedbackStyle.Medium);
              let remainingMetrics = metrics.length;
              metrics.forEach((metric, index) => {
                play(Animated.sequence([
                  Animated.delay(index * 170),
                  Animated.spring(metric, {
                    toValue: 1,
                    useNativeDriver: true,
                    speed: 16,
                    bounciness: 4,
                  }),
                ]), () => {
                  impact(Haptics.ImpactFeedbackStyle.Light);
                  remainingMetrics -= 1;
                  if (remainingMetrics === 0) {
                    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
                      .catch((error: unknown) => console.warn('Onboarding haptic feedback failed:', error));
                    onComplete(true);
                  }
                });
              });
            });
          });
        });
      });
    });

    return () => activeAnimations.forEach((animation) => animation.stop());
  }, [hero, intro, metrics, onComplete, pattern]);

  const revealStyle = (value: Animated.Value, startOffset = 16) => ({
    opacity: value,
    transform: [
      { translateY: value.interpolate({ inputRange: [0, 1], outputRange: [startOffset, 0] }) },
      { scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
    ],
  });

  return (
    <View style={styles.savingsWrap}>
      <Animated.View style={[styles.savingsIntro, revealStyle(intro, 12)]}>
        <Text style={styles.savingsIntroLabel}>YOUR MORNING, IN YOUR WORDS</Text>
        <Text style={styles.savingsIntroText}>
          You’re aiming to be up {answers.wakeTime.toLowerCase()} {answers.reason.toLowerCase()}.
        </Text>
      </Animated.View>

      <Animated.View style={[styles.savingsPattern, revealStyle(pattern)]}>
        <Text style={styles.savingsPatternLabel}>THE PATTERN YOU SHARED</Text>
        <View style={styles.savingsPatternRow}>
          <Text style={styles.savingsPatternKey}>ALARM</Text>
          <Text style={styles.savingsPatternValue}>{reaction}</Text>
        </View>
        <View style={styles.savingsPatternDivider} />
        <View style={styles.savingsPatternRow}>
          <Text style={styles.savingsPatternKey}>OUT OF BED</Text>
          <Text style={styles.savingsPatternValue}>{answers.bedTime.toLowerCase()}</Text>
        </View>
        <View style={styles.savingsPatternDivider} />
        <View style={styles.savingsPatternRow}>
          <Text style={styles.savingsPatternKey}>ALARMS SET</Text>
          <Text style={styles.savingsPatternValue}>{answers.alarmCount.toLowerCase()}</Text>
        </View>
      </Animated.View>

      <Animated.View style={[styles.savingsCard, revealStyle(hero, 28)]}>
        <View pointerEvents="none" style={styles.savingsOrbit} />
        <Text style={styles.savingsEyebrow}>JUST 5 MINUTES RECLAIMED A DAY</Text>
        <Text style={styles.savingsNumber}>30 hrs</Text>
        <Text style={styles.savingsBottom}>could add up over a year</Text>
        <Text style={styles.savingsFormula}>5 min × 365 mornings</Text>
      </Animated.View>

      <View style={styles.metricsRow}>
        {[
          { value: '5 min', label: 'EVERY DAY' },
          { value: '35 min', label: 'EVERY WEEK' },
          { value: '~2.5 hr', label: 'EVERY MONTH' },
        ].map((metric, index) => (
          <Animated.View key={metric.label} style={[styles.metric, revealStyle(metrics[index], 10)]}>
            <Text style={styles.metricValue}>{metric.value}</Text>
            <Text style={styles.metricLabel}>{metric.label}</Text>
          </Animated.View>
        ))}
      </View>
      <Text style={styles.disclaimer}>
        An illustrative 5-minute-a-day scenario, not a measure of your personal time or a guaranteed saving.
      </Text>
    </View>
  );
}

function MorningReveal() {
  const [chartWidth, setChartWidth] = useState(0);
  const trace = useRef(Array.from({ length: 10 }, () => new Animated.Value(0))).current;
  const headlineOpacity = useRef(new Animated.Value(0)).current;
  const payoffOpacity = useRef(new Animated.Value(0)).current;
  const glow = useRef(new Animated.Value(0)).current;
  const chartHeight = 178;
  const chartInset = 12;
  const typical = [78, 64, 48, 34, 24, 18];
  const wayykup = [24, 32, 45, 59, 74, 88];

  useEffect(() => {
    const reveal = Animated.sequence([
      Animated.timing(headlineOpacity, { toValue: 1, duration: 450, useNativeDriver: true }),
      Animated.stagger(170, trace.map((line) => Animated.timing(line, {
        toValue: 1,
        duration: 360,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }))),
      Animated.timing(payoffOpacity, { toValue: 1, duration: 420, useNativeDriver: true }),
    ]);
    reveal.start();
    const pulse = Animated.loop(Animated.sequence([
      Animated.timing(glow, { toValue: 1, duration: 1250, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(glow, { toValue: 0, duration: 1250, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    pulse.start();
    return () => {
      reveal.stop();
      pulse.stop();
    };
  }, [glow, headlineOpacity, payoffOpacity, trace]);

  const renderPath = (values: number[], offset: number, color: string) => {
    if (chartWidth <= 0) return null;
    const width = chartWidth - chartInset * 2;
    const points = values.map((value, index) => ({
      x: chartInset + (width * index) / (values.length - 1),
      y: chartHeight - (chartHeight * value) / 100,
    }));

    return points.slice(0, -1).map((point, index) => {
      const next = points[index + 1];
      const dx = next.x - point.x;
      const dy = next.y - point.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      const angle = `${Math.atan2(dy, dx)}rad`;
      const midpointX = (point.x + next.x) / 2;
      const midpointY = (point.y + next.y) / 2;
      const animation = trace[offset + index];
      return (
        <React.Fragment key={`${color}-${index}`}>
          <Animated.View
            style={[
              styles.energySegment,
              {
                width: length,
                left: midpointX - length / 2,
                top: midpointY - 2,
                backgroundColor: color,
                opacity: animation,
                transform: [{ rotate: angle }, { scaleX: animation }],
              },
            ]}
          />
          {index === 0 && (
            <Animated.View
              style={[
                styles.energyNode,
                { left: point.x - 4, top: point.y - 4, backgroundColor: color, opacity: animation, transform: [{ scale: animation }] },
              ]}
            />
          )}
          {index === values.length - 2 && (
            <Animated.View
              style={[
                styles.energyNode,
                { left: next.x - 4, top: next.y - 4, backgroundColor: color, opacity: animation, transform: [{ scale: animation }] },
              ]}
            />
          )}
        </React.Fragment>
      );
    });
  };

  return (
    <View style={styles.morningReveal}>
      <Animated.View style={[styles.revealIntro, { opacity: headlineOpacity, transform: [{ translateY: headlineOpacity.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] }]}>
        <Text style={styles.revealEyebrow}>THE FIRST 10 MINUTES</Text>
        <Text style={styles.revealTitle}>Break the{'\n'}<Text style={styles.revealTitleAccent}>scroll loop.</Text></Text>
        <Text style={styles.revealSub}>A different kind of alarm can change how your morning begins.</Text>
      </Animated.View>

      <View style={styles.energyCard}>
        <View style={styles.energyCardHeader}>
          <View>
            <Text style={styles.energyKicker}>MORNING ENERGY</Text>
            <Text style={styles.energyCaption}>A routine, reimagined</Text>
          </View>
          <Animated.View style={[styles.liveIndicator, { opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }), transform: [{ scale: glow.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.08] }) }] }]} />
        </View>
        <View style={styles.energyChart} onLayout={(event) => setChartWidth(event.nativeEvent.layout.width)}>
          {[0, 1, 2, 3].map((line) => (
            <View key={line} pointerEvents="none" style={[styles.chartGuide, { top: (chartHeight * line) / 3 }]} />
          ))}
          {renderPath(typical, 0, '#EF5A52')}
          {renderPath(wayykup, 5, '#F29A00')}
          <Text style={[styles.chartAxisLabel, styles.chartStartLabel]}>ALARM RINGS</Text>
          <Text style={[styles.chartAxisLabel, styles.chartEndLabel]}>10 MIN</Text>
          <Text style={[styles.loopCallout, { top: chartHeight - (chartHeight * typical[5]) / 100 - 25 }]}>SCROLL LOOP</Text>
          <Text style={[styles.wayykupCallout, { top: chartHeight - (chartHeight * wayykup[5]) / 100 - 19 }]}>WAYYKUP</Text>
        </View>
        <View style={styles.energyLegend}>
          <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: '#EF5A52' }]} /><Text style={styles.legendText}>Usual alarm</Text></View>
          <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: '#F29A00' }]} /><Text style={styles.legendText}>Wake-up challenge</Text></View>
        </View>
      </View>

      <Animated.View style={[styles.revealPayoff, { opacity: payoffOpacity, transform: [{ translateY: payoffOpacity.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }]}>
        <Text style={styles.payoffMark}>↗</Text>
        <Text style={styles.payoffText}>Get out of bed before the scroll begins.</Text>
      </Animated.View>
      <Text style={styles.graphNote}>Illustrative concept, not measured or clinical outcome data.</Text>
    </View>
  );
}

function WheelColumn({
  values,
  selectedIndex,
  onChange,
  accessibilityLabel,
}: {
  values: string[];
  selectedIndex: number;
  onChange: (index: number) => void;
  accessibilityLabel: string;
}) {
  const ref = useRef<ScrollViewInstance>(null);
  const rowHeight = 46;

  useEffect(() => {
    ref.current?.scrollTo({ y: selectedIndex * rowHeight, animated: false });
  }, [selectedIndex, values.length]);

  return (
    <View accessibilityLabel={accessibilityLabel} style={styles.wheelColumn}>
      <ScrollView
        ref={ref}
        showsVerticalScrollIndicator={false}
        snapToInterval={rowHeight}
        decelerationRate="fast"
        contentContainerStyle={{ paddingVertical: rowHeight * 2 }}
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
            onPress={() => {
              onChange(index);
              ref.current?.scrollTo({ y: index * rowHeight, animated: true });
            }}
            style={styles.wheelRow}
          >
            <Text style={[styles.wheelText, selectedIndex === index && styles.wheelTextSelected]}>{value}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

export type OnboardingSetup = {
  alarm: AlarmRecord;
  notificationGranted: boolean;
  keepAlarmPlaying: boolean;
};

export function OnboardingFlow({
  onComplete,
  trackEvent,
  reduceMotion,
}: {
  onComplete: (setup: OnboardingSetup) => Promise<void>;
  trackEvent: (name: string, properties?: Record<string, string | number | boolean>) => void;
  reduceMotion: boolean;
}) {
  const { width: windowWidth, height: windowHeight, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const availableHeight = Math.max(0, windowHeight - insets.top - insets.bottom);
  const compactLayout = availableHeight < 700 || windowWidth < 360 || fontScale > 1.15;
  const shortLayout = availableHeight < 620;
  const challengeCardHeight = Math.max(175, Math.min(190, (availableHeight - 300) / 2));
  const [step, setStep] = useState<Step>('welcome');
  const [savingsRevealed, setSavingsRevealed] = useState(false);
  const [answers, setAnswers] = useState<Answers>({
    source: '',
    rating: '',
    age: '',
    gender: '',
    wakeTime: '',
    reason: '',
    bedTime: '',
    alarmReaction: '',
    alarmCount: '',
    help: '',
  });
  const [hour, setHour] = useState(7);
  const [minute, setMinute] = useState(0);
  const [period, setPeriod] = useState<'AM' | 'PM'>('AM');
  const [repeatDays, setRepeatDays] = useState<string[]>(['0', '1', '2', '3', '4']);
  const [huntItems, setHuntItems] = useState<string[]>([]);
  const [huntTarget, setHuntTarget] = useState('');
  const [objectDifficulty, setObjectDifficulty] = useState<ObjectHuntDifficulty>('easy');
  const [shakeTarget, setShakeTarget] = useState<10 | 25 | 50 | 100 | 200>(25);
  const [pushUpTarget, setPushUpTarget] = useState<5 | 10 | 15 | 20>(10);
  const [challengePhrase, setChallengePhrase] = useState<"I'M AWAKE!" | 'GOOD MORNING!' | "I'M UP!" | 'WAKE UP!'>("I'M AWAKE!");
  const [sound, setSound] = useState<AlarmSoundId>(DEFAULT_ALARM_SOUND_ID);
  const [task, setTask] = useState<WakeTask | null>(null);
  const [notificationGranted, setNotificationGranted] = useState(false);
  const [notificationDenied, setNotificationDenied] = useState(false);
  const [notificationPermissionMessage, setNotificationPermissionMessage] = useState('');
  const [cameraDenied, setCameraDenied] = useState(false);
  const [commitComplete, setCommitComplete] = useState(false);
  const [fingerprintHolding, setFingerprintHolding] = useState(false);
  const [rollItemName, setRollItemName] = useState('');
  const [rollComplete, setRollComplete] = useState(false);
  const [keepAlarmPlaying, setKeepAlarmPlaying] = useState<boolean | null>(null);
  const [signaturePath, setSignaturePath] = useState('');
  const [signatureHasInk, setSignatureHasInk] = useState(false);
  const [signatureArea, setSignatureArea] = useState({ width: 0, height: 0 });
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [draftStorageError, setDraftStorageError] = useState('');
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const soundPlayer = useAudioPlayer(alarmSoundAsset(DEFAULT_ALARM_SOUND_ID));
  const commitProgress = useRef(new Animated.Value(0)).current;
  const fingerprintProgress = useRef(new Animated.Value(0)).current;
  const fingerprintHapticsTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fingerprintCompleted = useRef(false);
  const rollMotion = useRef(new Animated.Value(0)).current;
  const signaturePathRef = useRef('');
  const entrance = useRef(new Animated.Value(1)).current;
  const transitionX = useRef(new Animated.Value(0)).current;
  const transitionDirection = useRef(1);
  const logoPulse = useRef(new Animated.Value(0)).current;
  const welcomeLogoEntrance = useRef(new Animated.Value(0)).current;
  const welcomeCopyEntrance = useRef(new Animated.Value(0)).current;
  const welcomeProofEntrance = useRef(new Animated.Value(0)).current;
  const continueScale = useRef(new Animated.Value(1)).current;
  const progressMotion = useRef(new Animated.Value(0)).current;
  const savingsContinueMotion = useRef(new Animated.Value(0)).current;
  const commitmentIntroMotion = useRef(new Animated.Value(0)).current;
  const testimonialScroll = useRef<ScrollViewInstance>(null);
  const testimonialEntrance = useRef(new Animated.Value(1)).current;
  const [testimonialViewportWidth, setTestimonialViewportWidth] = useState(0);
  const [activeTestimonial, setActiveTestimonial] = useState(0);
  const completedRef = useRef(false);
  const stepIndex = STEPS.indexOf(step);
  const wakeTimeLabel = answers.wakeTime || 'your chosen time';
  const time = useMemo(() => {
    let hours24 = hour % 12;
    if (period === 'PM') hours24 += 12;
    return `${String(hours24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }, [hour, minute, period]);
  const testimonialCardWidth = Math.min(320, Math.max(0, testimonialViewportWidth - 40));

  useEffect(() => {
    if (step !== 'welcome' || testimonialViewportWidth === 0) return;
    const timer = setInterval(() => {
      const next = (activeTestimonial + 1) % TESTIMONIALS.length;
      setActiveTestimonial(next);
      testimonialEntrance.setValue(0);
      Animated.timing(testimonialEntrance, {
        toValue: 1,
        duration: 520,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      testimonialScroll.current?.scrollTo({
        x: next * (testimonialCardWidth + 12),
        animated: true,
      });
    }, 4200);
    return () => clearInterval(timer);
  }, [activeTestimonial, step, testimonialCardWidth, testimonialEntrance, testimonialViewportWidth]);

  useEffect(() => {
    entrance.setValue(0);
    transitionX.setValue(transitionDirection.current * 36);
    Animated.parallel([
      Animated.timing(entrance, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.spring(transitionX, { toValue: 0, useNativeDriver: true, speed: 17, bounciness: 3 }),
    ]).start();
  }, [step, entrance, transitionX]);

  useEffect(() => {
    if (step !== 'welcome') {
      logoPulse.stopAnimation();
      return;
    }
    if (reduceMotion) {
      welcomeLogoEntrance.setValue(1);
      welcomeCopyEntrance.setValue(1);
      welcomeProofEntrance.setValue(1);
      return;
    }

    welcomeLogoEntrance.setValue(0);
    welcomeCopyEntrance.setValue(0);
    welcomeProofEntrance.setValue(0);
    const entrance = Animated.stagger(140, [
      Animated.spring(welcomeLogoEntrance, {
        toValue: 1,
        useNativeDriver: true,
        speed: 15,
        bounciness: 5,
      }),
      Animated.timing(welcomeCopyEntrance, {
        toValue: 1,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(welcomeProofEntrance, {
        toValue: 1,
        useNativeDriver: true,
        speed: 16,
        bounciness: 3,
      }),
    ]);
    const pulse = Animated.loop(Animated.sequence([
      Animated.timing(logoPulse, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(logoPulse, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    entrance.start();
    pulse.start();
    return () => {
      entrance.stop();
      pulse.stop();
    };
  }, [
    logoPulse,
    reduceMotion,
    step,
    welcomeCopyEntrance,
    welcomeLogoEntrance,
    welcomeProofEntrance,
  ]);

  useEffect(() => {
    Animated.timing(progressMotion, {
      toValue: stepIndex / (STEPS.length - 1),
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [progressMotion, stepIndex]);

  useEffect(() => {
    if (step === 'savings' && savingsRevealed) {
      savingsContinueMotion.setValue(0);
      Animated.spring(savingsContinueMotion, {
        toValue: 1,
        useNativeDriver: true,
        speed: 15,
        bounciness: 3,
      }).start();
      return;
    }
    savingsContinueMotion.setValue(0);
  }, [savingsContinueMotion, savingsRevealed, step]);

  useEffect(() => () => soundPlayer.pause(), [soundPlayer]);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(ONBOARDING_DRAFT_KEY)
      .then((savedDraft) => {
        if (!active || !savedDraft) return;
        const parsed: unknown = JSON.parse(savedDraft);
        if (!isOnboardingDraft(parsed)) throw new Error('Saved onboarding progress is invalid.');
        const restoredTask = currentOnboardingTask(parsed.task);
        const restoredStep = parsed.step === 'scan' || parsed.step === 'scanIntro'
          ? restoredTask === 'Object Hunt' ? 'objectPick' : 'challenge'
          : parsed.step === 'qrLink' ? 'challenge' : parsed.step;
        setStep(restoredStep);
        setAnswers(parsed.answers);
        setHour(parsed.hour);
        setMinute(parsed.minute);
        setPeriod(parsed.period);
        setRepeatDays(parsed.repeatDays);
        setHuntItems(parsed.huntItems);
        setHuntTarget(parsed.huntTarget);
        setObjectDifficulty(parsed.objectDifficulty ?? 'easy');
        setShakeTarget(parsed.shakeTarget ?? 25);
        setPushUpTarget(parsed.pushUpTarget ?? 10);
        setChallengePhrase(parsed.challengePhrase ?? "I'M AWAKE!");
        setSound(isAlarmSoundId(parsed.sound) ? parsed.sound : migrateAlarmSoundId(parsed.sound));
        setTask(restoredTask);
        setNotificationGranted(parsed.notificationGranted);
        setKeepAlarmPlaying(parsed.keepAlarmPlaying);
      })
      .catch((error: unknown) => {
        if (!active) return;
        console.error('Unable to restore onboarding progress.', error);
        setDraftStorageError('Your previous setup could not be restored. You can continue, but your progress may not be saved.');
      })
      .finally(() => {
        if (active) setDraftLoaded(true);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!draftLoaded || completedRef.current) return;
    const draft: OnboardingDraft = {
      step,
      answers,
      hour,
      minute,
      period,
      repeatDays,
      huntItems,
      huntTarget,
      objectDifficulty,
      shakeTarget,
      pushUpTarget,
      challengePhrase,
      sound,
      task,
      notificationGranted,
      keepAlarmPlaying,
    };
    AsyncStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify(draft)).catch((error: unknown) => {
      console.error('Unable to save onboarding progress.', error);
      setDraftStorageError('Your setup could not be saved on this device. Please keep Wayykup open until setup is complete.');
    });
  }, [
    answers,
    draftLoaded,
    hour,
    objectDifficulty,
    huntItems,
    huntTarget,
    keepAlarmPlaying,
    minute,
    notificationGranted,
    period,
    repeatDays,
    sound,
    shakeTarget,
    pushUpTarget,
    challengePhrase,
    step,
    task,
  ]);

  useEffect(() => {
    if (step !== 'objectPick' || !huntTarget) return;
    const intervals = [70, 70, 80, 90, 110, 140, 180, 230, 300, 390];
    let index = 0;
    let timeout: ReturnType<typeof setTimeout>;
    setRollComplete(false);
    setRollItemName(HUNT_ITEMS[0].name);
    const advance = () => {
      if (index >= intervals.length) {
        setRollItemName(huntTarget);
        setRollComplete(true);
        Vibration.vibrate(45);
        return;
      }
      setRollItemName(HUNT_ITEMS[index % HUNT_ITEMS.length].name);
      timeout = setTimeout(advance, intervals[index]);
      index += 1;
    };
    timeout = setTimeout(advance, intervals[0]);
    return () => clearTimeout(timeout);
  }, [huntTarget, step]);

  useEffect(() => {
    if (step !== 'objectPick') return;
    rollMotion.setValue(0);
    Animated.spring(rollMotion, { toValue: 1, useNativeDriver: true, speed: 15, bounciness: 7 }).start();
  }, [rollItemName, rollMotion, step]);

  const goTo = (nextStep: Step) => {
    transitionDirection.current = STEPS.indexOf(nextStep) >= stepIndex ? 1 : -1;
    if (nextStep === 'savings') setSavingsRevealed(false);
    if (nextStep === 'objectPick') {
      setRollComplete(false);
      setRollItemName('');
    }
    if (nextStep === 'commit') {
      if (step !== 'fingerprint') {
        signaturePathRef.current = '';
        setSignaturePath('');
        setSignatureHasInk(false);
        setCommitComplete(false);
        commitProgress.setValue(0);
      }
    }
    if (nextStep === 'fingerprint') {
      fingerprintCompleted.current = false;
      fingerprintProgress.setValue(0);
      setFingerprintHolding(false);
    }
    if (nextStep === 'commitIntro') commitmentIntroMotion.setValue(0);
    entrance.setValue(0);
    setStep(nextStep);
  };

  const goBack = () => {
    const previousStep: Partial<Record<Step, Step>> = {
      homeItems: 'challenge',
      cameraAccess: task === 'Object Hunt' ? 'homeItems' : 'challenge',
      objectPick: 'cameraAccess',
      alarmPlayback: task === 'Object Hunt' ? 'objectPick' : 'challenge',
      commitIntro: 'alarmPlayback',
      commit: 'commitIntro',
      fingerprint: 'commit',
    };
    const previous = previousStep[step];
    if (previous) {
      goTo(previous);
      return;
    }
    const previousInFlow = STEPS[Math.max(0, stepIndex - 1)] ?? 'welcome';
    goTo(previousInFlow);
  };

  const setAnswer = (key: keyof Answers, value: string) => {
    setAnswers((current) => ({ ...current, [key]: value }));
    if (key === 'source') trackEvent('onboarding_attribution_selected', { source: value });
    if (key !== 'age' && key !== 'gender') {
      trackEvent('onboarding_answer_selected', { question: key, answer: value });
    }
  };

  const selectAlarmPlayback = (value: boolean) => {
    setKeepAlarmPlaying(value);
    persistKeepAlarmPlayingPreference(value).catch((error: unknown) => {
      console.error('Alarm playback preference could not be saved.', error);
      setDraftStorageError('Your alarm playback choice could not be saved. Please try selecting it again.');
    });
  };

  const toggleDay = (index: number) => {
    const value = String(index);
    setRepeatDays((current) => current.includes(value)
      ? current.filter((day) => day !== value)
      : [...current, value].sort());
  };

  const setRepeatPreset = (days: string[]) => setRepeatDays(days);

  const requestNotifications = async () => {
    try {
      await requestAlarmNotifications();
      const health = await getAlarmHealth();
      if (health.platform === 'unsupported') {
        setNotificationPermissionMessage('Install the Wayykup development build to use alarms. Expo Go cannot host the native alarm service.');
        setNotificationDenied(true);
        goTo('challenge');
        return;
      }
      if (!health.notifications) {
        setNotificationPermissionMessage('Allow notifications for Wayykup, then return here and tap Continue setup.');
        setNotificationDenied(true);
        return;
      }
      setNotificationGranted(true);
      trackEvent('onboarding_notification_permission', {
        granted: true,
        alarm_ready: health.canRingNow,
      });
      setNotificationDenied(false);
      goTo('challenge');
    } catch (error) {
      console.error('Notification permission request failed during onboarding.', error);
      setNotificationPermissionMessage('Wayykup could not verify alarm permissions. Review them in Settings, then try again.');
      setNotificationDenied(true);
    }
  };

  const enableChallengeCamera = async () => {
    const nextStep = task === 'Object Hunt' ? 'objectPick' : 'alarmPlayback';
    if (cameraPermission?.granted) {
      setCameraDenied(false);
      goTo(nextStep);
      return;
    }
    if (cameraPermission && !cameraPermission.canAskAgain) {
      try {
        await Linking.openSettings();
      } catch (error) {
        console.error('Camera settings could not be opened.', error);
        setCameraDenied(true);
      }
      return;
    }
    try {
      const permission = await requestCameraPermission();
      if (permission.granted) {
        setCameraDenied(false);
        goTo(nextStep);
      } else {
        setCameraDenied(true);
      }
    } catch (error) {
      console.error('Camera permission request failed during onboarding.', error);
      setCameraDenied(true);
    }
  };

  const signatureResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => step === 'commit' && !commitComplete,
    onMoveShouldSetPanResponder: () => step === 'commit' && !commitComplete,
    onPanResponderGrant: (event) => {
      if (signatureArea.width <= 0 || signatureArea.height <= 0) return;
      const x = Math.round((event.nativeEvent.locationX / signatureArea.width) * 320);
      const y = Math.round((event.nativeEvent.locationY / signatureArea.height) * 140);
      signaturePathRef.current = `${signaturePathRef.current} M${x} ${y}`.trim();
      setSignaturePath(signaturePathRef.current);
    },
    onPanResponderMove: (event) => {
      if (signatureArea.width <= 0 || signatureArea.height <= 0) return;
      const x = Math.round((event.nativeEvent.locationX / signatureArea.width) * 320);
      const y = Math.round((event.nativeEvent.locationY / signatureArea.height) * 140);
      signaturePathRef.current += ` L${x} ${y}`;
      setSignaturePath(signaturePathRef.current);
      setSignatureHasInk(true);
    },
  }), [commitComplete, signatureArea.height, signatureArea.width, step]);

  const previewSound = async (soundId: AlarmSoundId = sound) => {
    try {
      await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false });
      soundPlayer.replace(alarmSoundAsset(soundId));
      soundPlayer.volume = 0.8;
      soundPlayer.play();
    } catch (error) {
      console.error('Alarm sound preview failed.', error);
    }
  };

  const finishCommitment = async () => {
    if (
      completedRef.current
      || !task
      || !CHALLENGES.some((challenge) => challenge.task === task)
    ) return false;
    if (keepAlarmPlaying === null) return false;
    completedRef.current = true;
    Vibration.vibrate(50);
    trackEvent('onboarding_commitment_completed', { task, time });
    let challengeConfig: ChallengeConfiguration | undefined;
    if (task === 'Yell to Stop') {
      challengeConfig = { type: 'yell_to_stop', phrase: challengePhrase, requiredCompletions: 1 };
    } else if (task === 'Push-up Challenge') {
      challengeConfig = { type: 'push_up', targetCount: pushUpTarget };
    } else if (task === 'Shake Your Phone') {
      challengeConfig = { type: 'shake_phone', targetCount: shakeTarget };
    } else if (task === 'Object Hunt') {
      challengeConfig = { type: 'object_hunt', difficulty: objectDifficulty, targetObject: huntTarget };
    }
    if (!challengeConfig) {
      completedRef.current = false;
      return false;
    }
    const alarm: AlarmRecord = {
      id: `onboarding-${Date.now()}`,
      time,
      task,
      days: repeatDays,
      sound,
      enabled: true,
      savage: false,
      challengeConfig,
    };
    try {
      await onComplete({ alarm, notificationGranted, keepAlarmPlaying });
      void AsyncStorage.removeItem(ONBOARDING_DRAFT_KEY).catch((error: unknown) => {
        console.error('Completed onboarding draft could not be cleared.', error);
      });
      return true;
    } catch (error) {
      console.error('Onboarding setup could not be persisted.', error);
      completedRef.current = false;
      return false;
    }
  };

  const confirmSignature = () => {
    if (!signatureHasInk || commitComplete || !task || keepAlarmPlaying === null) return;
    commitProgress.setValue(0);
    Animated.timing(commitProgress, { toValue: 1, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: false })
      .start(({ finished }) => {
        if (!finished) return;
        setCommitComplete(true);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
          .catch((error: unknown) => console.warn('Commitment confirmation haptic failed:', error));
        goTo('fingerprint');
      });
  };

  const stopFingerprintHaptics = () => {
    if (fingerprintHapticsTimer.current !== null) {
      clearInterval(fingerprintHapticsTimer.current);
      fingerprintHapticsTimer.current = null;
    }
  };

  const startFingerprintCommitment = () => {
    if (step !== 'fingerprint' || fingerprintCompleted.current || fingerprintHolding) return;
    setFingerprintHolding(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
      .catch((error: unknown) => console.warn('Fingerprint hold haptic failed:', error));
    stopFingerprintHaptics();
    fingerprintHapticsTimer.current = setInterval(() => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        .catch((error: unknown) => console.warn('Fingerprint hold haptic failed:', error));
    }, 420);
    fingerprintProgress.setValue(0);
    Animated.timing(fingerprintProgress, {
      toValue: 1,
      duration: 2200,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (!finished || fingerprintCompleted.current) return;
      stopFingerprintHaptics();
      setFingerprintHolding(false);
      void finishCommitment().then((completed) => {
        if (completed) {
          fingerprintCompleted.current = true;
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
            .catch((error: unknown) => console.warn('Fingerprint confirmation haptic failed:', error));
        } else {
          fingerprintProgress.setValue(0);
        }
      });
    });
  };

  const cancelFingerprintCommitment = () => {
    if (fingerprintCompleted.current) return;
    fingerprintProgress.stopAnimation();
    fingerprintProgress.setValue(0);
    stopFingerprintHaptics();
    setFingerprintHolding(false);
  };

  useEffect(() => {
    if (step !== 'fingerprint') return;
    return () => {
      fingerprintProgress.stopAnimation();
      stopFingerprintHaptics();
    };
  }, [fingerprintProgress, step]);

  const isReady = () => {
    switch (step) {
      case 'source': return !!answers.source;
      case 'rating': return !!answers.rating;
      case 'age': return !!answers.age;
      case 'gender': return !!answers.gender;
      case 'wakeTime': return !!answers.wakeTime;
      case 'reason': return !!answers.reason;
      case 'bedTime': return !!answers.bedTime;
      case 'alarmReaction': return !!answers.alarmReaction;
      case 'alarmCount': return !!answers.alarmCount;
      case 'help': return !!answers.help;
      case 'repeat': return repeatDays.length > 0;
      case 'challenge': return task !== null
        && CHALLENGES.some((challenge) => challenge.task === task);
      case 'homeItems': return huntItems.length > 0;
      case 'objectPick': return rollComplete;
      case 'alarmPlayback': return keepAlarmPlaying !== null;
      case 'commit': return signatureHasInk || commitComplete;
      default: return true;
    }
  };

  const continueStep = () => {
    const currentIndex = STEPS.indexOf(step);
    if (step === 'notifications') {
      void requestNotifications();
      return;
    }
    if (step === 'challenge') {
      if (task === 'Object Hunt') goTo('homeItems');
      else if (task === 'Push-up Challenge') goTo('cameraAccess');
      else goTo('alarmPlayback');
      return;
    }
    if (step === 'homeItems') {
      goTo('cameraAccess');
      return;
    }
    if (step === 'cameraAccess') {
      void enableChallengeCamera();
      return;
    }
    if (step === 'objectPick') {
      if (rollComplete && huntTarget) goTo('alarmPlayback');
      return;
    }
    if (step === 'commitIntro') {
      Animated.timing(commitmentIntroMotion, {
        toValue: 1,
        duration: 360,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) goTo('commit');
      });
      return;
    }
    if (step === 'commit') {
      if (commitComplete) goTo('fingerprint');
      else confirmSignature();
      return;
    }
    const next = STEPS[Math.min(currentIndex + 1, STEPS.length - 1)];
    goTo(next);
  };

  const renderChoices = (options: string[], selected: string, onSelect: (value: string) => void, icon?: string[]) => (
    <View style={styles.options}>
      {options.map((option, index) => (
        <CinematicItem key={option} index={index}>
          <TouchableOpacity
            accessibilityRole="radio"
            accessibilityState={{ selected: selected === option }}
            onPress={() => onSelect(option)}
            style={[styles.option, selected === option && styles.optionSelected]}
          >
            {!!icon?.[index] && <Text style={styles.optionIcon}>{icon[index]}</Text>}
            <Text style={[styles.optionText, selected === option && styles.optionTextSelected]}>{option}</Text>
            <View style={[styles.radio, selected === option && styles.radioSelected]} />
          </TouchableOpacity>
        </CinematicItem>
      ))}
    </View>
  );

  const heading = () => {
    switch (step) {
      case 'source': return 'Where did you hear about us?';
      case 'rating': return 'How would you rate your mornings?';
      case 'age': return 'How old are you?';
      case 'gender': return "What's your gender?";
      case 'wakeTime': return 'What time do you usually wake up?';
      case 'reason': return `Why do you wake up ${wakeTimeLabel}?`;
      case 'bedTime': return 'How long does it take to get out of bed?';
      case 'alarmReaction': return 'What happens when your alarm goes off?';
      case 'value': return 'Take back your morning.';
      case 'alarmCount': return 'How many alarms do you usually set?';
      case 'help': return 'What would make getting up easier?';
      case 'savings': return 'Your mornings add up.';
      case 'reframe': return "It's not a discipline problem.";
      case 'setup': return 'Time to build your first alarm.';
      case 'time': return 'When do you want to wake up?';
      case 'repeat': return 'Which days should it\nrepeat?';
      case 'sound': return 'Choose your alarm sound';
      case 'notifications': return 'Almost ready!';
      case 'challenge': return 'Pick your\nchallenge';
      case 'homeItems': return 'Pick the items you\nhave at home';
      case 'cameraAccess': return 'Enable camera access';
      case 'objectPick': return 'Your first wake-up challenge.';
      case 'alarmPlayback': return 'Keep your alarm playing during challenges?';
      case 'commitIntro': return 'Are you ready to make a commitment?';
      case 'commit': return `Are you ready to make the commitment to wake up at ${formatOnboardingTime(hour, minute, period)}?`;
      case 'fingerprint': return `Are you ready to make the commitment to wake up at ${formatOnboardingTime(hour, minute, period)}?`;
      default: return '';
    }
  };

  const renderBody = () => {
    switch (step) {
      case 'welcome':
        return (
          <View style={[styles.welcomeBody, compactLayout && styles.welcomeBodyCompact]}>
            <Animated.View style={[
              styles.logoTile,
              compactLayout && styles.logoTileCompact,
              {
                opacity: welcomeLogoEntrance,
                transform: [
                  { translateY: welcomeLogoEntrance.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) },
                  { scale: Animated.multiply(
                    welcomeLogoEntrance.interpolate({ inputRange: [0, 1], outputRange: [0.82, 1] }),
                    logoPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.035] }),
                  ) },
                ],
              },
            ]}>
              <WayykupIcon size={compactLayout ? 84 : 112} />
            </Animated.View>
            <Animated.View style={[
              styles.welcomeCopyEntrance,
              {
                opacity: welcomeCopyEntrance,
                transform: [{ translateY: welcomeCopyEntrance.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
              },
            ]}>
              <View style={styles.welcomeBrandLockup}>
                <WayykupIcon size={compactLayout ? 34 : 42} />
                <Text style={[styles.welcomeBrand, compactLayout && styles.welcomeBrandCompact]}>Wayykup</Text>
              </View>
              <Text style={[styles.welcomeSubtitle, compactLayout && styles.welcomeSubtitleCompact]}>The alarm that actually gets you out of bed.</Text>
            </Animated.View>
            <Animated.View style={[
              styles.welcomeProofEntrance,
              {
                opacity: welcomeProofEntrance,
                transform: [
                  { translateY: welcomeProofEntrance.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
                  { scale: welcomeProofEntrance.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
                ],
              },
            ]}>
            <View style={[styles.proofCard, compactLayout && styles.proofCardCompact]} accessibilityLabel="Wayykup rating and download stats">
              <View style={styles.proofStars}><Text style={styles.proofStarsText}>★★★★★</Text></View>
              <View style={styles.proofDivider} />
              <View style={styles.proofColumn}><Text style={styles.proofNumber}>4.6</Text><Text style={styles.proofCaption}>average rating</Text></View>
              <View style={styles.proofDivider} />
              <View style={styles.proofColumn}><Text style={styles.proofNumber}>35K+</Text><Text style={styles.proofCaption}>downloads</Text></View>
            </View>
            </Animated.View>
            <ScrollView
              ref={testimonialScroll}
              horizontal
              style={styles.testimonialCarousel}
              onLayout={(event) => setTestimonialViewportWidth(event.nativeEvent.layout.width)}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={[
                styles.featureCards,
                compactLayout && styles.featureCardsCompact,
                { paddingHorizontal: Math.max(14, (testimonialViewportWidth - testimonialCardWidth) / 2) },
              ]}
            >
              {TESTIMONIALS.map((testimonial, index) => (
                <Animated.View
                  key={testimonial.author}
                  style={[
                    styles.featureCard,
                    compactLayout && styles.featureCardCompact,
                    { width: testimonialCardWidth || 286 },
                    {
                      opacity: index === activeTestimonial
                        ? testimonialEntrance
                        : testimonialEntrance.interpolate({ inputRange: [0, 1], outputRange: [0.82, 0.96] }),
                      transform: [{
                        scale: index === activeTestimonial
                          ? testimonialEntrance.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] })
                          : 0.97,
                      }],
                    },
                  ]}
                >
                  <Text style={styles.stars}>★★★★★</Text>
                  <Text style={styles.featureTitle}>“{testimonial.quote}”</Text>
                  <Text style={styles.featureDetail}>{testimonial.author}</Text>
                </Animated.View>
              ))}
            </ScrollView>
          </View>
        );
      case 'source':
        return renderChoices(['TikTok', 'Instagram', 'YouTube', 'Snapchat', 'Reddit', 'App Store', 'Other'], answers.source, (value) => setAnswer('source', value), ['♪', '◎', '▶', '♧', '●', 'A', '···']);
      case 'rating':
        return (
          <View style={styles.ratingArea}>
            <View style={styles.ratingRow}>{['1', '2', '3', '4', '5'].map((value, index) => (
              <CinematicItem key={value} index={index}>
                <TouchableOpacity onPress={() => setAnswer('rating', value)} style={[styles.ratingButton, answers.rating === value && styles.ratingButtonSelected]}>
                  <Text style={[styles.ratingText, answers.rating === value && styles.optionTextSelected]}>{value}</Text>
                </TouchableOpacity>
              </CinematicItem>
            ))}</View>
            <View style={styles.ratingLabels}><Text style={styles.subtle}>Terrible</Text><Text style={styles.subtle}>Great</Text></View>
          </View>
        );
      case 'age':
        return renderChoices(['13–17', '18–24', '25–34', '35–44', '45–54', '55+', 'Prefer not to say'], answers.age, (value) => setAnswer('age', value));
      case 'gender':
        return renderChoices(['Male', 'Female', 'Other', 'Prefer not to say'], answers.gender, (value) => setAnswer('gender', value));
      case 'wakeTime':
        return renderChoices(['Before 5:00', 'Between 5:00 and 7:00', 'Between 7:00 and 9:00', 'Between 9:00 and 11:00', 'After 11:00'], answers.wakeTime, (value) => setAnswer('wakeTime', value));
      case 'reason':
        return renderChoices(['To work', 'To work out', 'To have time for myself', 'To take care of family', 'To go to school', 'Just because I have to'], answers.reason, (value) => setAnswer('reason', value), ['💼', '💪', '🌤', '♥', '▤', '😅']);
      case 'bedTime':
        return renderChoices(['Less than 5 min', '15 min', '30 min', 'More than 1 hour'], answers.bedTime, (value) => setAnswer('bedTime', value));
      case 'alarmReaction':
        return renderChoices(['I keep hitting snooze', 'I grab my phone and start scrolling', 'I sleep through my alarm', "I wake up but can't get up"], answers.alarmReaction, (value) => setAnswer('alarmReaction', value));
      case 'value':
        return <MorningReveal />;
      case 'alarmCount':
        return renderChoices(['Just one', '2 or 3', '4 or more'], answers.alarmCount, (value) => setAnswer('alarmCount', value));
      case 'help':
        return renderChoices(['A reason to leave my bed', 'Something that activates my brain', "An alarm I can't dismiss half-asleep", 'A loud alarm', 'Doing physical exercise'], answers.help, (value) => setAnswer('help', value));
      case 'savings':
        return <SavingsReveal answers={answers} onComplete={setSavingsRevealed} />;
      case 'reframe':
        return (
          <View style={styles.reframeWrap}>
            <DnaIllustration />
            <Text style={styles.reframeHeading}>It's not a discipline{'\n'}problem.</Text>
            <Text style={styles.reframeText}>
              You're not lazy, it's just simple biology. Your brain is still waking up, so snoozing feels like the only choice. Getting out of bed and moving your body helps it wake up faster.
            </Text>
          </View>
        );
      case 'setup':
        return (
          <View style={styles.setupArt}>
            <View style={styles.setupBrand}>
              <WayykupIcon size={20} />
              <Text style={styles.setupProgress}>Wayykup Alarm</Text>
            </View>
            <SunriseIllustration />
            <Text style={styles.setupHeading}>Time to build your{'\n'}first alarm</Text>
            <Text style={styles.setupSub}>It will only take 30 seconds.</Text>
          </View>
        );
      case 'time': {
        const hours = Array.from({ length: 12 }, (_, index) => index + 1);
        const minutes = Array.from({ length: 60 }, (_, index) => index);
        return (
          <View>
            <Text style={styles.pageSub}>You can change this any time.</Text>
            <View style={styles.timePicker}>
              <View pointerEvents="none" style={styles.wheelSelection} />
              <WheelColumn accessibilityLabel="Hour" values={hours.map((value) => String(value).padStart(2, '0'))} selectedIndex={hour - 1} onChange={(index) => setHour(index + 1)} />
              <Text style={styles.colon}>:</Text>
              <WheelColumn accessibilityLabel="Minute" values={minutes.map((value) => String(value).padStart(2, '0'))} selectedIndex={minute} onChange={setMinute} />
              <WheelColumn accessibilityLabel="AM or PM" values={['AM', 'PM']} selectedIndex={period === 'PM' ? 1 : 0} onChange={(index) => setPeriod(index === 1 ? 'PM' : 'AM')} />
            </View>
          </View>
        );
      }
      case 'repeat':
        return (
          <View style={styles.repeatBody}>
            <View style={styles.repeatPanel}>
              <View style={styles.repeatPanelTop}>
                <Text style={styles.repeatLabel}>Repeat</Text>
                <View style={styles.repeatPresets}>
                  {[
                    { label: 'Weekdays', days: ['0', '1', '2', '3', '4'] },
                    { label: 'Weekends', days: ['5', '6'] },
                  ].map((preset) => {
                    const selected = preset.days.length === repeatDays.length
                      && preset.days.every((day) => repeatDays.includes(day));
                    return (
                      <TouchableOpacity
                        key={preset.label}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        onPress={() => setRepeatPreset(preset.days)}
                        style={[styles.repeatPreset, selected && styles.repeatPresetSelected]}
                      >
                        <Text style={[styles.repeatPresetCheck, selected && styles.repeatPresetCheckSelected]}>✓</Text>
                        <Text style={[styles.repeatPresetText, selected && styles.repeatPresetTextSelected]}>{preset.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
              <View style={styles.dayRow}>
                {DAYS.map((day, index) => {
                  const selected = repeatDays.includes(String(index));
                  return (
                    <CinematicItem key={`${day}-${index}`} index={index} style={styles.dayItem}>
                      <TouchableOpacity
                        accessibilityRole="checkbox"
                        accessibilityLabel={day}
                        accessibilityState={{ checked: selected }}
                        onPress={() => toggleDay(index)}
                        style={[styles.dayButton, selected && styles.dayButtonSelected]}
                      >
                        <Text style={[styles.dayText, selected && styles.dayTextSelected]}>{day}</Text>
                      </TouchableOpacity>
                    </CinematicItem>
                  );
                })}
              </View>
            </View>
          </View>
        );
      case 'sound':
        return (
          <View>
            <Text style={styles.soundIntro}>Pick the sound that gets you up.</Text>
            {SOUND_CATEGORIES.map((category) => {
              const categorySounds = ALARM_SOUNDS.filter((item) => item.category === category);
              const categoryIcon = category === 'Emergency' ? '�' : category === 'Industrial' ? '⚙️' : category === 'Intense' ? '📢' : '⚡';
              return (
                <View key={category} style={styles.soundSection}>
                  <Text style={styles.soundSectionTitle}>{categoryIcon} {category}</Text>
                  <View style={styles.soundCard}>
                    {categorySounds.map((item, index) => {
                      const selected = sound === item.id;
                      return (
                        <CinematicItem key={item.id} index={index}>
                          <View style={[styles.soundRow, index === categorySounds.length - 1 && styles.soundRowLast]}>
                            <TouchableOpacity
                              accessibilityRole="button"
                              accessibilityLabel={`Preview ${item.name}`}
                              onPress={() => { setSound(item.id); void previewSound(item.id); }}
                              style={styles.playButton}
                            >
                              <Text style={styles.playIcon}>▶</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              accessibilityRole="radio"
                              accessibilityState={{ selected }}
                              onPress={() => setSound(item.id)}
                              style={styles.soundCopy}
                            >
                              <Text style={styles.soundName}>{item.name}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              accessibilityRole="radio"
                              accessibilityLabel={`Select ${item.name}`}
                              accessibilityState={{ selected }}
                              onPress={() => setSound(item.id)}
                              style={[styles.selectSound, selected && styles.selectSoundOn]}
                            >
                              <Text style={[styles.check, selected && styles.checkOn]}>{selected ? '✓' : ''}</Text>
                            </TouchableOpacity>
                          </View>
                        </CinematicItem>
                      );
                    })}
                  </View>
                </View>
              );
            })}
          </View>
        );
      case 'notifications':
        return (
          <View style={styles.notificationWrap}>
            <NotificationReveal />
            {notificationDenied && (
              <View style={styles.warningCard}>
                <Text style={styles.warningText}>
                  {notificationPermissionMessage || 'Alarm permissions are incomplete. Review them in Settings, then return and try again.'}
                </Text>
                <TouchableOpacity onPress={() => { void Linking.openSettings(); }}>
                  <Text style={styles.settingsLink}>OPEN SETTINGS</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        );
      case 'challenge':
        return (
          <View style={styles.challengeGrid}>
            {CHALLENGES.map((challenge, index) => {
              const selected = task === challenge.task;
              return (
                <CinematicItem key={challenge.task} index={index} style={styles.challengeMotion}>
                  <TouchableOpacity
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={challenge.title}
                    onPress={() => setTask(challenge.task)}
                    style={[
                      styles.challengeCard,
                      { height: challengeCardHeight },
                      { backgroundColor: challenge.color },
                      selected && styles.challengeCardSelected,
                    ]}
                  >
                    <View style={styles.challengeArtwork}>
                      <ChallengeIllustration type={challenge.art} />
                    </View>
                    <View style={styles.challengeCopy}>
                      <Text style={styles.challengeTitle}>{challenge.title}</Text>
                      <Text style={styles.challengeDescription}>{challenge.description}</Text>
                      <View style={styles.challengeMetaRow}>
                        <Text style={styles.challengeMeta}>{challenge.difficulty}</Text>
                        <Text style={styles.challengeMeta}>{challenge.duration}</Text>
                      </View>
                    </View>
                    <View style={styles.challengeMissionIcon}><Text style={styles.challengeMissionIconText}>{challenge.icon}</Text></View>
                    {selected && <Text style={styles.challengeCheck}>✓</Text>}
                  </TouchableOpacity>
                </CinematicItem>
              );
            })}
            {task === 'Yell to Stop' && (
              <View style={styles.challengeConfigPanel}>
                <Text style={styles.challengeConfigHeading}>SAY THIS TO STOP YOUR ALARM</Text>
                <View style={styles.challengeConfigChoices}>
                  {(["I'M AWAKE!", 'GOOD MORNING!', "I'M UP!", 'WAKE UP!'] as const).map((phrase) => (
                    <TouchableOpacity
                      key={phrase}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: challengePhrase === phrase }}
                      onPress={() => setChallengePhrase(phrase)}
                      style={[styles.challengeConfigChoice, challengePhrase === phrase && styles.challengeConfigChoiceSelected]}
                    >
                      <Text style={[styles.challengeConfigChoiceText, challengePhrase === phrase && styles.challengeConfigChoiceTextSelected]}>{phrase}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
            {task === 'Push-up Challenge' && (
              <View style={styles.challengeConfigPanel}>
                <Text style={styles.challengeConfigHeading}>PUSH-UP TARGET</Text>
                <View style={styles.challengeConfigChoices}>
                  {([5, 10, 15, 20] as const).map((count) => (
                    <TouchableOpacity key={count} onPress={() => setPushUpTarget(count)} style={[styles.challengeConfigChoice, pushUpTarget === count && styles.challengeConfigChoiceSelected]}>
                      <Text style={[styles.challengeConfigChoiceText, pushUpTarget === count && styles.challengeConfigChoiceTextSelected]}>{count}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
            {task === 'Shake Your Phone' && (
              <View style={styles.challengeConfigPanel}>
                <Text style={styles.challengeConfigHeading}>SHAKE TARGET</Text>
                <View style={styles.challengeConfigChoices}>
                  {([10, 25, 50, 100, 200] as const).map((count) => (
                    <TouchableOpacity key={count} onPress={() => setShakeTarget(count)} style={[styles.challengeConfigChoice, shakeTarget === count && styles.challengeConfigChoiceSelected]}>
                      <Text style={[styles.challengeConfigChoiceText, shakeTarget === count && styles.challengeConfigChoiceTextSelected]}>{count}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
          </View>
        );
      case 'homeItems':
        return (
          <View>
            <Text style={styles.homeItemsDescription}>Choose how challenging your search should be. Wayykup will ask for one supported object when your alarm rings.</Text>
            <View style={styles.homeItemsGrid}>
              {([
                { value: 'easy', title: 'EASY', description: 'Common nearby objects', icon: '☀' },
                { value: 'medium', title: 'MEDIUM', description: 'Everyday household objects', icon: '◈' },
                { value: 'hard', title: 'HARD', description: 'A wider supported object range', icon: '✦' },
              ] as const).map((level, index) => {
                const selected = objectDifficulty === level.value;
                return (
                  <CinematicItem key={level.value} index={index} style={styles.homeItemMotion}>
                    <TouchableOpacity
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      onPress={() => {
                        setObjectDifficulty(level.value);
                        const targets = huntTargetsForDifficulty(level.value);
                        const selectedTarget = chooseHuntTargetForDifficulty(level.value);
                        setHuntItems(targets);
                        setHuntTarget(selectedTarget ?? '');
                      }}
                      style={[styles.homeItemCard, selected && styles.homeItemCardSelected]}
                    >
                      <Text style={styles.homeItemImage}>{level.icon}</Text>
                      <Text numberOfLines={1} style={styles.homeItemName}>{level.title}</Text>
                      <Text style={styles.homeItemsDescription}>{level.description}</Text>
                      <View style={[styles.homeItemCheck, selected && styles.homeItemCheckSelected]}>
                        {selected && <Text style={styles.homeItemCheckmark}>✓</Text>}
                      </View>
                    </TouchableOpacity>
                  </CinematicItem>
                );
              })}
            </View>
          </View>
        );
      case 'cameraAccess':
        return (
          <View style={[styles.cameraAccessWrap, compactLayout && styles.cameraAccessWrapCompact]}>
            <Svg
              accessibilityLabel="Illustration of a hand holding a phone to recognize a household object"
              viewBox="0 0 320 290"
              style={[styles.cameraAccessArt, compactLayout && styles.cameraAccessArtCompact, shortLayout && styles.cameraAccessArtShort]}
            >
              <Ellipse cx="160" cy="266" rx="112" ry="12" fill="#EEE9E1" />
              <Circle cx="49" cy="95" r="4" fill="#F29A00" />
              <Circle cx="273" cy="84" r="5" fill="#D9C8AF" />
              <Path d="M56 206c-10-19-3-39 14-50 13-9 24-12 30-28 4-10 15-15 24-10 8 4 9 14 5 24-5 12-10 20-6 28 7 12 7 22-1 35l-7 12H68z" fill="#E8B38F" />
              <G transform="rotate(-7 160 144)">
                <Path d="M111 39c0-12 9-21 21-21h96c12 0 21 9 21 21v200c0 12-9 21-21 21h-96c-12 0-21-9-21-21z" fill="#1A131A" />
                <Path d="M119 47c0-8 6-14 14-14h94c8 0 14 6 14 14v184c0 8-6 14-14 14h-94c-8 0-14-6-14-14z" fill="#FFFDF9" />
                <Path d="M150 40h59" stroke="#514A52" strokeWidth="4" strokeLinecap="round" />
                <Path d="M128 62h104v148H128z" fill="#F4F0E8" />
                <Path d="M143 164v-38h19v38M139 164h27" fill="#D5B89B" />
                <Path d="M149 124c0-8 6-14 13-14s13 6 13 14v40h-26z" fill="#F29A00" />
                <Path d="M154 108v-7h17v7" fill="none" stroke="#1A131A" strokeWidth="3" strokeLinecap="round" />
                <Path d="M184 164v-29c0-8 6-14 14-14s14 6 14 14v29z" fill="#D5E4D7" />
                <Path d="M181 164h34M190 121v-8h16v8" fill="none" stroke="#54745B" strokeWidth="3" strokeLinecap="round" />
                <Path d="M135 179h89M135 190h58" stroke="#DED8CE" strokeWidth="4" strokeLinecap="round" />
                <Path d="M136 77h20M136 86h12" stroke="#D3C4B0" strokeWidth="3" strokeLinecap="round" />
                <Path d="M136 102h88v75h-88z" fill="none" stroke="#F29A00" strokeWidth="2" strokeDasharray="5 5" />
                <Path d="M136 117v-15h15M224 117v-15h-15M136 162v15h15M224 162v15h-15" fill="none" stroke="#1A131A" strokeWidth="3" strokeLinecap="round" />
                <Circle cx="180" cy="222" r="4" fill="#C5B9AA" />
              </G>
              <Path d="M231 183c9-8 17-11 24-8 7 3 8 11 2 17l-15 16c10-8 18-11 24-7 7 5 5 12-2 18l-17 16c11-7 19-8 24-3 5 6 1 13-7 19l-26 20c-11 8-25 9-37 3l-27-14c-11-6-16-17-12-29 3-10 11-13 22-8l15 7-6-46c-1-8 3-14 9-15 8-1 13 5 14 14z" fill="#E8B38F" />
              <Path d="m239 196-12 12M255 212l-13 13M266 233l-12 12" stroke="#CD9672" strokeWidth="2" strokeLinecap="round" />
              <Circle cx="78" cy="138" r="16" fill="#F6E8D0" />
              <Path d="M72 143v-11h12v11M69 143h18M75 132v-5h6v5" fill="none" stroke="#C57900" strokeWidth="2.5" strokeLinecap="round" />
              <Path d="m267 121 3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="#F29A00" />
            </Svg>
            <Text style={styles.cameraAccessDescription}>
              {task === 'Push-up Challenge'
                ? 'Allow camera access so Wayykup can verify your push-up form and count completed repetitions.'
                : 'Allow camera access so Wayykup can recognize your selected target object when the alarm rings.'}
            </Text>
            {cameraDenied && (
              <Text style={styles.permissionError}>
                Camera access is required for this challenge. Allow it in your device settings, then try again.
              </Text>
            )}
          </View>
        );
      case 'objectPick': {
        const displayedItem = HUNT_ITEMS.find((item) => item.name === rollItemName)
          ?? HUNT_ITEMS.find((item) => item.name === huntTarget)
          ?? HUNT_ITEMS[0];
        const targetItem = HUNT_ITEMS.find((item) => item.name === huntTarget) ?? displayedItem;
        return (
          <View style={styles.objectPickWrap}>
            <Text style={styles.screenDescription}>Your chosen objects will be shuffled when the alarm rings.</Text>
            <Animated.View style={[
              styles.randomObjectCard,
              {
                transform: [{ scale: rollMotion.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }],
                opacity: rollMotion,
              },
            ]}>
              <View style={styles.randomObjectCorners}><Text style={styles.randomObjectEmoji}>{rollComplete ? targetItem.image : displayedItem.image}</Text></View>
              <Text style={styles.randomObjectName}>{rollComplete ? targetItem.name.toUpperCase() : displayedItem.name.toUpperCase()}</Text>
            </Animated.View>
            <Text style={styles.randomObjectInstruction}>
              {rollComplete ? `FIND AND PHOTOGRAPH: ${targetItem.name.toUpperCase()}` : 'SHUFFLING TO YOUR SELECTED TARGET'}
            </Text>
            <Text style={styles.randomObjectNote}>At wake-up, the camera checks the real object on-device. No QR tags are needed.</Text>
          </View>
        );
      }
      case 'alarmPlayback':
        return (
          <View style={styles.playbackOptions}>
            <Text style={styles.screenDescription}>Keep the alarm ringing while you complete your wake-up challenge, so it’s harder to fall back asleep.</Text>
            {[
              { value: true, title: 'Yes, keep the alarm playing', detail: 'The in-app alarm audio continues during your challenge.' },
              { value: false, title: 'No, stop it when I start', detail: 'Wayykup pauses its in-app audio when the challenge opens. System notification behavior may vary.' },
            ].map((option) => (
              <TouchableOpacity
                key={String(option.value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: keepAlarmPlaying === option.value }}
                onPress={() => selectAlarmPlayback(option.value)}
                style={[styles.playbackOption, keepAlarmPlaying === option.value && styles.playbackOptionSelected]}
              >
                <View style={[styles.playbackRadio, keepAlarmPlaying === option.value && styles.playbackRadioSelected]} />
                <View style={styles.playbackOptionCopy}>
                  <Text style={styles.playbackOptionTitle}>{option.title}</Text>
                  <Text style={styles.playbackOptionDetail}>{option.detail}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        );
      case 'commitIntro':
        return (
          <Animated.View style={[
            styles.commitIntroWrap,
            {
              opacity: commitmentIntroMotion.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
              transform: [{ translateY: commitmentIntroMotion.interpolate({ inputRange: [0, 1], outputRange: [0, -40] }) }],
            },
          ]}>
            <Text style={styles.commitIntroTime}>{formatOnboardingTime(hour, minute, period)}</Text>
            <Text style={styles.commitIntroStatement}>I commit to waking up at {formatOnboardingTime(hour, minute, period)} and getting out of bed.</Text>
            <Text style={styles.commitIntroNote}>A promise to yourself, made one morning at a time.</Text>
          </Animated.View>
        );
      case 'commit':
        return (
          <View style={[styles.commitWrap, { paddingBottom: Math.max(12, availableHeight * 0.03) }]}>
            <Text style={[
              styles.signaturePrompt,
              { marginTop: Math.min(availableHeight * (compactLayout ? 0.045 : 0.1), compactLayout ? 24 : 76) },
            ]}>
              Sign your name below to make it official.
            </Text>
            <View
              onLayout={(event) => setSignatureArea(event.nativeEvent.layout)}
              style={[
                styles.signaturePad,
                {
                  height: Math.min(
                    250,
                    Math.max(compactLayout ? 132 : 170, availableHeight * (compactLayout ? 0.25 : 0.28)),
                  ),
                  marginTop: Math.min(availableHeight * (compactLayout ? 0.035 : 0.055), compactLayout ? 18 : 42),
                },
              ]}
              {...signatureResponder.panHandlers}
            >
              {!signatureHasInk && <Text style={styles.signatureHint}>SIGN HERE</Text>}
              <Svg width="100%" height="100%" viewBox="0 0 320 140" style={StyleSheet.absoluteFill}>
                <Path d={signaturePath} stroke={INK} strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </Svg>
              {!signatureHasInk && <View pointerEvents="none" style={styles.signatureBaseline} />}
            </View>
            {signatureHasInk && !commitComplete && (
              <TouchableOpacity onPress={() => {
                signaturePathRef.current = '';
                setSignaturePath('');
                setSignatureHasInk(false);
              }} style={styles.clearSignatureButton}>
                <Text style={styles.clearSignatureText}>CLEAR SIGNATURE</Text>
              </TouchableOpacity>
            )}
            {commitComplete && <View style={styles.commitmentConfirmation}>
              <Animated.View style={[
                styles.commitmentRing,
                {
                  borderColor: commitProgress.interpolate({ inputRange: [0, 1], outputRange: ['#C8C4CC', RED] }),
                  backgroundColor: commitProgress.interpolate({ inputRange: [0, 1], outputRange: ['#FFFFFF', '#FFF1D1'] }),
                  transform: [{ scale: commitProgress.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }],
                },
              ]}>
                <Animated.Text style={[styles.commitmentCheck, { opacity: commitProgress }]}>✓</Animated.Text>
              </Animated.View>
              <View>
                <Text style={styles.commitmentTitle}>Commitment made.</Text>
                <Text style={styles.commitmentDetail}>Tomorrow starts with a decision. You’ve made yours.</Text>
              </View>
            </View>}
          </View>
        );
      case 'fingerprint':
        return (
          <View style={styles.fingerprintWrap}>
            <Text style={styles.fingerprintPrompt}>Hold your finger to commit</Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={fingerprintHolding ? 'Keep holding to make your commitment' : 'Hold to make your commitment'}
              accessibilityState={{ selected: fingerprintHolding }}
              activeOpacity={1}
              onPressIn={startFingerprintCommitment}
              onPressOut={cancelFingerprintCommitment}
              style={styles.fingerprintTouchTarget}
            >
              <Animated.View style={[
                styles.fingerprintCircle,
                fingerprintHolding && styles.fingerprintCircleActive,
                {
                  transform: [{
                    scale: fingerprintProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.035] }),
                  }],
                },
              ]}>
                <Svg width="68%" height="68%" viewBox="0 0 160 160">
                  <Path d="M37 70c5-25 23-41 45-41 17 0 30 7 39 19" stroke={INK} strokeWidth="5" fill="none" strokeLinecap="round" />
                  <Path d="M26 82c0-6 1-12 2-17M132 62c5 9 8 20 8 33" stroke={INK} strokeWidth="5" fill="none" strokeLinecap="round" />
                  <Path d="M47 72c4-17 16-28 33-28 22 0 38 17 38 40 0 24-7 45-19 60" stroke={INK} strokeWidth="5" fill="none" strokeLinecap="round" />
                  <Path d="M31 96c4 16 1 27-5 36M61 76c3-10 10-16 19-16 12 0 21 10 21 24 0 22-4 38-15 54" stroke={INK} strokeWidth="5" fill="none" strokeLinecap="round" />
                  <Path d="M46 111c8-8 9-17 8-29 0-14 10-25 25-25 16 0 28 13 28 31 0 17-3 31-11 45" stroke={INK} strokeWidth="5" fill="none" strokeLinecap="round" />
                  <Path d="M62 119c8-9 10-19 9-35 0-7 3-12 9-12 7 0 11 6 11 15 0 15-2 26-8 37" stroke={INK} strokeWidth="5" fill="none" strokeLinecap="round" />
                </Svg>
              </Animated.View>
            </TouchableOpacity>
          </View>
        );
    }
  };

  const optionStep = ['source', 'rating', 'age', 'gender', 'wakeTime', 'reason', 'bedTime', 'alarmReaction', 'alarmCount', 'help', 'repeat', 'challenge'].includes(step);
  const buttonEnabled = isReady()
    && (step !== 'commit' || signatureHasInk || commitComplete);
  const progressWidth = progressMotion.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <View style={[
      styles.safeArea,
      { paddingTop: Math.max(insets.top, 12), paddingBottom: Math.max(insets.bottom, 8) },
    ]}>
      <Animated.View style={[styles.flowMotion, { opacity: entrance, transform: [{ translateX: transitionX }, { scale: entrance.interpolate({ inputRange: [0, 1], outputRange: [0.985, 1] }) }] }]}>
      <View style={[styles.top, styles.centeredContent, compactLayout && styles.topCompact]}>
        {step !== 'welcome' ? (
          <>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={goBack} style={styles.back}><Text style={styles.backGlyph}>‹</Text></TouchableOpacity>
            <View style={styles.progressTrack}><Animated.View style={[styles.progressFill, { width: progressWidth }]} /></View>
            <Text style={styles.locale}>🇬🇧</Text>
          </>
        ) : <View style={styles.topSpacer} />}
      </View>
      {!!draftStorageError && (
        <Text style={[styles.draftWarning, styles.centeredContent]}>{draftStorageError}</Text>
      )}
      <View style={styles.page}>
        <ScrollView
          key={step}
          contentContainerStyle={[
            styles.content,
            step === 'welcome' && styles.welcomeContent,
            step === 'reframe' && styles.reframeContent,
            step === 'setup' && styles.setupContent,
            step === 'repeat' && styles.repeatContent,
            step === 'sound' && styles.soundContent,
            step === 'notifications' && styles.notificationContent,
            optionStep && styles.optionContent,
            step === 'challenge' && styles.challengeContent,
            step === 'homeItems' && styles.homeItemsContent,
            styles.centeredContent,
            compactLayout && styles.contentCompact,
            shortLayout && styles.contentShort,
            step === 'welcome' && compactLayout && styles.welcomeContentCompact,
            step === 'reframe' && shortLayout && styles.reframeContentShort,
            step === 'notifications' && compactLayout && styles.notificationContentCompact,
            step === 'challenge' && compactLayout && styles.challengeContentCompact,
            step === 'homeItems' && compactLayout && styles.homeItemsContentCompact,
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {step !== 'welcome' && step !== 'reframe' && step !== 'setup' && (
            step === 'fingerprint' ? (
              <Text style={[styles.commitHeading, compactLayout && styles.commitHeadingCompact]}>
                Your first commitment was observed. This is the final commitment.
              </Text>
            ) : step === 'commit' ? (
              <Text style={[styles.commitHeading, compactLayout && styles.commitHeadingCompact]}>
                Are you ready to make the commitment to wake up at{' '}
                <Text style={styles.commitHeadingTime}>{formatOnboardingTime(hour, minute, period)}</Text>?
              </Text>
            ) : <Text style={[
              styles.heading,
              step === 'repeat' && styles.repeatHeading,
              step === 'sound' && styles.soundHeading,
              step === 'notifications' && styles.notificationHeading,
              step === 'challenge' && styles.challengeHeading,
              step === 'homeItems' && styles.homeItemsHeading,
              (step === 'cameraAccess' || step === 'objectPick' || step === 'alarmPlayback' || step === 'commitIntro') && styles.guidedHeading,
              compactLayout && styles.headingCompact,
              step === 'challenge' && compactLayout && styles.challengeHeadingCompact,
              step === 'homeItems' && compactLayout && styles.homeItemsHeadingCompact,
              step === 'notifications' && compactLayout && styles.notificationHeadingCompact,
              compactLayout && (step === 'cameraAccess' || step === 'objectPick' || step === 'alarmPlayback' || step === 'commitIntro') && styles.guidedHeadingCompact,
              step === 'cameraAccess' && styles.cameraAccessHeading,
              step === 'cameraAccess' && compactLayout && styles.cameraAccessHeadingCompact,
            ]}>{heading()}</Text>
          )}
          {step === 'time' && <Text style={styles.pageSub}>You can change this any time.</Text>}
          {step === 'repeat' && <Text style={styles.repeatPageSub}>You can change this any time.</Text>}
          {step === 'notifications' && <Text style={styles.notificationSub}>Allow notifications, exact alarms and full-screen access. Battery guidance follows.</Text>}
          <CinematicItem key={`body-${step}`} style={styles.bodyMotion}>{renderBody()}</CinematicItem>
        </ScrollView>
      </View>
      {step !== 'fingerprint' && (step !== 'savings' || savingsRevealed) && (
        <Animated.View
          style={[
            styles.bottom,
            step === 'setup' && styles.setupBottom,
            step === 'repeat' && styles.repeatBottom,
            step === 'notifications' && styles.notificationBottom,
            step === 'homeItems' && styles.homeItemsBottom,
            step === 'cameraAccess' && styles.cameraAccessBottom,
            styles.centeredContent,
            compactLayout && styles.bottomCompact,
            step === 'savings' && {
              opacity: savingsContinueMotion,
              transform: [{
                translateY: savingsContinueMotion.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }),
              }],
            },
          ]}
        >
          <AnimatedTouchableOpacity
            accessibilityRole="button"
            disabled={!buttonEnabled}
            onPress={continueStep}
            onPressIn={() => Animated.spring(continueScale, { toValue: 0.975, useNativeDriver: true, speed: 35, bounciness: 6 }).start()}
            onPressOut={() => Animated.spring(continueScale, { toValue: 1, useNativeDriver: true, speed: 25, bounciness: 7 }).start()}
            style={[
              styles.continueButton,
              (step === 'reframe' || step === 'setup' || step === 'repeat' || step === 'notifications') && styles.reframeContinueButton,
              !buttonEnabled && styles.continueDisabled,
              step === 'challenge' && styles.challengeContinueButton,
              step === 'homeItems' && buttonEnabled && styles.homeItemsContinueButton,
              step === 'cameraAccess' && styles.cameraAccessContinueButton,
              { transform: [{ scale: continueScale }] },
            ]}
          >
            <Text style={[styles.continueText, (step === 'reframe' || step === 'setup' || step === 'repeat' || step === 'notifications') && styles.reframeContinueText, !buttonEnabled && styles.continueTextDisabled, step === 'challenge' && buttonEnabled && styles.challengeContinueText, step === 'homeItems' && buttonEnabled && styles.homeItemsContinueText, step === 'cameraAccess' && styles.cameraAccessContinueText]}>
              {step === 'welcome' ? 'Get started'
                : step === 'setup' ? 'Build my alarm'
                  : step === 'time' ? 'Set my alarm'
                    : step === 'notifications' ? notificationGranted ? 'Continue setup' : 'Allow notifications'
                      : step === 'sound' ? 'Continue'
                        : step === 'challenge' ? 'Continue'
                          : step === 'homeItems' ? 'Continue'
                            : step === 'cameraAccess' ? (cameraPermission && !cameraPermission.granted && !cameraPermission.canAskAgain ? 'Open Camera Settings' : 'Enable Camera')
                              : step === 'objectPick' ? 'Continue'
                                  : step === 'commit' ? (commitComplete ? 'Continue to fingerprint' : 'Confirm signature')
                                    : 'Continue'}
            </Text>
          </AnimatedTouchableOpacity>
        </Animated.View>
      )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  flowMotion: { flex: 1 },
  centeredContent: { width: '100%', maxWidth: 560, alignSelf: 'center' },
  bodyMotion: { flex: 1, width: '100%', flexShrink: 1 },
  testimonialCarousel: { width: '100%', flexGrow: 0, flexShrink: 1, alignSelf: 'stretch' },
  categoryMotion: { flex: 1 },
  challengeMotion: { width: '48%' },
  homeItemMotion: { width: '31.5%' },
  top: { minHeight: 55, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, gap: 14 },
  topCompact: { minHeight: 48, paddingHorizontal: 14, gap: 10 },
  topSpacer: { height: 42 },
  back: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  backGlyph: { color: INK, fontSize: 36, lineHeight: 38 },
  progressTrack: { height: 8, flex: 1, borderRadius: 8, backgroundColor: '#E4E2E8', overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: RED, borderRadius: 8 },
  locale: { fontSize: 23 },
  page: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: 28, paddingTop: 16, paddingBottom: 20 },
  contentCompact: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 },
  contentShort: { paddingTop: 4, paddingBottom: 8 },
  welcomeContent: { justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 0, paddingTop: 8, paddingBottom: 6 },
  welcomeContentCompact: { paddingTop: 2, paddingBottom: 4 },
  reframeContent: { paddingTop: 66, paddingBottom: 24 },
  reframeContentShort: { paddingTop: 18, paddingBottom: 12 },
  setupContent: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 10 },
  repeatContent: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 24 },
  soundContent: { paddingHorizontal: 28, paddingTop: 10, paddingBottom: 24 },
  notificationContent: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12 },
  notificationContentCompact: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 8 },
  challengeContent: { paddingHorizontal: 22, paddingTop: 2, paddingBottom: 10 },
  challengeContentCompact: { paddingHorizontal: 16, paddingTop: 0, paddingBottom: 6 },
  homeItemsContent: { paddingHorizontal: 21, paddingTop: 0, paddingBottom: 12 },
  homeItemsContentCompact: { paddingHorizontal: 14, paddingTop: 0, paddingBottom: 8 },
  optionContent: { justifyContent: 'space-between' },
  heading: { color: INK, fontSize: 31, lineHeight: 38, fontWeight: '800', textAlign: 'center', letterSpacing: -0.5, marginTop: 28, marginBottom: 26 },
  headingCompact: { fontSize: 27, lineHeight: 33, marginTop: 16, marginBottom: 16 },
  commitHeading: { color: '#171018', fontFamily: 'Georgia', fontSize: 31, lineHeight: 40, fontWeight: '700', textAlign: 'center', letterSpacing: -0.3, marginTop: 28, marginBottom: 22, paddingHorizontal: 2, maxWidth: 520, alignSelf: 'center' },
  commitHeadingCompact: { fontSize: 26, lineHeight: 33, marginTop: 10, marginBottom: 10, paddingHorizontal: 0 },
  commitHeadingTime: { color: '#E99443' },
  repeatHeading: { color: '#17131B', fontFamily: 'Georgia', fontSize: 28, lineHeight: 36, fontWeight: '700', letterSpacing: -0.2, marginTop: 26, marginBottom: 7 },
  soundHeading: { color: '#17131B', fontFamily: 'Georgia', fontSize: 36, lineHeight: 44, fontWeight: '700', letterSpacing: -0.3, marginTop: 20, marginBottom: 4 },
  challengeHeading: { color: '#17131B', fontFamily: 'Georgia', fontSize: 36, lineHeight: 42, fontWeight: '700', letterSpacing: -0.4, marginTop: 28, marginBottom: 25, alignSelf: 'center', maxWidth: 280 },
  challengeHeadingCompact: { fontSize: 31, lineHeight: 36, marginTop: 12, marginBottom: 12 },
  homeItemsHeading: { color: '#17131B', fontFamily: 'Georgia', fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.25, marginTop: 26, marginBottom: 24 },
  homeItemsHeadingCompact: { fontSize: 27, lineHeight: 32, marginTop: 12, marginBottom: 12 },
  guidedHeading: { fontSize: 30, lineHeight: 36, marginTop: 20, marginBottom: 12, maxWidth: 390, alignSelf: 'center' },
  guidedHeadingCompact: { fontSize: 26, lineHeight: 31, marginTop: 12, marginBottom: 8 },
  cameraAccessHeading: { color: '#17131B', fontFamily: 'Georgia', fontSize: 34, lineHeight: 41, fontWeight: '700', letterSpacing: -0.5, marginTop: 12, marginBottom: 4, maxWidth: 340 },
  cameraAccessHeadingCompact: { fontSize: 29, lineHeight: 35, marginTop: 6, marginBottom: 2 },
  notificationHeading: { color: '#171018', fontFamily: 'Georgia', fontSize: 34, lineHeight: 44, fontWeight: '700', letterSpacing: -0.2, marginTop: 172, marginBottom: 7 },
  notificationHeadingCompact: { fontSize: 30, lineHeight: 38, marginTop: 58, marginBottom: 5 },
  pageSub: { color: MUTED, fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: 18 },
  repeatPageSub: { color: '#96929A', fontSize: 16, lineHeight: 24, textAlign: 'center', marginBottom: 0 },
  notificationSub: { color: '#96929A', fontSize: 14, lineHeight: 22, textAlign: 'center', paddingHorizontal: 0, letterSpacing: -0.1 },
  welcomeBody: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'space-around', overflow: 'visible', paddingBottom: 4 },
  welcomeBodyCompact: { justifyContent: 'space-evenly', gap: 6, paddingHorizontal: 12 },
  welcomeCopyEntrance: { width: '100%', alignItems: 'center' },
  welcomeProofEntrance: { width: '100%', alignItems: 'center' },
  logoTile: { width: 138, height: 138, borderRadius: 29, backgroundColor: '#F2F1F6', alignItems: 'center', justifyContent: 'center', shadowColor: '#87838D', shadowOpacity: 0.16, shadowRadius: 22, shadowOffset: { width: 0, height: 9 }, position: 'relative', marginTop: 3 },
  logoTileCompact: { width: 108, height: 108, borderRadius: 25 },
  welcomeBrandLockup: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  welcomeBrand: { color: INK, fontSize: 45, lineHeight: 52, fontWeight: '700', fontFamily: 'Georgia', letterSpacing: -1.5, marginTop: 0 },
  welcomeBrandCompact: { fontSize: 38, lineHeight: 44 },
  welcomeSubtitle: { color: MUTED, fontSize: 15, fontWeight: '600', textAlign: 'center', lineHeight: 21, paddingHorizontal: 22, marginTop: -4 },
  welcomeSubtitleCompact: { fontSize: 13, lineHeight: 18, paddingHorizontal: 12 },
  proofCard: { width: '91%', minHeight: 92, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', backgroundColor: '#1A131A', borderRadius: 27, paddingHorizontal: 13, paddingVertical: 8, marginTop: 0, shadowColor: '#241B23', shadowOpacity: 0.2, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 5 },
  proofCardCompact: { minHeight: 74, paddingVertical: 5, paddingHorizontal: 9, borderRadius: 22 },
  proofStars: { flex: 1.35, alignItems: 'center', justifyContent: 'center' },
  proofStarsText: { color: '#F29A00', fontSize: 20, letterSpacing: 1, fontWeight: '900' },
  proofColumn: { flex: 1, alignItems: 'flex-start', paddingHorizontal: 8 },
  proofNumber: { color: '#FFFFFF', fontSize: 23, fontWeight: '900' },
  proofCaption: { color: '#D5D1D8', fontSize: 10, marginTop: 4, textAlign: 'left' },
  proofDivider: { width: 1, height: 48, backgroundColor: '#554E56' },
  featureCards: { gap: 12, paddingVertical: 6, paddingHorizontal: 14, minHeight: 174 },
  featureCardsCompact: { minHeight: 136, paddingVertical: 4 },
  featureCard: { width: 250, minHeight: 162, backgroundColor: '#F1EFF5', borderRadius: 27, padding: 18, justifyContent: 'space-between', borderWidth: 1, borderColor: '#ECEAF0', shadowColor: '#77717C', shadowOpacity: 0.16, shadowRadius: 18, shadowOffset: { width: 0, height: 7 }, elevation: 3 },
  featureCardCompact: { minHeight: 126, padding: 14, borderRadius: 22 },
  stars: { color: '#E79400', fontSize: 18, letterSpacing: 2, marginBottom: 8 },
  featureTitle: { color: INK, fontSize: 19, lineHeight: 25, fontFamily: 'Georgia', fontWeight: '700' },
  featureDetail: { color: '#929097', fontSize: 12, lineHeight: 17, fontWeight: '500', marginTop: 8 },
  options: { gap: 11, paddingBottom: 10 },
  option: { minHeight: 64, borderWidth: 1.5, borderColor: INK, borderRadius: 16, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 17, backgroundColor: '#FFFFFF' },
  optionSelected: { backgroundColor: '#FFF8EA', borderColor: RED },
  optionIcon: { color: INK, width: 34, textAlign: 'center', fontSize: 21, fontWeight: '700', marginRight: 9 },
  optionText: { flex: 1, color: INK, fontSize: 16, fontWeight: '600' },
  optionTextSelected: { color: INK, fontWeight: '800' },
  radio: { width: 19, height: 19, borderWidth: 1.5, borderColor: '#C6C3C9', borderRadius: 10 },
  radioSelected: { borderWidth: 6, borderColor: RED },
  ratingArea: { marginTop: 'auto', marginBottom: 'auto' },
  ratingRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 9 },
  ratingButton: { width: 58, height: 66, borderRadius: 15, borderWidth: 1.5, borderColor: INK, alignItems: 'center', justifyContent: 'center' },
  ratingButtonSelected: { backgroundColor: RED, borderColor: RED },
  ratingText: { color: INK, fontSize: 22, fontWeight: '700' },
  ratingLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 13, paddingHorizontal: 4 },
  subtle: { color: MUTED, fontSize: 14 },
  morningReveal: { paddingBottom: 8 },
  revealIntro: { paddingHorizontal: 2, marginTop: 2, marginBottom: 17 },
  revealEyebrow: { color: '#B86F00', fontSize: 10, fontWeight: '900', letterSpacing: 1.8, marginBottom: 8 },
  revealTitle: { color: INK, fontSize: 38, lineHeight: 40, fontWeight: '900', letterSpacing: -1.5 },
  revealTitleAccent: { color: '#D88900' },
  revealSub: { color: MUTED, fontSize: 13, lineHeight: 18, marginTop: 8, maxWidth: 320 },
  energyCard: { backgroundColor: '#19151B', borderRadius: 23, paddingHorizontal: 16, paddingTop: 15, paddingBottom: 13, overflow: 'hidden', shadowColor: '#1A131A', shadowOpacity: 0.2, shadowRadius: 14, shadowOffset: { width: 0, height: 7 }, elevation: 4 },
  energyCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  energyKicker: { color: '#FFFFFF', fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  energyCaption: { color: '#AAA3AD', fontSize: 10, marginTop: 3 },
  liveIndicator: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#F29A00', marginRight: 4 },
  energyChart: { height: 195, marginTop: 11, position: 'relative', overflow: 'hidden' },
  chartGuide: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.12)' },
  energySegment: { position: 'absolute', height: 3, borderRadius: 3, transformOrigin: 'center' },
  energyNode: { position: 'absolute', width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: '#19151B' },
  chartAxisLabel: { position: 'absolute', bottom: 0, color: '#9B949D', fontSize: 7, fontWeight: '800', letterSpacing: 0.7 },
  chartStartLabel: { left: 0 },
  chartEndLabel: { right: 0 },
  loopCallout: { position: 'absolute', left: 2, color: '#FF8B81', backgroundColor: '#3A2529', overflow: 'hidden', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 5, fontSize: 7, fontWeight: '900', letterSpacing: 0.5 },
  wayykupCallout: { position: 'absolute', right: 1, color: '#19151B', backgroundColor: '#F29A00', overflow: 'hidden', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 5, fontSize: 7, fontWeight: '900', letterSpacing: 0.5 },
  energyLegend: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 3 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 7, height: 7, borderRadius: 4 },
  legendText: { color: '#D3CDD5', fontSize: 9, fontWeight: '700' },
  revealPayoff: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 15, paddingHorizontal: 13, paddingVertical: 11, borderRadius: 13, backgroundColor: '#FFF5E5' },
  payoffMark: { color: '#C57700', fontSize: 21, fontWeight: '900' },
  payoffText: { flex: 1, color: INK, fontSize: 12, fontWeight: '800', lineHeight: 17 },
  graphNote: { color: MUTED, fontSize: 10, lineHeight: 15, marginTop: 13 },
  savingsWrap: { gap: 12, marginTop: 2, paddingBottom: 8 },
  savingsIntro: { alignItems: 'center', paddingHorizontal: 8, marginBottom: 1 },
  savingsIntroLabel: { color: '#B36C00', fontSize: 10, fontWeight: '900', letterSpacing: 1.5, textAlign: 'center' },
  savingsIntroText: { color: INK, fontSize: 15, fontWeight: '700', lineHeight: 21, textAlign: 'center', marginTop: 5 },
  savingsPattern: { backgroundColor: '#F5F3F6', borderRadius: 17, paddingHorizontal: 15, paddingVertical: 12 },
  savingsPatternLabel: { color: MUTED, fontSize: 9, fontWeight: '900', letterSpacing: 1.2, marginBottom: 7 },
  savingsPatternRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 25 },
  savingsPatternKey: { color: MUTED, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  savingsPatternValue: { color: INK, flex: 1, fontSize: 12, fontWeight: '800', textAlign: 'right', textTransform: 'capitalize' },
  savingsPatternDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#E1DEE4', marginVertical: 4 },
  savingsCard: { minHeight: 195, overflow: 'hidden', backgroundColor: INK, borderRadius: 24, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 18 },
  savingsOrbit: { position: 'absolute', width: 184, height: 184, borderWidth: 1, borderColor: '#49351A', borderRadius: 100 },
  savingsEyebrow: { color: '#F8C46D', fontSize: 9, fontWeight: '900', letterSpacing: 1.4, textAlign: 'center' },
  savingsNumber: { color: '#FFAC1C', fontSize: 68, lineHeight: 75, fontWeight: '900', letterSpacing: -3, marginTop: 5 },
  savingsBottom: { color: '#FFFFFF', fontSize: 15, fontWeight: '800', marginTop: 1 },
  savingsFormula: { color: '#C8C0CC', fontSize: 10, fontWeight: '700', letterSpacing: 0.6, marginTop: 9 },
  metricsRow: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 4 },
  metric: { alignItems: 'center' },
  metricValue: { color: INK, fontSize: 17, fontWeight: '900' },
  metricLabel: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 0.5, marginTop: 5 },
  disclaimer: { color: MUTED, fontSize: 10, lineHeight: 15, marginTop: 17, textAlign: 'center' },
  infoCard: { backgroundColor: '#F2F1F6', borderRadius: 22, padding: 21, alignItems: 'center', marginTop: 20 },
  infoIcon: { color: RED, fontSize: 63, fontWeight: '700', marginBottom: 12 },
  infoText: { color: INK, fontSize: 15, lineHeight: 23, textAlign: 'center' },
  reframeWrap: { flex: 1, alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: 0 },
  reframeHeading: { color: '#17131B', fontFamily: 'Georgia', fontSize: 38, fontWeight: '700', lineHeight: 48, textAlign: 'center', letterSpacing: -0.5 },
  reframeText: { color: '#66616A', fontSize: 16, lineHeight: 26, fontWeight: '400', textAlign: 'center', paddingHorizontal: 0 },
  setupArt: { flex: 1, alignItems: 'center', justifyContent: 'space-between', minHeight: 510, paddingBottom: 8 },
  setupBrand: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 4 },
  setupProgress: { color: '#9A969D', fontFamily: 'Georgia', fontSize: 14, fontWeight: '700' },
  setupHeading: { color: '#17131B', fontFamily: 'Georgia', fontSize: 38, fontWeight: '700', lineHeight: 48, letterSpacing: -0.5, textAlign: 'center' },
  setupSub: { color: '#96929A', fontSize: 16, lineHeight: 24, textAlign: 'center', marginTop: -7 },
  timePicker: { height: 230, borderRadius: 20, backgroundColor: '#F3F2F6', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginTop: 35 },
  wheelColumn: { width: 75, height: 230, overflow: 'hidden' },
  wheelRow: { height: 46, alignItems: 'center', justifyContent: 'center' },
  wheelText: { color: '#B7B4BC', fontSize: 21, fontWeight: '500' },
  wheelTextSelected: { color: INK, fontSize: 27, fontWeight: '800' },
  wheelSelection: { position: 'absolute', left: 12, right: 12, top: 92, height: 46, borderRadius: 12, backgroundColor: '#E5E3E9' },
  colon: { color: INK, fontSize: 27, fontWeight: '800' },
  repeatBody: { flex: 1, justifyContent: 'center', paddingTop: 8 },
  repeatPanel: { width: '100%', alignSelf: 'center', backgroundColor: '#E7E2E9', borderRadius: 29, paddingHorizontal: 19, paddingVertical: 20 },
  repeatPanelTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 20 },
  repeatLabel: { color: '#17131B', fontSize: 15, fontWeight: '800' },
  repeatPresets: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  repeatPreset: { minHeight: 43, flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#F4F1F6', borderRadius: 24, paddingHorizontal: 9 },
  repeatPresetSelected: { backgroundColor: '#171018' },
  repeatPresetCheck: { color: '#9B96A0', fontSize: 16, fontWeight: '500' },
  repeatPresetCheckSelected: { color: '#FFFFFF' },
  repeatPresetText: { color: '#96919A', fontSize: 12, fontWeight: '600' },
  repeatPresetTextSelected: { color: '#FFFFFF' },
  dayRow: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  dayItem: { flex: 1, minWidth: 0, alignItems: 'center' },
  dayButton: { width: '100%', maxWidth: 48, aspectRatio: 1, borderRadius: 28, backgroundColor: '#F4F1F6', alignItems: 'center', justifyContent: 'center' },
  dayButtonSelected: { backgroundColor: '#F2A008' },
  dayText: { color: '#99949D', fontSize: 11, fontWeight: '700' },
  dayTextSelected: { color: '#FFFFFF' },
  soundIntro: { color: '#96929A', fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: 20 },
  soundSection: { marginBottom: 22 },
  soundSectionTitle: { color: INK, fontSize: 19, fontWeight: '800', marginBottom: 10 },
  soundCard: { backgroundColor: '#F4F3F7', borderRadius: 20, paddingHorizontal: 16 },
  soundRow: { minHeight: 73, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#D9D6DD' },
  soundRowLast: { borderBottomWidth: 0 },
  playButton: { width: 43, height: 43, borderRadius: 22, backgroundColor: '#EBE9EE', alignItems: 'center', justifyContent: 'center' },
  playIcon: { color: '#85818A', fontSize: 15, marginLeft: 2 },
  soundCopy: { flex: 1, paddingHorizontal: 13 },
  soundName: { color: INK, fontSize: 16, fontWeight: '500' },
  selectSound: { width: 25, height: 25, borderRadius: 13, borderWidth: 1.5, borderColor: '#8E8991', alignItems: 'center', justifyContent: 'center' },
  selectSoundOn: { backgroundColor: '#F09042', borderColor: '#F09042' },
  check: { color: '#FFFFFF', fontSize: 15, fontWeight: '900' },
  checkOn: { color: '#FFFFFF' },
  notificationWrap: { flex: 1, paddingTop: 39 },
  notificationStack: { width: '100%', height: 150, position: 'relative', alignItems: 'center' },
  mockNotificationBack: { position: 'absolute', bottom: 0, width: '88%', height: 83, flexDirection: 'row', alignItems: 'center', backgroundColor: '#E8E8E8', borderRadius: 24, paddingHorizontal: 15, paddingTop: 16 },
  notificationBackText: { color: '#19171A', fontSize: 16, fontWeight: '500', marginLeft: 13 },
  mockNotificationFront: { position: 'absolute', top: 0, width: '100%', minHeight: 104, flexDirection: 'row', alignItems: 'center', backgroundColor: '#E8E8E8', borderRadius: 24, paddingHorizontal: 16, paddingVertical: 14, zIndex: 2, shadowColor: '#6E6B70', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 3 },
  notificationCopy: { flex: 1, marginLeft: 14 },
  notificationHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 },
  notificationApp: { color: '#17131B', fontSize: 13, fontWeight: '800', letterSpacing: 0.1 },
  notificationNow: { color: '#88848B', fontSize: 12, marginLeft: 8 },
  notificationText: { color: '#17131B', fontSize: 16, fontWeight: '500' },
  notificationBottom: { paddingHorizontal: 52, paddingTop: 10, paddingBottom: 30 },
  warningCard: { backgroundColor: '#FFF2DF', borderRadius: 15, padding: 14, marginTop: 14 },
  warningText: { color: INK, fontSize: 13, lineHeight: 19 },
  settingsLink: { color: '#9B5D00', fontSize: 11, fontWeight: '900', marginTop: 10 },
  challengeGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: 0, rowGap: 9, paddingBottom: 12 },
  challengeCard: { width: '100%', height: 190, borderRadius: 18, padding: 0, borderWidth: 2, borderColor: '#E1E9E2', position: 'relative', overflow: 'hidden', backgroundColor: '#FFFFFF' },
  challengeCardSelected: { borderColor: '#218B57', backgroundColor: '#F3FBF5' },
  challengeCardUnavailable: { opacity: 0.55 },
  challengeArtwork: { height: 78, overflow: 'hidden', margin: 7, borderRadius: 12 },
  challengeCopy: { paddingHorizontal: 9, flex: 1 },
  challengeTitle: { color: '#17131B', fontSize: 13, lineHeight: 16, fontWeight: '900', textAlign: 'left', paddingHorizontal: 0, paddingVertical: 2 },
  challengeDescription: { color: '#77736F', fontSize: 11, lineHeight: 14 },
  challengeMetaRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 2, paddingTop: 4, paddingBottom: 6 },
  challengeMeta: { color: '#218B57', fontSize: 9, fontWeight: '900' },
  challengeMissionIcon: { position: 'absolute', top: 11, right: 11, width: 27, height: 27, borderRadius: 14, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  challengeMissionIconText: { color: '#218B57', fontSize: 17, fontWeight: '900' },
  challengeConfigPanel: { width: '100%', backgroundColor: '#F3F8F4', borderRadius: 14, padding: 11, marginBottom: 8 },
  challengeConfigHeading: { color: '#4C5850', fontSize: 10, letterSpacing: 0.8, fontWeight: '900', marginBottom: 8 },
  challengeConfigChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  challengeConfigChoice: { minHeight: 34, paddingHorizontal: 10, borderRadius: 10, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E3EAE4', alignItems: 'center', justifyContent: 'center' },
  challengeConfigChoiceSelected: { backgroundColor: '#218B57', borderColor: '#218B57' },
  challengeConfigChoiceText: { color: '#525B54', fontSize: 11, fontWeight: '800' },
  challengeConfigChoiceTextSelected: { color: '#FFFFFF' },
  challengeCheck: { position: 'absolute', right: 10, top: 10, color: '#17131B', fontSize: 17, fontWeight: '900', width: 25, height: 25, borderRadius: 13, backgroundColor: '#FFFFFF', textAlign: 'center', lineHeight: 25 },
  challengeContinueButton: { minHeight: 57, backgroundColor: '#FFFFFF', borderWidth: 1.5, borderColor: '#17131B', shadowOpacity: 0, elevation: 0 },
  challengeContinueText: { color: '#17131B' },
  homeItemsGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 8, paddingBottom: 12 },
  homeItemsDescription: { color: MUTED, fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: 18, paddingHorizontal: 8 },
  homeItemCard: { width: '100%', aspectRatio: 1, borderRadius: 15, borderWidth: 1.5, borderColor: '#98949D', backgroundColor: '#F1EFF4', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, paddingVertical: 6 },
  homeItemCardSelected: { borderColor: RED, backgroundColor: '#FFF8EA' },
  homeItemImage: { fontSize: 29, lineHeight: 37, textAlign: 'center' },
  homeItemName: { color: '#17131B', fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 2, maxWidth: '100%' },
  homeItemCheck: { width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, borderColor: '#B9B5BE', backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', marginTop: 5 },
  homeItemCheckSelected: { backgroundColor: '#171018', borderColor: '#171018' },
  homeItemCheckmark: { color: '#FFFFFF', fontSize: 17, lineHeight: 20, fontWeight: '900' },
  homeItemsBottom: { paddingHorizontal: 44, paddingTop: 9, paddingBottom: 14 },
  bottomCompact: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 10 },
  homeItemsContinueButton: { minHeight: 60, borderRadius: 35, backgroundColor: '#171018', shadowOpacity: 0, elevation: 0 },
  homeItemsContinueText: { color: '#FFFFFF', fontSize: 17 },
  cameraAccessBottom: { paddingHorizontal: 36, paddingTop: 8, paddingBottom: 16 },
  cameraAccessContinueButton: { minHeight: 58, borderRadius: 31, backgroundColor: '#171018', shadowOpacity: 0, elevation: 0 },
  cameraAccessContinueText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  premiumNote: { width: '100%', color: MUTED, fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: 5 },
  qrError: { color: '#B3261E', fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 10 },
  qrWrap: { flex: 1 },
  camera: { height: 280, borderRadius: 18, overflow: 'hidden', marginTop: 12 },
  scanButton: { minHeight: 52, backgroundColor: INK, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginTop: 15 },
  scanButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900', letterSpacing: 0.6 },
  linkedText: { color: '#22834B', fontSize: 14, fontWeight: '900', textAlign: 'center', marginTop: 18 },
  alternateTask: { alignItems: 'center', padding: 12 },
  alternateTaskText: { color: MUTED, fontSize: 13, fontWeight: '700' },
  draftWarning: { color: '#8D4D00', fontSize: 11, lineHeight: 15, paddingHorizontal: 18, paddingBottom: 6, textAlign: 'center' },
  cameraAccessWrap: { alignItems: 'center', paddingHorizontal: 4, paddingBottom: 12 },
  cameraAccessWrapCompact: { paddingBottom: 4 },
  cameraAccessArt: { width: '100%', maxWidth: 380, height: 310, alignSelf: 'center' },
  cameraAccessArtCompact: { height: 276 },
  cameraAccessArtShort: { height: 238 },
  cameraAccessDescription: { color: '#77727C', fontSize: 15, lineHeight: 23, textAlign: 'center', marginTop: 4, paddingHorizontal: 8, maxWidth: 340 },
  screenDescription: { color: '#77727C', fontSize: 15, lineHeight: 23, textAlign: 'center', marginTop: 8, marginBottom: 16, paddingHorizontal: 8 },
  privacyNote: { width: '100%', flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#F5F3F7', borderRadius: 16, padding: 14, gap: 10 },
  privacyIcon: { color: RED, fontSize: 21, fontWeight: '900' },
  privacyCopy: { flex: 1, color: '#716D75', fontSize: 12, lineHeight: 18 },
  permissionError: { color: '#B3261E', fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 14 },
  objectPickWrap: { alignItems: 'center', paddingHorizontal: 4, paddingBottom: 18 },
  randomObjectCard: { width: '100%', maxWidth: 310, minHeight: 214, borderRadius: 28, backgroundColor: '#17131B', alignItems: 'center', justifyContent: 'center', marginTop: 8, shadowColor: '#17131B', shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 5 },
  randomObjectCorners: { width: 112, height: 112, borderRadius: 56, backgroundColor: '#FFF3D6', alignItems: 'center', justifyContent: 'center' },
  randomObjectEmoji: { fontSize: 60 },
  randomObjectName: { color: '#FFFFFF', fontSize: 15, fontWeight: '900', letterSpacing: 2, marginTop: 16 },
  randomObjectInstruction: { color: INK, fontSize: 17, fontWeight: '900', letterSpacing: 0.5, textAlign: 'center', marginTop: 19 },
  randomObjectNote: { color: MUTED, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 6 },
  devPreviewButton: { alignItems: 'center', padding: 12, marginTop: 3 },
  devPreviewText: { color: '#8E687C', fontSize: 11, fontWeight: '700', textDecorationLine: 'underline' },
  playbackOptions: { gap: 13, paddingTop: 3, paddingBottom: 18 },
  playbackOption: { flexDirection: 'row', alignItems: 'center', minHeight: 84, borderRadius: 18, borderWidth: 1.5, borderColor: '#D5D1D8', padding: 15, backgroundColor: '#FFFFFF' },
  playbackOptionSelected: { borderColor: RED, backgroundColor: '#FFF8EA' },
  playbackRadio: { width: 22, height: 22, borderRadius: 12, borderWidth: 1.5, borderColor: '#AAA6AF', marginRight: 13 },
  playbackRadioSelected: { borderWidth: 6, borderColor: RED },
  playbackOptionCopy: { flex: 1 },
  playbackOptionTitle: { color: INK, fontSize: 14, lineHeight: 19, fontWeight: '800' },
  playbackOptionDetail: { color: MUTED, fontSize: 12, lineHeight: 17, marginTop: 4 },
  commitIntroWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 18 },
  commitIntroTime: { color: RED, fontSize: 42, lineHeight: 50, fontWeight: '900', letterSpacing: -1.5, marginBottom: 20 },
  commitIntroStatement: { color: INK, fontFamily: 'Georgia', fontSize: 22, lineHeight: 31, fontWeight: '700', textAlign: 'center', maxWidth: 420 },
  commitIntroNote: { color: MUTED, fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: 18 },
  commitWrap: { flex: 1, width: '100%', alignItems: 'center', paddingHorizontal: 8, paddingTop: 4 },
  signaturePrompt: { color: '#89868D', fontSize: 15, lineHeight: 22, textAlign: 'center' },
  signaturePad: { width: '100%', maxWidth: 430, height: 190, backgroundColor: '#FFFFFF', borderBottomWidth: 1.5, borderColor: '#D8D4DC', overflow: 'hidden' },
  signatureHint: { position: 'absolute', top: '45%', alignSelf: 'center', color: '#B3AFB7', fontSize: 12, fontWeight: '600', letterSpacing: 0.5, zIndex: 1 },
  signatureBaseline: { position: 'absolute', left: 20, right: 20, bottom: 28, height: 1, backgroundColor: '#E3E0E5' },
  clearSignatureButton: { alignSelf: 'flex-end', paddingVertical: 10, paddingHorizontal: 4 },
  clearSignatureText: { color: '#77727C', fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  clearSignatureDisabled: { color: '#B9B5BE' },
  commitmentConfirmation: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 8, paddingHorizontal: 4 },
  commitmentRing: { width: 58, height: 58, borderRadius: 30, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  commitmentCheck: { color: RED, fontSize: 29, fontWeight: '900' },
  commitmentTitle: { color: INK, fontSize: 16, lineHeight: 21, fontWeight: '900' },
  commitmentDetail: { color: MUTED, fontSize: 12, lineHeight: 17, marginTop: 3, flexShrink: 1 },
  fingerprintWrap: { flex: 1, alignItems: 'center', paddingHorizontal: 8, paddingTop: 0 },
  fingerprintPrompt: { color: '#89868D', fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: '14%' },
  fingerprintTouchTarget: { width: '100%', flex: 1, alignItems: 'center', justifyContent: 'center' },
  fingerprintCircle: { width: 250, height: 250, maxWidth: '80%', maxHeight: '80%', aspectRatio: 1, borderWidth: 3, borderColor: '#29242B', borderRadius: 140, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  fingerprintCircleActive: { borderColor: '#E99443', backgroundColor: '#FFF9F2' },
  bottom: { paddingHorizontal: 28, paddingTop: 12, paddingBottom: 14 },
  setupBottom: { paddingHorizontal: 52, paddingTop: 10, paddingBottom: 30 },
  repeatBottom: { paddingHorizontal: 52, paddingTop: 10, paddingBottom: 30 },
  continueButton: { minHeight: 58, borderRadius: 32, backgroundColor: RED, alignItems: 'center', justifyContent: 'center', shadowColor: RED, shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 3 },
  reframeContinueButton: { minHeight: 70, backgroundColor: '#171018', shadowColor: '#171018', shadowOpacity: 0.12, borderRadius: 40 },
  reframeContinueText: { color: '#FFFFFF', fontSize: 17 },
  continueDisabled: { backgroundColor: '#F2F1F4', borderWidth: 1, borderColor: '#C7C4CB', shadowOpacity: 0, elevation: 0 },
  continueText: { color: INK, fontSize: 16, fontWeight: '800' },
  continueTextDisabled: { color: '#8E8B92' },
  laterButton: { alignItems: 'center', padding: 10 },
  laterText: { color: MUTED, fontSize: 13, fontWeight: '700' },
});
