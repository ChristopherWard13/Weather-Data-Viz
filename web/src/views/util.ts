import { autoLimit, computeDelta } from "../delta";
import { buildLut, type ColorFn } from "../palettes";
import { config } from "../config";
import type { ColorbarSpec } from "../colorbar";
import type { Box } from "../config";
import type { Bands, Grid } from "../types";
import { asStored, type Quantity } from "../units";
import type { LimitMode, RasterSpec, Row, ViewInputs } from "./types";

export function fmtLatLon(lat: number, lon: number, digits = 1): string {
  return `${Math.abs(lat).toFixed(digits)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(digits)}°${lon >= 0 ? "E" : "W"}`;
}

/**
 * Largest (sign 1) or smallest (sign -1) value and where it is: inside the
 * focused region's box when there is one, otherwise anywhere on the grid.
 * `only` limits it to the points that pass (e.g. frozen precipitation).
 */
export function extreme(
  values: Float32Array, where: { grid: Grid; focus?: Box | null }, sign: 1 | -1, only?: (k: number) => boolean,
) {
  const { grid, focus } = where;
  const clamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, v));
  let [i0, i1, j0, j1] = [0, grid.nx - 1, 0, grid.ny - 1];
  if (focus) {
    const js = focus.lat.map((lat) => Math.round((lat - grid.lat0) / grid.dlat));
    const is = focus.lon.map((lon) => Math.round((lon - grid.lon0) / grid.dlon));
    [j0, j1] = [clamp(Math.min(...js), grid.ny), clamp(Math.max(...js), grid.ny)];
    [i0, i1] = [clamp(Math.min(...is), grid.nx), clamp(Math.max(...is), grid.nx)];
  }
  let best = -Infinity, at = 0;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * grid.nx + i;
      if (sign * values[k] > best && (!only || only(k))) { best = sign * values[k]; at = k; }
    }
  }
  return { v: sign * best, ...pointOf(grid, at) };
}

/** Grid index -> {k, lat, lon} of that grid point. */
export function pointOf(grid: Grid, k: number) {
  return { k, lat: grid.lat0 + Math.floor(k / grid.nx) * grid.dlat, lon: grid.lon0 + (k % grid.nx) * grid.dlon };
}

export function statRow(label: string, value: string, where: { lat: number; lon: number }, cls?: string): Row {
  return { label, value, cls, sub: fmtLatLon(where.lat, where.lon) };
}

export const signClass = (d: number) => (d > 0 ? "pos" : d < 0 ? "neg" : "");


const NICE = [0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];

/**
 * A view's fixed trend limit and auto-scale rounding, as stored values. In
 * another unit both become round numbers of that unit: ±20 kt shows as ±25 mph.
 */
export function trendLimits(viewId: string, q: Quantity = asStored("")): { fixed: number; round: number; shown: number } {
  const vc = config.views[viewId];
  if (q.scale === 1) return { fixed: vc.trendLimit, round: vc.autoRound, shown: vc.trendLimit };
  const want = vc.autoRound * q.scale;
  const round = NICE.reduce((best, n) => (Math.abs(Math.log(n / want)) < Math.abs(Math.log(best / want)) ? n : best));
  const shown = Math.max(1, Math.round((vc.trendLimit * q.scale) / round)) * round;
  return { fixed: shown / q.scale, round: round / q.scale, shown };
}

/**
 * The trend (Δ = current − older) part of a view: diverging shading with a
 * fixed or auto symmetric limit, labelled in `q`'s unit. Returns null pieces
 * when the older run is missing, so the caller can still draw the current
 * run's overlays. `shown` is the limit in `q`'s unit.
 */
export function trend(
  inp: ViewInputs,
  field: string,
  band: string,
  viewId: string,
  color: (limit: number) => ColorFn,
  q: Quantity = asStored(""),
): { d: Float32Array | null; raster: RasterSpec; colorbar: ColorbarSpec; limit: number; shown: number } {
  const lim = trendLimits(viewId, q);
  const cur = inp.cur[field]?.[band];
  const old = inp.old[field]?.[band];
  if (!cur || !old) {
    return {
      d: null, raster: null, colorbar: { kind: "disabled", color: color(lim.fixed), limit: lim.fixed, scale: q.scale },
      limit: lim.fixed, shown: lim.shown,
    };
  }
  const d = inp.memo(`delta/${field}/${band}`, () => computeDelta(cur, old));
  const limit = limitFor(inp.limitMode, d, lim.fixed, lim.round);
  const shown = Math.round(limit * q.scale * 1000) / 1000;
  return {
    d,
    raster: { kind: "scalar", values: d, lut: buildLut(color(limit), -limit, limit) },
    colorbar: { kind: "diverging", color: color(limit), limit, scale: q.scale },
    limit,
    shown,
  };
}

export function limitFor(mode: LimitMode, d: Float32Array, fixed: number, round: number): number {
  return mode === "auto" ? autoLimit(d, round) : fixed;
}

export function band(bands: Record<string, Bands | null>, field: string, name: string): Float32Array | null {
  return bands[field]?.[name] ?? null;
}

export function fmtNum(v: number | null | undefined, digits = 0, unit = ""): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${v.toFixed(digits)}${unit}`;
}

export function compass(deg: number): string {
  const pts = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return pts[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** Older-run contours: dashed violet, so they read as "the previous forecast". */
export const OLDER_STYLE = { color: "#6d28d9", width: 1.3, dash: [6, 4], labelColor: "#5b21b6" };

export function scaleNote(mode: LimitMode, limit: number, unit: string): string {
  return `${mode === "auto" ? "auto scale" : "fixed scale"}, values beyond ±${limit} ${unit} clipped`;
}
