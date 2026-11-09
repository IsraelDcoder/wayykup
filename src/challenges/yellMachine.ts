import { WAKE_CHALLENGE_CONFIG } from './config';

export type YellMode = 'loud' | 'whisper';

export type YellState = {
  mode: YellMode;
  baselineDbfs: number;
  targetDbfs: number;
  targetReachable: boolean;
  smoothedDbfs: number;
  progressMs: number;
  lastFrameAt: number;
  aboveSince: number | null;
  peakPower: number;
};

export function createYellState(mode: YellMode, baselineDbfs: number, now: number): YellState {
  const config = WAKE_CHALLENGE_CONFIG.yell[mode];
  const targetDbfs = Math.min(baselineDbfs + config.targetDeltaDb, config.maximumTargetDbfs);
  return {
    mode,
    baselineDbfs,
    targetDbfs,
    targetReachable: targetDbfs - baselineDbfs >= config.minimumDeltaDb,
    smoothedDbfs: baselineDbfs,
    progressMs: 0,
    lastFrameAt: now,
    aboveSince: null,
    peakPower: 0,
  };
}

export function updateYellState(
  state: YellState,
  dbfs: number,
  now: number,
  alarmAudible: boolean,
): YellState {
  const config = WAKE_CHALLENGE_CONFIG.yell[state.mode];
  const elapsed = Math.max(0, Math.min(
    now - state.lastFrameAt,
    WAKE_CHALLENGE_CONFIG.yell.maxSampleIntervalMs,
  ));
  const smoothedDbfs = state.smoothedDbfs
    + WAKE_CHALLENGE_CONFIG.yell.smoothingAlpha * (dbfs - state.smoothedDbfs);
  const aboveTarget = smoothedDbfs >= state.targetDbfs;
  const aboveSince = aboveTarget ? state.aboveSince ?? now : null;
  let progressMs = state.progressMs;

  if (alarmAudible) {
    return { ...state, smoothedDbfs, lastFrameAt: now, aboveSince };
  }

  if (aboveTarget && aboveSince !== null && now - aboveSince >= WAKE_CHALLENGE_CONFIG.yell.spikeIgnoreMs) {
    progressMs += elapsed;
  } else if (!aboveTarget) {
    progressMs = Math.max(0, progressMs - elapsed * config.decayPerSecond);
  }

  return {
    ...state,
    smoothedDbfs,
    progressMs,
    lastFrameAt: now,
    aboveSince,
    peakPower: Math.max(state.peakPower, powerScore(smoothedDbfs, state.baselineDbfs)),
  };
}

export function yellProgress(state: YellState): number {
  const requiredMs = WAKE_CHALLENGE_CONFIG.yell[state.mode].progressMs;
  return Math.min(100, Math.round((state.progressMs / requiredMs) * 100));
}

export function powerScore(dbfs: number, baselineDbfs: number): number {
  const range = Math.max(
    WAKE_CHALLENGE_CONFIG.yell.powerRangeMinDb,
    Math.min(WAKE_CHALLENGE_CONFIG.yell.powerRangeMaxDb, -baselineDbfs),
  );
  return Math.max(0, Math.min(100, Math.round(((dbfs - baselineDbfs) / range) * 100)));
}
