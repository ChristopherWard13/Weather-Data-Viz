import { interpolateRdBu } from "d3-scale-chromatic";

export const LUT_SIZE = 256;

/**
 * RdBu reversed: index 0 = most negative (blue, slower), LUT_SIZE-1 = most
 * positive (red, faster), white in the middle. Packed as RGBA bytes.
 */
export function buildLut(): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    const [r, g, b] = parseRgb(interpolateRdBu(1 - t));
    lut.set([r, g, b, 255], i * 4);
  }
  return lut;
}

/** Map Δ to a LUT index with symmetric clipping at ±limit. */
export function lutIndex(delta: number, limit: number): number {
  const t = (delta + limit) / (2 * limit);
  const i = Math.round(t * (LUT_SIZE - 1));
  return i < 0 ? 0 : i > LUT_SIZE - 1 ? LUT_SIZE - 1 : i;
}

export function colorFor(delta: number, limit: number): string {
  const t = Math.min(1, Math.max(0, (delta + limit) / (2 * limit)));
  return interpolateRdBu(1 - t);
}

function parseRgb(css: string): [number, number, number] {
  const m = css.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (m) return [+m[1], +m[2], +m[3]];
  const h = css.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (h) return [parseInt(h[1], 16), parseInt(h[2], 16), parseInt(h[3], 16)];
  throw new Error(`unparseable color ${css}`);
}

/**
 * Tick step for a ±limit colorbar. It always divides the limit, so ticks land
 * on 0 and on both ends; labels are thinned separately when space is short.
 */
export function tickStep(limit: number): number {
  for (const s of [5, 10, 20, 25, 50, 100]) {
    if (limit % s === 0 && (2 * limit) / s <= 14) return s;
  }
  for (const s of [10, 5, 1]) if (limit % s === 0) return s;
  return limit;
}
