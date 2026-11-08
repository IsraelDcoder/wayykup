import {
  GRACE_MS,
  TREND_HEADLINE_MIN_POINTS,
} from './constants';
import type {
  DayResult,
  Occurrence,
  PeriodMetrics,
  PersonalBests,
  StatsPeriod,
  StreakFreeze,
  TrendPoint,
  WakeTier,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const TIER_ORDER: Record<WakeTier, number> = { gentle: 0, standard: 1, brutal: 2 };

export function dateKeyInTimeZone(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function countsTowardStreak(occurrence: Occurrence): boolean {
  return occurrence.status === 'completed'
    && occurrence.completedAt != null
    && occurrence.completedAt >= occurrence.scheduledAt
    && occurrence.completedAt - occurrence.scheduledAt <= GRACE_MS;
}

export function shouldEarnFreeze(streakBefore: number, streakAfter: number, availableFreezes: number, cap: number): boolean {
  return streakAfter > streakBefore
    && streakAfter > 0
    && streakAfter % 7 === 0
    && availableFreezes < cap;
}

export function spendableOccurrenceDate(occurrences: Occurrence[], now: number): string | null {
  return occurrences
    .filter((item) => (item.status === 'missed' || item.status === 'bypassed' || item.status === 'abandoned')
      && item.scheduledAt <= now
      && now - item.scheduledAt <= DAY_MS)
    .sort((a, b) => b.scheduledAt - a.scheduledAt)[0]?.localDate ?? null;
}

export function timeToWakeMs(occurrence: Occurrence): number | null {
  if (occurrence.firstRingAt == null || occurrence.completedAt == null) return null;
  return Math.max(0, occurrence.completedAt - occurrence.firstRingAt);
}

export function dayResult(
  occurrences: Occurrence[],
  freezeDates: ReadonlySet<string> = new Set(),
  now = Date.now(),
): DayResult {
  if (!occurrences.length) return 'rest';
  const scheduledOccurrences = occurrences.filter((occurrence) => occurrence.status !== 'skipped');
  if (!scheduledOccurrences.length) return 'rest';
  const statuses = scheduledOccurrences.map((occurrence) =>
    occurrence.status === 'scheduled' || occurrence.status === 'ringing'
      ? occurrence.firstRingAt == null ? 'missed' : 'abandoned'
      : occurrence.status,
  );
  if (scheduledOccurrences.some((item) =>
    (item.status === 'scheduled' || item.status === 'ringing')
      && now < item.scheduledAt + GRACE_MS,
  )) return 'pending';
  if (scheduledOccurrences.every(countsTowardStreak)) return 'woke';
  if (
    freezeDates.has(scheduledOccurrences[0].localDate)
    && statuses.some((status) => status === 'bypassed' || status === 'missed' || status === 'abandoned')
  ) return 'frozen';
  if (statuses.some((status) => status === 'bypassed')) return 'bypassed';
  if (statuses.some((status) => status === 'missed' || status === 'abandoned')) return 'missed';
  if (statuses.some((status) => status === 'completed')) return 'late';
  return 'missed';
}

function groupByLocalDate(occurrences: Occurrence[]): Map<string, Occurrence[]> {
  const days = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    const day = days.get(occurrence.localDate) ?? [];
    day.push(occurrence);
    days.set(occurrence.localDate, day);
  }
  return days;
}

export function calculateStreaks(
  occurrences: Occurrence[],
  freezeDates: ReadonlySet<string> = new Set(),
  now = Date.now(),
): { current: number; best: number } {
  const days = groupByLocalDate(occurrences);
  const dates = [...days.keys()].sort();
  let running = 0;
  let best = 0;
  for (const date of dates) {
    const result = dayResult(days.get(date) ?? [], freezeDates, now);
    if (result === 'woke') running += 1;
    else if (result === 'frozen' || result === 'rest' || result === 'pending') {
      if (result === 'rest' || result === 'pending') continue;
    } else {
      running = 0;
    }
    best = Math.max(best, running);
  }

  let current = 0;
  for (const date of dates.reverse()) {
    const result = dayResult(days.get(date) ?? [], freezeDates, now);
    if (result === 'woke') current += 1;
    else if (result === 'frozen' || result === 'rest' || result === 'pending') {
      if (result === 'rest' || result === 'pending') continue;
    } else {
      break;
    }
  }
  return { current, best };
}

export function getPeriodStart(period: StatsPeriod, now: Date): Date | null {
  if (period === 'all') return null;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (period === 'week' ? 6 : 29));
  return start;
}

