import { HUNT_ITEMS } from './objects';

export type ChallengeType = 'yell_to_stop' | 'push_up' | 'shake_phone' | 'object_hunt';
export type ChallengeTask = 'Yell to Stop' | 'Push-up Challenge' | 'Shake Your Phone' | 'Object Hunt';
export type ObjectHuntDifficulty = 'easy' | 'medium' | 'hard';

export type ChallengeConfiguration =
  | { type: 'yell_to_stop'; phrase: string; requiredCompletions: 1 }
  | { type: 'push_up'; targetCount: 5 | 10 | 15 | 20 }
  | { type: 'shake_phone'; targetCount: 10 | 25 | 50 | 100 | 200 }
  | { type: 'object_hunt'; difficulty: ObjectHuntDifficulty; targetObject: string };

export const CHALLENGE_OPTIONS: {
  type: ChallengeType;
  task: ChallengeTask;
  title: string;
  description: string;
  difficulty: 'Easy' | 'Easy–Medium' | 'Medium';
  duration: string;
  icon: string;
}[] = [
  {
    type: 'yell_to_stop',
    task: 'Yell to Stop',
    title: 'YELL TO STOP',
    description: 'Say your selected phrase aloud to stop the alarm.',
    difficulty: 'Easy',
    duration: '5–15 sec',
    icon: '◉',
  },
  {
    type: 'push_up',
    task: 'Push-up Challenge',
    title: 'PUSH-UP CHALLENGE',
    description: 'Complete valid push-ups detected by the camera.',
    difficulty: 'Medium',
    duration: '15–60 sec',
    icon: '↗',
  },
  {
    type: 'shake_phone',
    task: 'Shake Your Phone',
    title: 'SHAKE YOUR PHONE',
    description: 'Shake your phone the configured number of times.',
    difficulty: 'Easy–Medium',
    duration: '10–30 sec',
    icon: '↯',
  },
  {
    type: 'object_hunt',
    task: 'Object Hunt',
    title: 'OBJECT HUNT',
    description: 'Find and scan the selected everyday object.',
    difficulty: 'Medium',
    duration: '15–60 sec',
    icon: '⌕',
  },
];

export function challengeTypeForTask(task: ChallengeTask | null): ChallengeType | null {
  return CHALLENGE_OPTIONS.find((option) => option.task === task)?.type ?? null;
}

export function taskForChallengeType(type: ChallengeType): ChallengeTask {
  return CHALLENGE_OPTIONS.find((option) => option.type === type)!.task;
}

export function defaultChallengeConfiguration(type: ChallengeType): ChallengeConfiguration {
  switch (type) {
    case 'yell_to_stop':
      return { type, phrase: "I'M AWAKE!", requiredCompletions: 1 };
    case 'push_up':
      return { type, targetCount: 10 };
    case 'shake_phone':
      return { type, targetCount: 25 };
    case 'object_hunt':
      return { type, difficulty: 'easy', targetObject: 'Toothbrush' };
  }
}

export function isChallengeConfiguration(value: unknown): value is ChallengeConfiguration {
  if (typeof value !== 'object' || value === null) return false;
  const config = value as Record<string, unknown>;
  switch (config.type) {
    case 'yell_to_stop':
      return typeof config.phrase === 'string'
        && ["I'M AWAKE!", 'GOOD MORNING!', "I'M UP!", 'WAKE UP!'].includes(config.phrase)
        && config.requiredCompletions === 1;
    case 'push_up':
      return [5, 10, 15, 20].includes(Number(config.targetCount));
    case 'shake_phone':
      return [10, 25, 50, 100, 200].includes(Number(config.targetCount));
    case 'object_hunt':
      return ['easy', 'medium', 'hard'].includes(String(config.difficulty))
        && typeof config.targetObject === 'string'
        && HUNT_ITEMS.some((item) => item.name === config.targetObject);
    default:
      return false;
  }
}
