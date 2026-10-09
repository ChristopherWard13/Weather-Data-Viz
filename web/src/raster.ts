import type { Lookup } from "./projection";
import { type Lut, PTYPE_COLORS, QPF_BINS, rgbaOf } from "./palettes";

const OUTSIDE: [number, number, number, number] = [0, 0, 0, 0];

/** Bilinear sample of a native-grid field at lookup pixel k. */
function sample(values: Float32Array, lookup: Lookup, k: number, nx: number): number {
  const i = lookup.index[k];
  const wx = lookup.fx[k], wy = lookup.fy[k];
  const top = values[i] + (values[i + 1] - values[i]) * wx;
  const bot = values[i + nx] + (values[i + nx + 1] - values[i + nx]) * wx;
  return top + (bot - top) * wy;
}

/**
 * Category at lookup pixel k: the nearest grid point's, or, if that one is
 * "none" (0), the wettest of the four surrounding points that has a category.
 * Categories are never interpolated.
 */
function category(cat: Float32Array, amount: Float32Array, lookup: Lookup, k: number, nx: number): number {
  const i = lookup.index[k];
  const near = i + (lookup.fx[k] >= 0.5 ? 1 : 0) + (lookup.fy[k] >= 0.5 ? nx : 0);
  if (cat[near] > 0) return Math.round(cat[near]);
  let best = 0, wettest = -1;
  for (const c of [i, i + 1, i + nx, i + nx + 1]) {
    if (cat[c] > 0 && amount[c] > wettest) {
      wettest = amount[c];
      best = Math.round(cat[c]);
    }
  }
  return best;
}

/** Shade a continuous field: bilinear sampling, then the LUT (clamped at its ends). */
export function shadeScalar(out: Uint8ClampedArray, lookup: Lookup, values: Float32Array, nx: number, lut: Lut): void {
  const { index } = lookup;
  const scale = (lut.n - 1) / (lut.max - lut.min);
  const top = lut.n - 1;
  for (let k = 0, o = 0; k < index.length; k++, o += 4) {
    if (index[k] < 0) {
      out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
      continue;
    }
    let c = Math.round((sample(values, lookup, k, nx) - lut.min) * scale);
    c = c < 0 ? 0 : c > top ? top : c;
    const l = c * 4;
    out[o] = lut.rgba[l]; out[o + 1] = lut.rgba[l + 1]; out[o + 2] = lut.rgba[l + 2]; out[o + 3] = 255;
  }
}

const PRECIP_RGBA: Record<number, [number, number, number, number][]> = Object.fromEntries(
  Object.entries(PTYPE_COLORS).map(([t, cs]) => [t, cs.map(rgbaOf)]),
);

/**
 * Shade 6-h precipitation by type: the amount is sampled bilinearly and
 * binned; the type (a category) is taken from the nearest grid point. Dry
 * pixels get `dry`.
 */
export function shadePrecip(
  out: Uint8ClampedArray, lookup: Lookup, qpf: Float32Array, ptype: Float32Array, nx: number,
  dry: [number, number, number, number],
): void {
  const { index } = lookup;
  for (let k = 0, o = 0; k < index.length; k++, o += 4) {
    let c = OUTSIDE;
    if (index[k] >= 0) {
      c = dry;
      const v = sample(qpf, lookup, k, nx);
      if (v >= QPF_BINS[0]) {
        let b = 0;
        while (b + 1 < QPF_BINS.length && v >= QPF_BINS[b + 1]) b++;
        const t = category(ptype, qpf, lookup, k, nx);
        c = PRECIP_RGBA[t in PRECIP_RGBA ? t : 1][b];
      }
    }
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = c[3];
  }
}

/** Fill the domain with a flat color (used when nothing can be shaded). */
export function shadeFlat(out: Uint8ClampedArray, lookup: Lookup, rgba: [number, number, number, number]): void {
  const { index } = lookup;
  for (let k = 0, o = 0; k < index.length; k++, o += 4) {
    const c = index[k] < 0 ? OUTSIDE : rgba;
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = c[3];
  }
}
