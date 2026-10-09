import type { Lookup } from "./projection";
import { LUT_SIZE } from "./colormap";

const OUTSIDE: [number, number, number, number] = [0, 0, 0, 0];

/**
 * Shade Δ into `out` (RGBA, lookup.width x lookup.height) by bilinear sampling
 * of the native grid, then indexing the colormap LUT with symmetric clipping.
 */
export function shadeDelta(
  out: Uint8ClampedArray,
  lookup: Lookup,
  delta: Int16Array,
  nx: number,
  limit: number,
  lut: Uint8ClampedArray,
): void {
  const { index, fx, fy } = lookup;
  const scale = (LUT_SIZE - 1) / (2 * limit);
  for (let k = 0, o = 0; k < index.length; k++, o += 4) {
    const i = index[k];
    if (i < 0) {
      out[o] = OUTSIDE[0]; out[o + 1] = OUTSIDE[1]; out[o + 2] = OUTSIDE[2]; out[o + 3] = OUTSIDE[3];
      continue;
    }
    const wx = fx[k], wy = fy[k];
    const top = delta[i] + (delta[i + 1] - delta[i]) * wx;
    const bot = delta[i + nx] + (delta[i + nx + 1] - delta[i + nx]) * wx;
    const v = top + (bot - top) * wy;
    let c = Math.round((v + limit) * scale);
    c = c < 0 ? 0 : c > LUT_SIZE - 1 ? LUT_SIZE - 1 : c;
    const l = c * 4;
    out[o] = lut[l]; out[o + 1] = lut[l + 1]; out[o + 2] = lut[l + 2]; out[o + 3] = 255;
  }
}

/** Fill the domain with a flat color (used when the comparison is unavailable). */
export function shadeFlat(out: Uint8ClampedArray, lookup: Lookup, rgba: [number, number, number, number]): void {
  const { index } = lookup;
  for (let k = 0, o = 0; k < index.length; k++, o += 4) {
    const c = index[k] < 0 ? OUTSIDE : rgba;
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = c[3];
  }
}