function rangeStart(period: StatsPeriod, now: Date): number | null {
  return getPeriodStart(period, now)?.getTime() ?? null;
}

function completedWithWake(occurrences: Occurrence[], start: number | null, end: number): Occurrence[] {
  return occurrences.filter((item) => item.status === 'completed'
    && item.completedAt != null
    && item.completedAt <= end
    && (start === null || item.scheduledAt >= start)
    && timeToWakeMs(item) !== null);
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function tierMode(occurrences: Occurrence[]): WakeTier | null {
  if (!occurrences.length) return null;
  const counts: Record<WakeTier, number> = { gentle: 0, standard: 0, brutal: 0 };
  occurrences.forEach((item) => { counts[item.tierReached] += 1; });
  return (Object.keys(counts) as WakeTier[]).sort((a, b) => counts[b] - counts[a] || TIER_ORDER[a] - TIER_ORDER[b])[0];
}

function dateNumber(localDate: string): number {
  const [year, month, day] = localDate.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function buildTrend(occurrences: Occurrence[], period: StatsPeriod, now: Date): TrendPoint[] {
  const start = rangeStart(period, now);
  const end = now.getTime();
  const rows = completedWithWake(occurrences, start, end);
  const buckets = new Map<string, number[]>();
  for (const item of rows) {
    const bucket = period === 'all' && now.getTime() - (item.completedAt ?? end) > 90 * DAY_MS
      ? `week:${Math.floor(dateNumber(item.localDate) / (7 * DAY_MS))}`
      : item.localDate;
    const values = buckets.get(bucket) ?? [];
    values.push(timeToWakeMs(item) ?? 0);
    buckets.set(bucket, values);
  }
  return [...buckets.entries()]
    .map(([key, values]) => ({
      localDate: key.startsWith('week:') ? key.slice(5) : key,
      valueMs: average(values) ?? 0,
    }))
    .sort((a, b) => Number(a.localDate) - Number(b.localDate));
}

function successRate(occurrences: Occurrence[], start: number | null, end: number): number | null {
  const periodRows = occurrences.filter((item) => item.scheduledAt <= end
    && (start === null || item.scheduledAt >= start)
    && item.status !== 'skipped'
    && (item.status !== 'scheduled' && item.status !== 'ringing'
      || item.scheduledAt + GRACE_MS <= end));
  if (!periodRows.length) return null;
  return periodRows.filter(countsTowardStreak).length / periodRows.length;
}

export function derivePeriodMetrics(
  occurrences: Occurrence[],
  period: StatsPeriod,
  now: Date,
): PeriodMetrics {
  const end = now.getTime();
  const currentStart = rangeStart(period, now);
  const previousStart = period === 'all'
    ? null
    : (() => {
      const start = new Date(currentStart!);
      start.setDate(start.getDate() - (period === 'week' ? 7 : 30));
      return start.getTime();
    })();
  const previousEnd = currentStart! - 1;
  const currentCompleted = completedWithWake(occurrences, currentStart, end);
  const previousCompleted = period === 'all' ? [] : completedWithWake(occurrences, previousStart, previousEnd);
  const currentAverage = average(currentCompleted.map((item) => timeToWakeMs(item) ?? 0));
  const previousAverage = average(previousCompleted.map((item) => timeToWakeMs(item) ?? 0));
  const trend = buildTrend(occurrences, period, now);
  let trendPercent: number | null = null;
  if (trend.length >= TREND_HEADLINE_MIN_POINTS) {
    const first = average(trend.slice(0, 5).map((point) => point.valueMs));
    const last = average(trend.slice(-5).map((point) => point.valueMs));
    if (first && last) trendPercent = ((last - first) / first) * 100;
  }
  const currentSuccess = successRate(occurrences, currentStart, end);
  const previousSuccess = period === 'all' ? null : successRate(occurrences, previousStart, previousEnd);
  return {
    averageWakeMs: currentAverage,
    averageDeltaPercent: currentAverage != null && previousAverage
      ? ((currentAverage - previousAverage) / previousAverage) * 100
      : null,
    successRate: currentSuccess,
    successRateDelta: currentSuccess != null && previousSuccess != null ? currentSuccess - previousSuccess : null,
    usualTier: tierMode(currentCompleted),
    previousTier: tierMode(previousCompleted),
    trend,
    trendPercent,
    trendDirection: trendPercent === null ? null : trendPercent <= 0 ? 'down' : 'up',
  };
}

export function derivePersonalBests(occurrences: Occurrence[], freezeDates: ReadonlySet<string>): PersonalBests {
  const completed = occurrences.filter((item) => item.status === 'completed' && timeToWakeMs(item) !== null);
  const fastestWake = [...completed].sort((a, b) => (timeToWakeMs(a) ?? Infinity) - (timeToWakeMs(b) ?? Infinity))[0] ?? null;
  const hardestSound = [...completed].sort((a, b) =>
    TIER_ORDER[b.tierReached] - TIER_ORDER[a.tierReached] || b.rearms - a.rearms,
  )[0] ?? null;
  return {
    fastestWake,
    longestStreak: calculateStreaks(occurrences, freezeDates).best,
    hardestSound,
  };
}

export function deriveInsights(occurrences: Occurrence[], now: Date): string[] {
  const completed = completedWithWake(occurrences, null, now.getTime());
  if (completed.length < 14) return [];
  const insights: string[] = [];
  const weekdayBuckets = Array.from({ length: 7 }, () => [] as number[]);
  for (const item of completed) {
    const [year, month, day] = item.localDate.split('-').map(Number);
    const dayIndex = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
    weekdayBuckets[dayIndex].push(timeToWakeMs(item) ?? 0);
  }
  const eligibleWeekdays = weekdayBuckets
    .map((values, index) => ({ index, mean: values.length >= 3 ? average(values) : null }))
    .filter((item): item is { index: number; mean: number } => item.mean !== null);
  if (eligibleWeekdays.length >= 2) {
    const weakDay = eligibleWeekdays.sort((a, b) => b.mean - a.mean)[0];
    const otherMean = average(eligibleWeekdays.filter((item) => item.index !== weakDay.index).map((item) => item.mean));
    if (otherMean && weakDay.mean >= otherMean * 1.25) {
      const label = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][weakDay.index];
      insights.push(`${label}s are your slowest mornings so far.`);
    }
  }
  if (insights.length < 2) {
    const byChallenge = new Map<string, number[]>();
    for (const item of completed) {
      const values = byChallenge.get(item.challenge) ?? [];
      values.push(timeToWakeMs(item) ?? 0);
      byChallenge.set(item.challenge, values);
    }
    const eligible = [...byChallenge.entries()]
      .filter(([, values]) => values.length >= 5)
      .map(([challenge, values]) => ({ challenge, mean: average(values) ?? 0 }));
    if (eligible.length >= 2) {
      eligible.sort((a, b) => b.mean - a.mean);
      if (eligible[0].mean >= eligible[1].mean * 1.3) {
        insights.push(`You wake faster with ${eligible[1].challenge.replace('_', ' ')} than ${eligible[0].challenge.replace('_', ' ')}.`);
      }
    }
  }
  return insights.slice(0, 2);
}

export function weekDates(now: Date): string[] {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    return localDateKey(date);
  });
}

export function heatmapDates(now: Date): string[] {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);
  start.setDate(end.getDate() - 34);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return Array.from({ length: 35 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return localDateKey(date);
  });
}

export function formatDuration(milliseconds: number | null): string {
  if (milliseconds == null) return '—';
  const totalSeconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}
