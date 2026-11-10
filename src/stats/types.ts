export type OccurrenceStatus =
  | 'scheduled'
  | 'ringing'
  | 'completed'
  | 'bypassed'
  | 'abandoned'
  | 'missed'
  | 'skipped';

export type ChallengeType = 'yell_to_stop' | 'push_up' | 'shake_phone' | 'object_hunt' | 'legacy';
export type WakeTier = 'gentle' | 'standard' | 'brutal';
export type StatsPeriod = 'week' | 'month' | 'all';

export type Occurrence = {
  id: string;
  alarmId: string;
  localDate: string;
  tz: string;
  scheduledAt: number;
  firstRingAt?: number | null;
  completedAt?: number | null;
  status: OccurrenceStatus;
  challenge: ChallengeType;
  difficulty: number;
  tierReached: WakeTier;
  failedAttempts: number;
  rearms: number;
  soundId: string;
  morningRating?: 1 | 2 | 3 | 4 | 5 | null;
  shakesCounted?: number | null;
  challengeDurationMs?: number | null;
};

export type OccurrenceInput = Omit<Occurrence, 'firstRingAt' | 'completedAt' | 'morningRating'>;

export type StreakFreeze = {
  id: number;
  earnedAt: number;
  usedLocalDate: string | null;
  usedAt: number | null;
};

export type DayResult = 'woke' | 'late' | 'bypassed' | 'missed' | 'rest' | 'pending' | 'frozen';

export type TrendPoint = {
  localDate: string;
  valueMs: number;
};

export type PeriodMetrics = {
  averageWakeMs: number | null;
  averageDeltaPercent: number | null;
  successRate: number | null;
  successRateDelta: number | null;
  usualTier: WakeTier | null;
  previousTier: WakeTier | null;
  trend: TrendPoint[];
  trendPercent: number | null;
  trendDirection: 'down' | 'up' | null;
};

export type PersonalBests = {
  fastestWake: Occurrence | null;
  longestStreak: number;
  hardestSound: Occurrence | null;
};
