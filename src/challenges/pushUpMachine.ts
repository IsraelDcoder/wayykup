export type PoseLandmark = {
  x: number;
  y: number;
  confidence: number;
};

export type PushUpPose = Partial<Record<
  'leftShoulder' | 'leftElbow' | 'leftWrist' | 'leftHip' | 'leftAnkle'
  | 'rightShoulder' | 'rightElbow' | 'rightWrist' | 'rightHip' | 'rightAnkle',
  PoseLandmark
>>;

export type PushUpState = {
  count: number;
  phase: 'awaiting_descent' | 'lowered';
  lastRepAt: number;
};

export function createPushUpState(): PushUpState {
  return { count: 0, phase: 'awaiting_descent', lastRepAt: 0 };
}

function distanceToLine(point: PoseLandmark, start: PoseLandmark, end: PoseLandmark): number {
  const lineX = end.x - start.x;
  const lineY = end.y - start.y;
  const length = Math.hypot(lineX, lineY);
  if (length < 0.08) return Number.POSITIVE_INFINITY;
  return Math.abs(lineY * point.x - lineX * point.y + end.x * start.y - end.y * start.x) / length;
}

function jointAngle(first: PoseLandmark, joint: PoseLandmark, last: PoseLandmark): number {
  const firstVector = { x: first.x - joint.x, y: first.y - joint.y };
  const lastVector = { x: last.x - joint.x, y: last.y - joint.y };
  const denominator = Math.hypot(firstVector.x, firstVector.y) * Math.hypot(lastVector.x, lastVector.y);
  if (denominator < 0.001) return 0;
  const cosine = Math.max(-1, Math.min(1, (firstVector.x * lastVector.x + firstVector.y * lastVector.y) / denominator));
  return Math.acos(cosine) * (180 / Math.PI);
}

function validSide(pose: PushUpPose, side: 'left' | 'right') {
  const shoulder = pose[`${side}Shoulder`];
  const elbow = pose[`${side}Elbow`];
  const wrist = pose[`${side}Wrist`];
  const hip = pose[`${side}Hip`];
  const ankle = pose[`${side}Ankle`];
  const points = [shoulder, elbow, wrist, hip, ankle];
  if (points.some((point) => !point || point.confidence < 0.45)) return null;
  const [visibleShoulder, visibleElbow, visibleWrist, visibleHip, visibleAnkle] = points as PoseLandmark[];
  const alignment = distanceToLine(visibleHip, visibleShoulder, visibleAnkle);
  if (alignment > 0.16) return null;
  const angle = jointAngle(visibleShoulder, visibleElbow, visibleWrist);
  if (angle < 35 || angle > 180) return null;
  return { angle, confidence: points.reduce((score, point) => score + (point?.confidence ?? 0), 0) };
}

export function updatePushUpState(
  state: PushUpState,
  pose: PushUpPose | null,
  now: number,
): PushUpState {
  const resetIncompleteRep = () => state.phase === 'lowered'
    ? { ...state, phase: 'awaiting_descent' as const }
    : state;
  if (!pose) return resetIncompleteRep();
  const side = [validSide(pose, 'left'), validSide(pose, 'right')]
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((first, second) => second.confidence - first.confidence)[0];
  if (!side) return resetIncompleteRep();

  if (state.phase === 'awaiting_descent' && side.angle <= 100) {
    return { ...state, phase: 'lowered' };
  }
  if (state.phase === 'lowered' && side.angle >= 150) {
    if (now - state.lastRepAt < 900) return { ...state, phase: 'awaiting_descent' };
    return { count: state.count + 1, phase: 'awaiting_descent', lastRepAt: now };
  }
  return state;
}
