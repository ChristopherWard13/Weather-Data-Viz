import type { Frame } from "./types";

/** Δ|V| = current - older in kt. Positive means the current run is faster. */
export function computeDelta(current: Frame, older: Frame): Int16Array {
  if (current.length !== older.length) {
    throw new Error(`frame size mismatch: ${current.length} vs ${older.length}`);
  }
  const out = new Int16Array(current.length);
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

/** Symmetric colorbar limit: max|Δ| rounded up to `round` kt (at least `round`). */
export function autoLimit(delta: ArrayLike<number>, round: number): number {
  return Math.max(round, Math.ceil(maxAbs(delta) / round) * round);
}
