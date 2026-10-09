import { interpolateBrBG, interpolateRdBu } from "d3-scale-chromatic";

export type Stops = [number, string][];
export type ColorFn = (v: number) => string;

function hex(c: string): [number, number, number] {
  const m = c.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  const r = c.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (r) return [+r[1], +r[2], +r[3]];
  throw new Error(`unparseable color ${c}`);
}

const toCss = ([r, g, b]: number[]) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;

/** Piecewise-linear RGB interpolation through value stops, clamped at the ends. */
export function stopsColor(stops: Stops): ColorFn {
  const rgb = stops.map(([v, c]) => [v, hex(c)] as const);
  return (v) => {
    if (v <= rgb[0][0]) return toCss(rgb[0][1]);
    for (let i = 1; i < rgb.length; i++) {
      const [v1, c1] = rgb[i];
      if (v <= v1) {
        const [v0, c0] = rgb[i - 1];
        const t = v1 === v0 ? 1 : (v - v0) / (v1 - v0);
        return toCss(c0.map((x, k) => x + (c1[k] - x) * t));
      }
    }
    return toCss(rgb[rgb.length - 1][1]);
  };
}

/** A lookup table of `n` RGBA entries covering [min, max]. */
export interface Lut {
  rgba: Uint8ClampedArray;
  min: number;
  max: number;
  n: number;
}

export function buildLut(color: ColorFn, min: number, max: number, n = 512): Lut {
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = hex(color(min + ((max - min) * i) / (n - 1)));
    rgba.set([r, g, b, 255], i * 4);
  }
  return { rgba, min, max, n };
}

export function lutIndex(lut: Lut, v: number): number {
  const i = Math.round(((v - lut.min) / (lut.max - lut.min)) * (lut.n - 1));
  return i < 0 ? 0 : i > lut.n - 1 ? lut.n - 1 : i;
}

// ---------------------------------------------------------------- diverging

/** RdBu reversed: blue below 0 (slower / colder), red above (faster / warmer). */
export const redBlue = (limit: number): ColorFn => (v) =>
  interpolateRdBu(1 - Math.min(1, Math.max(0, (v + limit) / (2 * limit))));

/** BrBG: brown below 0 (drier), blue-green above (wetter). */
export const brownGreen = (limit: number): ColorFn => (v) =>
  interpolateBrBG(Math.min(1, Math.max(0, (v + limit) / (2 * limit))));

// ---------------------------------------------------------------- sequential

/** 2 m temperature (°F); a sharp blue -> green step marks freezing. */
export const TEMP_F: Stops = [
  [-40, "#fde7ff"], [-30, "#e5b5f2"], [-20, "#c47ee0"], [-10, "#9a4fcf"], [0, "#6a39b8"],
  [10, "#3d3fb0"], [20, "#2a6fd6"], [31.99, "#62b9ec"], [32, "#93d9a8"], [40, "#b9e48b"],
  [50, "#e3ec7c"], [60, "#fbdf69"], [70, "#f9b44f"], [80, "#f0823c"], [90, "#db4b30"],
  [100, "#b52032"], [110, "#821540"], [120, "#5a0e3d"],
];

/** 2 m dew point (°F): dry browns -> moist greens -> tropical blues/purples. */
export const DEWPT_F: Stops = [
  [-20, "#7a5a3a"], [0, "#9c7b55"], [20, "#c4ab80"], [30, "#e2d6b8"], [40, "#d3ebbf"],
  [50, "#9fd69a"], [55, "#62c06f"], [60, "#2f9e55"], [65, "#1b7a4a"], [70, "#13605a"],
  [75, "#2a5aa8"], [80, "#5a3fb0"],
];

/** Surface wind and gust (kt). */
export const WIND_KT: Stops = [
  [0, "#ffffff"], [5, "#e8f3fb"], [10, "#c0def4"], [15, "#86c0ea"], [20, "#4f9fdc"],
  [25, "#3db381"], [30, "#8fcb40"], [35, "#f2d23a"], [40, "#f6a531"], [50, "#ea5f2a"],
  [60, "#c9254a"], [70, "#9b1b78"], [80, "#6b1fa3"],
];

/** 250 mb wind speed (kt); near-white below 50 kt so the jets stand out. */
export const JET_KT: Stops = [
  [0, "#ffffff"], [50, "#f1f5fb"], [60, "#d5e6f7"], [70, "#a9cdef"], [90, "#5fa3e0"],
  [110, "#3cb37a"], [130, "#b9d63f"], [150, "#f5c43a"], [170, "#ee7f31"], [190, "#d93a3a"],
  [210, "#a3226e"], [230, "#6b1fa3"],
];

// ---------------------------------------------------------------- precipitation

/** Lower edges (inches) of the 6-h precipitation bins. */
export const QPF_BINS = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3];

export const PTYPE_LABELS = ["None", "Rain", "Snow", "Sleet", "Freezing rain"];

/** Per type code (1 rain, 2 snow, 3 sleet, 4 freezing rain): one color per bin. */
export const PTYPE_COLORS: Record<number, string[]> = {
  1: ["#c6ecb4", "#92d88a", "#5ec165", "#2e9e48", "#157a37", "#f4e14b", "#f6b33c", "#ec7a2e", "#d73a2a", "#9e1b46"],
  2: ["#dbe8ff", "#b3cdfb", "#86aef3", "#5b8de6", "#3a6cd4", "#2850b5", "#1d3893", "#5a3fb0", "#8a5cc8", "#c49ae6"],
  3: ["#ffe6c7", "#fccd95", "#f7ad62", "#ef8d38", "#db6d1f", "#b85314", "#8f3d0d", "#6b2b08", "#4d1f06", "#2e1204"],
  4: ["#ffd9ec", "#ffb3d6", "#fb86bd", "#f05aa1", "#d93c88", "#b52a71", "#8f1d5a", "#6b1444", "#4d0e31", "#2e081d"],
};

export function qpfBin(v: number): number {
  let b = -1;
  for (let i = 0; i < QPF_BINS.length; i++) if (v >= QPF_BINS[i]) b = i;
  return b;
}

export function rgbaOf(css: string): [number, number, number, number] {
  const [r, g, b] = hex(css);
  return [r, g, b, 255];
}

/**
 * Tick step for a ±limit colorbar. It always divides the limit, so ticks land
 * on 0 and on both ends; labels are thinned separately when space is short.
 */
export function tickStep(limit: number): number {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10, 15, 20, 25, 50, 100];
  const divides = (s: number) => Math.abs(limit / s - Math.round(limit / s)) < 1e-9;
  for (const maxTicks of [14, 30]) {
    for (const s of steps) if (divides(s) && (2 * limit) / s <= maxTicks) return s;
  }
  return limit;
}
