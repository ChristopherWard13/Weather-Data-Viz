/**
 * Pressure centers: grid points that are the max (H) or min (L) of the field
 * within ±radius cells, are strictly beyond all 8 neighbours (so plateaus
 * never count), and stand out from that neighbourhood by at least
 * `prominence`. Points within `radius / 2` of the domain edge are skipped,
 * since the true center may lie outside.
 */
export interface Extremum {
  i: number;
  j: number;
  value: number;
  kind: "H" | "L";
}

export function findExtrema(values: Float32Array, nx: number, ny: number, radius: number, prominence: number): Extremum[] {
  const max = windowed(values, nx, ny, radius, Math.max);
  const min = windowed(values, nx, ny, radius, Math.min);
  const edge = Math.ceil(radius / 2);
  const out: Extremum[] = [];
  for (let j = edge; j < ny - edge; j++) {
    for (let i = edge; i < nx - edge; i++) {
      const k = j * nx + i;
      const v = values[k];
      if (v === max[k] && v - min[k] >= prominence && strict(values, nx, i, j, 1)) out.push({ i, j, value: v, kind: "H" });
      else if (v === min[k] && max[k] - v >= prominence && strict(values, nx, i, j, -1)) out.push({ i, j, value: v, kind: "L" });
    }
  }
  return dedupe(out, radius);
}

function strict(values: Float32Array, nx: number, i: number, j: number, sign: 1 | -1): boolean {
  const v = values[j * nx + i];
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      if ((di || dj) && sign * values[(j + dj) * nx + i + di] >= sign * v) return false;
    }
  }
  return true;
}

/** Separable sliding-window max/min over a (2r+1)^2 square. */
function windowed(values: Float32Array, nx: number, ny: number, r: number, op: (a: number, b: number) => number): Float32Array {
  const tmp = new Float32Array(nx * ny);
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let m = values[j * nx + i];
      for (let d = Math.max(0, i - r); d <= Math.min(nx - 1, i + r); d++) m = op(m, values[j * nx + d]);
      tmp[j * nx + i] = m;
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let m = tmp[j * nx + i];
      for (let d = Math.max(0, j - r); d <= Math.min(ny - 1, j + r); d++) m = op(m, tmp[d * nx + i]);
      out[j * nx + i] = m;
    }
  }
  return out;
}

/**
 * Broad highs and lows can have several local maxima; keep only the most
 * extreme center of each kind within 2 x radius.
 */
function dedupe(items: Extremum[], radius: number): Extremum[] {
  const strength = (e: Extremum) => (e.kind === "H" ? e.value : -e.value);
  const kept: Extremum[] = [];
  for (const e of [...items].sort((a, b) => strength(b) - strength(a))) {
    const near = (k: Extremum) => k.kind === e.kind && Math.hypot(k.i - e.i, k.j - e.j) <= 2 * radius;
    if (!kept.some(near)) kept.push(e);
  }
  return kept;
}
