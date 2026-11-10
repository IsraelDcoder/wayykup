import {
  CHALLENGE_OPTIONS,
  defaultChallengeConfiguration,
  isChallengeConfiguration,
  type ChallengeConfiguration,
  type ChallengeTask,
} from './challenges/registry';
import { huntTargetsForDifficulty } from './challenges/objects';
import {
  isAlarmSoundId,
  migrateAlarmSoundId,
  type AlarmSoundId,
} from './alarmSoundIds';

export type AlarmRecord = {
  id: string;
  time: string;
  task: ChallengeTask | null;
  challengeConfig?: ChallengeConfiguration;
  days: string[];
  sound: AlarmSoundId;
  enabled: boolean;
  savage: boolean;
  label?: string;
  [key: string]: unknown;
};

const DAYS = ['0', '1', '2', '3', '4', '5', '6'];
const LEGACY_TASK_MIGRATIONS: Record<string, ChallengeTask | null> = {
  'Yell to Wake': 'Yell to Stop',
  'Push-ups': 'Push-up Challenge',
  Shake: 'Shake Your Phone',
  'Object Hunt': 'Object Hunt',
};
const LEGACY_CHALLENGE_FIELDS = [
  'mathDifficulty',
  'shakeCount',
  'yellMode',
  'fallbackTask',
  'pushUpCount',
  'qrCode',
  'huntItems',
  'huntTarget',
  'objectDifficulty',
  'challengeConfig',
] as const;

function isAlarmBase(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.time === 'string'
    && Array.isArray(record.days)
    && record.days.every((day) => typeof day === 'string' && DAYS.includes(day))
    && typeof record.sound === 'string'
    && typeof record.enabled === 'boolean'
    && typeof record.savage === 'boolean';
}

function configurationForStoredAlarm(
  task: ChallengeTask,
  record: Record<string, unknown>,
): ChallengeConfiguration {
  const saved = record.challengeConfig;
  const expectedType = CHALLENGE_OPTIONS.find((option) => option.task === task)?.type;
  if (isChallengeConfiguration(saved) && saved.type === expectedType) return saved;

  switch (task) {
    case 'Yell to Stop':
      return defaultChallengeConfiguration('yell_to_stop');
    case 'Push-up Challenge': {
      const count = Number(record.pushUpCount);
      return {
        type: 'push_up',
        targetCount: [5, 10, 15, 20].includes(count) ? count as 5 | 10 | 15 | 20 : 10,
      };
    }
    case 'Shake Your Phone': {
      const count = Number(record.shakeCount);
      return {
        type: 'shake_phone',
        targetCount: [10, 25, 50, 100, 200].includes(count) ? count as 10 | 25 | 50 | 100 | 200 : 25,
      };
    }
    case 'Object Hunt': {
      const difficulty = record.objectDifficulty;
      const selectedDifficulty = difficulty === 'medium' || difficulty === 'hard' ? difficulty : 'easy';
      const savedTarget = typeof record.huntTarget === 'string'
        ? record.huntTarget
        : undefined;
      const availableTargets = huntTargetsForDifficulty(selectedDifficulty);
      return {
        type: 'object_hunt',
        difficulty: selectedDifficulty,
        targetObject: savedTarget && availableTargets.includes(savedTarget)
          ? savedTarget
          : availableTargets[0] ?? 'Toothbrush',
      };
    }
  }
}

export function migrateStoredAlarm(value: unknown): AlarmRecord | null {
  if (!isAlarmBase(value)) return null;
  const storedTask = typeof value.task === 'string' ? value.task : '';
  const currentTask = CHALLENGE_OPTIONS.some((option) => option.task === storedTask)
    ? storedTask as ChallengeTask
    : LEGACY_TASK_MIGRATIONS[storedTask] ?? null;
  const result: Record<string, unknown> = { ...value, task: currentTask };
  result.sound = migrateAlarmSoundId(value.sound as string);
  delete result.customSoundUri;
  delete result.customSoundName;

  for (const field of LEGACY_CHALLENGE_FIELDS) delete result[field];

  if (currentTask) {
    result.challengeConfig = configurationForStoredAlarm(currentTask, value);
  } else {
    delete result.challengeConfig;
  }

  return result as AlarmRecord;
}

export function isAlarmRecord(value: unknown): value is AlarmRecord {
  if (!isAlarmBase(value)) return false;
  const record = value as Record<string, unknown>;
  if (!isAlarmSoundId(record.sound)) return false;
  if (record.task === null) return record.challengeConfig === undefined;
  const challenge = CHALLENGE_OPTIONS.find((option) => option.task === record.task);
  const config = record.challengeConfig;
  return challenge !== undefined
    && isChallengeConfiguration(config)
    && config.type === challenge.type;
}
