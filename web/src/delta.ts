/** Δ = current - older. Positive means the current run is higher (faster, warmer, wetter). */
export function computeDelta(current: ArrayLike<number>, older: ArrayLike<number>): Float32Array {
  if (current.length !== older.length) {
    throw new Error(`frame size mismatch: ${current.length} vs ${older.length}`);
  }
  const out = new Float32Array(current.length);
  for (let i = 0; i < current.length; i++) out[i] = current[i] - older[i];
  return out;
}

export function maxAbs(values: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < values.length; i++) {
    const a = Math.abs(values[i]);
    if (a > m) m = a;
  }
  return m;
}

/** Symmetric colorbar limit: max|Δ| rounded up to `round` (at least `round`). */
export function autoLimit(delta: ArrayLike<number>, round: number): number {
  const steps = Math.ceil(maxAbs(delta) / round - 1e-9);
  return Math.max(1, steps) * round;
}
