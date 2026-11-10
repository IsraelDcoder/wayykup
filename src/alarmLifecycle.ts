export type AlarmLifecycleState =
  | 'scheduled'
  | 'ringing'
  | 'challenge_pending'
  | 'challenge_active'
  | 'challenge_completed'
  | 'dismissed';

const transitions: Record<AlarmLifecycleState, readonly AlarmLifecycleState[]> = {
  scheduled: ['ringing'],
  ringing: ['challenge_pending'],
  challenge_pending: ['challenge_active'],
  challenge_active: ['challenge_completed'],
  challenge_completed: ['dismissed'],
  dismissed: [],
};

export function transitionAlarmState(
  current: AlarmLifecycleState,
  next: AlarmLifecycleState,
): AlarmLifecycleState {
  if (!transitions[current].includes(next)) {
    throw new Error(`Invalid alarm lifecycle transition: ${current} -> ${next}.`);
  }
  return next;
}
