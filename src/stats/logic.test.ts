import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateStreaks,
  countsTowardStreak,
  dateKeyInTimeZone,
  dayResult,
  derivePeriodMetrics,
  localDateKey,
  spendableOccurrenceDate,
  shouldEarnFreeze,
} from './logic';
import type { Occurrence } from './types';

const DAY = 24 * 60 * 60 * 1000;

function occurrence(
  localDate: string,
  status: Occurrence['status'] = 'completed',
  options: Partial<Occurrence> = {},
): Occurrence {
  const [year, month, day] = localDate.split('-').map(Number);
  const scheduledAt = Date.UTC(year, month - 1, day, 6);
  return {
    id: `${options.alarmId ?? 'alarm'}:${localDate}`,
    alarmId: options.alarmId ?? 'alarm',
    localDate,
    tz: 'America/New_York',
    scheduledAt,
    firstRingAt: status === 'skipped' ? null : scheduledAt,
    completedAt: status === 'completed' ? scheduledAt + 60_000 : null,
    status,
    challenge: 'yell_to_stop',
    difficulty: 2,
    tierReached: 'gentle',
    failedAttempts: 0,
    rearms: 0,
    soundId: 'air_raid',
    ...options,
  };
}

test('rest and skipped days do not break a streak', () => {
  const data = [
    occurrence('2025-01-01'),
    occurrence('2025-01-02', 'skipped'),
    occurrence('2025-01-03'),
  ];
  assert.deepEqual(calculateStreaks(data, new Set(), Date.UTC(2025, 0, 4)), { current: 2, best: 2 });
  assert.equal(dayResult([data[1]]), 'rest');
});

test('a freeze protects continuity without adding a streak day', () => {
  const data = Array.from({ length: 7 }, (_, index) =>
    occurrence(`2025-01-${String(index + 1).padStart(2, '0')}`),
  );
  data.push(occurrence('2025-01-08', 'bypassed'));
  data.push(occurrence('2025-01-09'));
  assert.deepEqual(
    calculateStreaks(data, new Set(['2025-01-08']), Date.UTC(2025, 0, 10)),
    { current: 8, best: 8 },
  );
});

test('freeze milestones award at multiples of seven, respect the cap, and spend only within 24 hours', () => {
  assert.equal(shouldEarnFreeze(6, 7, 0, 2), true);
  assert.equal(shouldEarnFreeze(6, 7, 2, 2), false);
  assert.equal(shouldEarnFreeze(7, 8, 0, 2), false);

  const now = Date.UTC(2025, 0, 10, 12);
  assert.equal(spendableOccurrenceDate([occurrence('2025-01-10', 'bypassed', { scheduledAt: now - 60_000 })], now), '2025-01-10');
  assert.equal(spendableOccurrenceDate([occurrence('2025-01-09', 'missed', { scheduledAt: now - DAY - 1 })], now), null);
});

test('bypasses and late completions break the streak', () => {
  const onTime = occurrence('2025-01-01');
  const bypass = occurrence('2025-01-02', 'bypassed');
  const late = occurrence('2025-01-03', 'completed', {
    completedAt: Date.UTC(2025, 0, 3, 6) + 10 * 60_000 + 1,
  });
  assert.equal(countsTowardStreak(onTime), true);
  assert.equal(countsTowardStreak(late), false);
  assert.deepEqual(calculateStreaks([onTime, bypass, late], new Set(), Date.UTC(2025, 0, 4)), { current: 0, best: 1 });
});

test('an unresolved alarm inside its grace period does not count as a miss', () => {
  const now = Date.UTC(2025, 0, 10, 6, 5);
  const pending = occurrence('2025-01-10', 'ringing', {
    scheduledAt: now - 5 * 60_000,
    completedAt: null,
  });
  assert.equal(dayResult([pending], new Set(), now), 'pending');
  assert.deepEqual(calculateStreaks([pending], new Set(), now), { current: 0, best: 0 });
});

test('a day with two alarms counts only when both completed on time', () => {
  const first = occurrence('2025-01-10', 'completed', { alarmId: 'one' });
  const second = occurrence('2025-01-10', 'missed', { alarmId: 'two' });
  assert.equal(dayResult([first, second]), 'missed');
  assert.equal(calculateStreaks([first, second], new Set(), Date.UTC(2025, 0, 11)).current, 0);
});

test('stored local dates remain stable across DST and travel time-zone changes', () => {
  assert.equal(dateKeyInTimeZone(Date.parse('2024-03-10T06:59:00Z'), 'America/New_York'), '2024-03-10');
  assert.equal(dateKeyInTimeZone(Date.parse('2024-03-10T07:01:00Z'), 'America/New_York'), '2024-03-10');
  assert.equal(dateKeyInTimeZone(Date.parse('2024-11-03T05:30:00Z'), 'America/New_York'), '2024-11-03');
  assert.equal(dateKeyInTimeZone(Date.parse('2024-11-03T06:30:00Z'), 'America/New_York'), '2024-11-03');
  const stored = occurrence('2024-11-03');
  const streak = calculateStreaks([stored], new Set(), Date.UTC(2024, 11, 1));
  assert.deepEqual(streak, { current: 1, best: 1 });
});

test('empty and one-to-two-point periods do not invent trend values or headlines', () => {
  const now = new Date('2025-01-10T12:00:00Z');
  const empty = derivePeriodMetrics([], 'month', now);
  assert.equal(empty.averageWakeMs, null);
  assert.deepEqual(empty.trend, []);
  assert.equal(empty.trendPercent, null);

  const one = derivePeriodMetrics([occurrence('2025-01-09')], 'month', now);
  assert.equal(one.averageWakeMs, 60_000);
  assert.equal(one.trend.length, 1);
  assert.equal(one.trendPercent, null);
});

test('local date formatting uses calendar dates rather than UTC date boundaries', () => {
  assert.equal(localDateKey(new Date(2025, 0, 1, 23, 59)), '2025-01-01');
});
