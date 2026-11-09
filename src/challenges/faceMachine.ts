import { WAKE_CHALLENGE_CONFIG } from './config';

export type FaceGesture = 'smile' | 'blink_twice' | 'turn_left' | 'turn_right' | 'open_mouth';

export type FaceSnapshot = {
  smilingProbability?: number;
  leftEyeOpenProbability?: number;
  rightEyeOpenProbability?: number;
  yawAngle: number;
  mouthOpenRatio?: number;
};

export type FaceState = {
  sequence: FaceGesture[];
  index: number;
  attempts: number;
  startedAt: number;
  gestureStartedAt: number;
  neutralSeen: boolean;
  targetSince: number | null;
  eyesClosed: boolean;
  blinks: number;
  faceMissingSince: number | null;
};

export function shuffleFaceSequence(random: () => number = Math.random): FaceGesture[] {
  const pool = [...WAKE_CHALLENGE_CONFIG.face.gestures];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool.slice(0, WAKE_CHALLENGE_CONFIG.face.sequenceLength);
}

export function createFaceState(now: number, sequence = shuffleFaceSequence()): FaceState {
  return {
    sequence,
    index: 0,
    attempts: 1,
    startedAt: now,
    gestureStartedAt: now,
    neutralSeen: false,
    targetSince: null,
    eyesClosed: false,
    blinks: 0,
    faceMissingSince: null,
  };
}

function differentSequence(previous: FaceGesture[], nextSequence: () => FaceGesture[]): FaceGesture[] {
  const next = nextSequence();
  if (next.join(',') !== previous.join(',')) return next;
  return [...next.slice(1), next[0]];
}

export type FaceUpdate = {
  state: FaceState;
  completed: boolean;
  retry: boolean;
  lowLight: boolean;
};

export function updateFaceState(
  state: FaceState,
  face: FaceSnapshot | null,
  now: number,
  nextSequence: () => FaceGesture[] = () => shuffleFaceSequence(),
): FaceUpdate {
  const config = WAKE_CHALLENGE_CONFIG.face;
  const missingSince = face ? null : state.faceMissingSince ?? now;
  const lowLight = !face && now - (missingSince ?? now) >= config.lowLightHintMs;

  if (now - state.startedAt >= config.maxDurationMs
    || (!face && now - (missingSince ?? now) >= config.lowLightFallbackMs)) {
    return { state: { ...state, faceMissingSince: missingSince }, completed: false, retry: false, lowLight };
  }

  if (now - state.gestureStartedAt >= config.gestureTimeoutMs) {
    return {
      state: {
        ...createFaceState(now, differentSequence(state.sequence, nextSequence)),
        startedAt: state.startedAt,
        attempts: state.attempts + 1,
      },
      completed: false,
      retry: true,
      lowLight,
    };
  }

  if (!face) {
    return {
      state: {
        ...state,
        neutralSeen: false,
        targetSince: null,
        eyesClosed: false,
        blinks: 0,
        faceMissingSince: missingSince,
      },
      completed: false,
      retry: false,
      lowLight,
    };
  }

  const gesture = state.sequence[state.index];
  if (!gesture) return { state, completed: true, retry: false, lowLight: false };
  const eyesOpen = (face.leftEyeOpenProbability ?? 0) >= config.eyeOpenProbability
    && (face.rightEyeOpenProbability ?? 0) >= config.eyeOpenProbability;
  const eyesClosed = (face.leftEyeOpenProbability ?? 1) < config.eyeClosedProbability
    && (face.rightEyeOpenProbability ?? 1) < config.eyeClosedProbability;
  const neutral = Math.abs(face.yawAngle) <= config.neutralYawDegrees
    && (face.smilingProbability ?? 0) <= config.neutralSmileProbability
    && (face.mouthOpenRatio ?? 0) <= config.mouthClosedRatio
    && eyesOpen;
  const neutralSeen = state.neutralSeen || neutral;
  let targetSince = state.targetSince;
  let eyesClosedState = state.eyesClosed;
  let blinks = state.blinks;
  let gestureComplete = false;

  if (neutralSeen) {
    switch (gesture) {
      case 'smile':
        if ((face.smilingProbability ?? 0) >= config.smileProbability) {
          targetSince ??= now;
          gestureComplete = now - targetSince >= config.smileHoldMs;
        } else targetSince = null;
        break;
      case 'blink_twice':
        if (eyesClosed) eyesClosedState = true;
        else if (eyesOpen && eyesClosedState) {
          eyesClosedState = false;
          blinks += 1;
          gestureComplete = blinks >= 2;
        }
        break;
      case 'turn_left':
      case 'turn_right': {
        const turned = gesture === 'turn_left'
          ? face.yawAngle <= -config.headTurnYawDegrees
          : face.yawAngle >= config.headTurnYawDegrees;
        if (turned) {
          targetSince ??= now;
          gestureComplete = now - targetSince >= config.headTurnHoldMs;
        } else targetSince = null;
        break;
      }
      case 'open_mouth':
        if ((face.mouthOpenRatio ?? 0) >= config.mouthOpenRatio) {
          targetSince ??= now;
          gestureComplete = now - targetSince >= config.mouthHoldMs;
        } else targetSince = null;
        break;
    }
  }

  if (!gestureComplete) {
    return {
      state: { ...state, neutralSeen, targetSince, eyesClosed: eyesClosedState, blinks, faceMissingSince: null },
      completed: false,
      retry: false,
      lowLight: false,
    };
  }

  const index = state.index + 1;
  return {
    state: {
      ...state,
      index,
      gestureStartedAt: now,
      neutralSeen: false,
      targetSince: null,
      eyesClosed: false,
      blinks: 0,
      faceMissingSince: null,
    },
    completed: index >= config.sequenceLength,
    retry: false,
    lowLight: false,
  };
}
