import * as SQLite from 'expo-sqlite';
import { GRACE_MS, OCCURRENCE_WINDOW_DAYS, STREAK_FREEZE_CAP } from './constants';
import { calculateStreaks, localDateKey, shouldEarnFreeze, spendableOccurrenceDate } from './logic';
import type { Occurrence, OccurrenceInput, StreakFreeze } from './types';

type AlarmSchedule = {
  id: string;
  time: string;
  days: string[];
  enabled: boolean;
  task: string;
  mathDifficulty?: string;
  sound: string;
  shakeCount?: number;
};

type OccurrenceRow = Occurrence & {
  firstRingAt: number | null;
  completedAt: number | null;
  morningRating: number | null;
  shakesCounted: number | null;
  steps: number | null;
  mathCorrect: number | null;
  mathAttempts: number | null;
  challengeDurationMs: number | null;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let transactionQueue: Promise<void> = Promise.resolve();

function withSerializedTransaction(
  database: SQLite.SQLiteDatabase,
  operation: () => Promise<void>,
): Promise<void> {
  const transaction = transactionQueue.then(() => database.withTransactionAsync(operation));
  transactionQueue = transaction.then(
    () => undefined,
    () => undefined,
  );
  return transaction;
}

export async function getStatsDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync('wayykup-stats.db').then(async (database) => {
      await database.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS occurrences (
          id TEXT PRIMARY KEY NOT NULL,
          alarmId TEXT NOT NULL,
          localDate TEXT NOT NULL,
          tz TEXT NOT NULL,
          scheduledAt INTEGER NOT NULL,
          firstRingAt INTEGER,
          completedAt INTEGER,
          status TEXT NOT NULL CHECK (status IN ('scheduled','ringing','completed','bypassed','abandoned','missed','skipped')),
          challenge TEXT NOT NULL,
          difficulty INTEGER NOT NULL DEFAULT 1,
          tierReached TEXT NOT NULL DEFAULT 'gentle' CHECK (tierReached IN ('gentle','standard','brutal')),
          failedAttempts INTEGER NOT NULL DEFAULT 0,
          rearms INTEGER NOT NULL DEFAULT 0,
          soundId TEXT NOT NULL,
          morningRating INTEGER CHECK (morningRating BETWEEN 1 AND 5),
          shakesCounted INTEGER,
          steps INTEGER,
          mathCorrect INTEGER,
          mathAttempts INTEGER,
          challengeDurationMs INTEGER,
          UNIQUE (alarmId, localDate)
        );
        CREATE INDEX IF NOT EXISTS occurrences_localDate_idx ON occurrences(localDate);
        CREATE INDEX IF NOT EXISTS occurrences_scheduledAt_idx ON occurrences(scheduledAt);
        CREATE TABLE IF NOT EXISTS streak_freezes (
          id TEXT PRIMARY KEY NOT NULL,
          earnedAt INTEGER NOT NULL,
          usedLocalDate TEXT,
          usedAt INTEGER
        );
        DELETE FROM occurrences WHERE id LIKE 'demo:%' AND alarmId = 'demo-alarm';
      `);
      return database;
    }).catch((error: unknown) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

function challengeForTask(task: string): OccurrenceInput['challenge'] {
  if (task === 'Math') return 'math';
  if (task === 'Shake') return 'shake';
  if (task === 'QR scan') return 'qr';
  if (task === 'Memory') return 'memory';
  if (task === 'Object Hunt') return 'object_hunt';
  if (task === 'Toothbrush') return 'toothbrush';
  return 'exercise';
}

function tierForAttempts(failedAttempts: number, rearms = 0): Occurrence['tierReached'] {
  const effort = failedAttempts + rearms;
  return effort >= 3 ? 'brutal' : effort > 0 ? 'standard' : 'gentle';
}

function toOccurrence(row: OccurrenceRow): Occurrence {
  return row;
}

function formatLocalDate(date: Date): string {
  return localDateKey(date);
}

function makeOccurrence(alarm: AlarmSchedule, date: Date, tz: string): OccurrenceInput {
  const [hour, minute] = alarm.time.split(':').map(Number);
  const scheduledDate = new Date(date);
  scheduledDate.setHours(hour, minute, 0, 0);
  const localDate = formatLocalDate(scheduledDate);
  return {
    id: `${alarm.id}:${localDate}`,
    alarmId: alarm.id,
    localDate,
    tz,
    scheduledAt: scheduledDate.getTime(),
    status: 'scheduled',
    challenge: challengeForTask(alarm.task),
    difficulty: alarm.task === 'Math'
      ? alarm.mathDifficulty === 'Hard' ? 3 : alarm.mathDifficulty === 'Easy' ? 1 : 2
      : alarm.task === 'Shake' ? Math.round((alarm.shakeCount ?? 100) / 50) : 1,
    tierReached: 'gentle',
    failedAttempts: 0,
    rearms: 0,
    soundId: alarm.sound.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
  };
}

export async function materializeOccurrences(
  alarms: AlarmSchedule[],
  now = new Date(),
): Promise<Occurrence[]> {
  const database = await getStatsDatabase();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const desired: OccurrenceInput[] = [];

  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    const [hour, minute] = alarm.time.split(':').map(Number);
    for (let offset = 0; offset < OCCURRENCE_WINDOW_DAYS; offset += 1) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      const localDate = formatLocalDate(date);
      if (alarm.days.length > 0) {
        const mondayIndex = (date.getDay() + 6) % 7;
        if (!alarm.days.includes(String(mondayIndex))) continue;
      } else if (offset > 1) {
        continue;
      }
      const occurrence = makeOccurrence(alarm, date, tz);
      if (occurrence.scheduledAt <= now.getTime()) {
        if (offset !== 0 || alarm.days.length > 0) continue;
        const tomorrow = new Date(date);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const nextOccurrence = makeOccurrence(alarm, tomorrow, tz);
        desired.push(nextOccurrence);
        break;
      }
      desired.push(occurrence);
      if (alarm.days.length === 0) break;
    }
  }

  await withSerializedTransaction(database, async () => {
    const desiredIds = new Set(desired.map((item) => item.id));
    const scheduledRows = await database.getAllAsync<{ id: string; scheduledAt: number }>(
      "SELECT id, scheduledAt FROM occurrences WHERE status = 'scheduled' AND scheduledAt > ?",
      now.getTime(),
    );
    for (const row of scheduledRows) {
      if (!desiredIds.has(row.id)) {
        await database.runAsync(
          "UPDATE occurrences SET status = 'skipped' WHERE id = ? AND status = 'scheduled'",
          row.id,
        );
      }
    }
    for (const item of desired) {
      await database.runAsync(
        `INSERT INTO occurrences
          (id, alarmId, localDate, tz, scheduledAt, status, challenge, difficulty, tierReached,
           failedAttempts, rearms, soundId)
         VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, 'gentle', 0, 0, ?)
         ON CONFLICT(alarmId, localDate) DO UPDATE SET
           id = excluded.id, tz = excluded.tz, scheduledAt = excluded.scheduledAt,
           challenge = excluded.challenge, difficulty = excluded.difficulty, soundId = excluded.soundId,
           status = 'scheduled'
         WHERE occurrences.status IN ('scheduled', 'skipped')`,
        item.id,
        item.alarmId,
        item.localDate,
        item.tz,
        item.scheduledAt,
        item.challenge,
        item.difficulty,
        item.soundId,
      );
    }
  });
  return getOccurrences();
}

export async function getOccurrences(): Promise<Occurrence[]> {
  const database = await getStatsDatabase();
  const rows = await database.getAllAsync<OccurrenceRow>('SELECT * FROM occurrences ORDER BY localDate ASC, scheduledAt ASC');
  return rows.map(toOccurrence);
}

export async function getStreakFreezes(): Promise<StreakFreeze[]> {
  const database = await getStatsDatabase();
  return database.getAllAsync<StreakFreeze>('SELECT id, earnedAt, usedLocalDate, usedAt FROM streak_freezes ORDER BY earnedAt ASC');
}

export async function markOccurrenceRinging(occurrenceId: string, firstRingAt = Date.now()): Promise<void> {
  const database = await getStatsDatabase();
  await database.runAsync(
    `UPDATE occurrences SET status = 'ringing', firstRingAt = COALESCE(firstRingAt, ?)
     WHERE id = ? AND status IN ('scheduled', 'ringing')`,
    firstRingAt,
    occurrenceId,
  );
}

export async function recordFailedAttempt(occurrenceId: string): Promise<void> {
  const database = await getStatsDatabase();
  await database.runAsync(
    `UPDATE occurrences SET failedAttempts = failedAttempts + 1,
       tierReached = CASE WHEN failedAttempts + 1 + rearms >= 3 THEN 'brutal' ELSE 'standard' END
     WHERE id = ? AND status = 'ringing'`,
    occurrenceId,
  );
}

export async function recordRearm(occurrenceId: string): Promise<void> {
  const database = await getStatsDatabase();
  await database.runAsync(
    `UPDATE occurrences SET rearms = rearms + 1,
       tierReached = CASE WHEN failedAttempts + rearms + 1 >= 3 THEN 'brutal' ELSE 'standard' END
     WHERE id = ? AND status = 'ringing'`,
    occurrenceId,
  );
}

export async function completeOccurrence(
  occurrenceId: string,
  completedAt: number,
  details: { shakesCounted?: number; steps?: number; mathCorrect?: number; mathAttempts?: number; challengeDurationMs?: number },
): Promise<void> {
  const database = await getStatsDatabase();
  await database.runAsync(
    `UPDATE occurrences SET status = 'completed', completedAt = ?, shakesCounted = ?,
       steps = ?, mathCorrect = ?, mathAttempts = ?, challengeDurationMs = ?,
       tierReached = CASE WHEN failedAttempts + rearms >= 3 THEN 'brutal'
         WHEN failedAttempts + rearms > 0 THEN 'standard' ELSE 'gentle' END
     WHERE id = ? AND status = 'ringing'`,
    completedAt,
    details.shakesCounted ?? null,
    details.steps ?? null,
    details.mathCorrect ?? null,
    details.mathAttempts ?? null,
    details.challengeDurationMs ?? null,
    occurrenceId,
  );
}

export async function resolveOccurrence(
  occurrenceId: string,
  status: 'bypassed' | 'abandoned',
): Promise<void> {
  const database = await getStatsDatabase();
  await database.runAsync(
    'UPDATE occurrences SET status = ? WHERE id = ? AND status = ?',
    status,
    occurrenceId,
    'ringing',
  );
}

export async function reconcileOccurrences(now = Date.now()): Promise<Occurrence[]> {
  const database = await getStatsDatabase();
  await database.runAsync(
    `UPDATE occurrences SET status = CASE WHEN firstRingAt IS NULL THEN 'missed' ELSE 'abandoned' END
     WHERE status IN ('scheduled', 'ringing') AND scheduledAt + ? <= ?`,
    GRACE_MS,
    now,
  );
  return getOccurrences();
}

export async function earnFreezeForStreak(occurrenceId: string, streakBefore: number, streakAfter: number): Promise<void> {
  const database = await getStatsDatabase();
  const available = await database.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM streak_freezes WHERE usedAt IS NULL',
  );
  if (!shouldEarnFreeze(streakBefore, streakAfter, available?.count ?? 0, STREAK_FREEZE_CAP)) return;
  await database.runAsync(
    'INSERT OR IGNORE INTO streak_freezes (id, earnedAt) VALUES (?, ?)',
    `streak-${occurrenceId}`,
    Date.now(),
  );
}

export async function spendFreeze(occurrences: Occurrence[], now = Date.now()): Promise<string | null> {
  const eligibleDate = spendableOccurrenceDate(occurrences, now);
  if (!eligibleDate) return null;

  const database = await getStatsDatabase();
  const freeze = await database.getFirstAsync<{ id: string }>(
    'SELECT id FROM streak_freezes WHERE usedAt IS NULL ORDER BY earnedAt ASC LIMIT 1',
  );
  if (!freeze) return null;
  const result = await database.runAsync(
    'UPDATE streak_freezes SET usedLocalDate = ?, usedAt = ? WHERE id = ? AND usedAt IS NULL',
    eligibleDate,
    now,
    freeze.id,
  );
  return result.changes ? eligibleDate : null;
}

export function usedFreezeDates(freezes: StreakFreeze[]): Set<string> {
  return new Set(freezes.flatMap((freeze) => freeze.usedLocalDate ? [freeze.usedLocalDate] : []));
}

export async function recomputeStreak(occurrences: Occurrence[], now = Date.now()) {
  const freezes = await getStreakFreezes();
  return calculateStreaks(occurrences, usedFreezeDates(freezes), now);
}

export async function setMorningRating(occurrenceId: string, rating: 1 | 2 | 3 | 4 | 5): Promise<void> {
  const database = await getStatsDatabase();
  await database.runAsync(
    'UPDATE occurrences SET morningRating = ? WHERE id = ? AND status = ?',
    rating,
    occurrenceId,
    'completed',
  );
}
