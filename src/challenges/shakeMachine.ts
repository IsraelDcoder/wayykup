export type ShakeState = {
  count: number;
  lastShakeAt: number;
  armed: boolean;
  quietSince: number | null;
};

export function createShakeState(): ShakeState {
  return { count: 0, lastShakeAt: Number.NEGATIVE_INFINITY, armed: true, quietSince: null };
}

export function updateShakeState(
  state: ShakeState,
  acceleration: { x: number; y: number; z: number },
  now: number,
  target: number,
): ShakeState {
  const magnitude = Math.hypot(acceleration.x, acceleration.y, acceleration.z);
  const deviation = Math.abs(magnitude - 1);
  if (!Number.isFinite(deviation) || !Number.isFinite(now) || target <= 0) return state;

  if (deviation < 0.3) {
    const quietSince = state.quietSince ?? now;
    return now - quietSince >= 160 ? { ...state, armed: true, quietSince } : { ...state, quietSince };
  }
  if (deviation < 1.15 || !state.armed || now - state.lastShakeAt < 400) {
    return { ...state, quietSince: null };
  }
  return {
    count: Math.min(target, state.count + 1),
    lastShakeAt: now,
    armed: false,
    quietSince: null,
  };
}
