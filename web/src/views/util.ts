import { autoLimit, computeDelta } from "../delta";
import { buildLut, type ColorFn } from "../palettes";
import { config } from "../config";
import type { ColorbarSpec } from "../colorbar";
import type { Bands, Grid } from "../types";
import type { LimitMode, RasterSpec, Row, ViewInputs } from "./types";

export function fmtLatLon(lat: number, lon: number, digits = 1): string {
  return `${Math.abs(lat).toFixed(digits)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(digits)}°${lon >= 0 ? "E" : "W"}`;
}

/** Largest (sign 1) or smallest (sign -1) value and where it is. */
export function extreme(values: Float32Array, grid: Grid, sign: 1 | -1) {
  let best = -Infinity, at = 0;
  for (let i = 0; i < values.length; i++) if (sign * values[i] > best) { best = sign * values[i]; at = i; }
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

/**
 * The trend (Δ = current − older) part of a view: diverging shading with a
 * fixed or auto symmetric limit. Returns null pieces when the older run is
 * missing, so the caller can still draw the current run's overlays.
 */
export function trend(
  inp: ViewInputs,
  field: string,
  band: string,
  viewId: string,
  color: (limit: number) => ColorFn,
  format?: (v: number) => string,
): { d: Float32Array | null; raster: RasterSpec; colorbar: ColorbarSpec; limit: number } {
  const vc = config.views[viewId];
  const cur = inp.cur[field]?.[band];
  const old = inp.old[field]?.[band];
  if (!cur || !old) {
    return { d: null, raster: null, colorbar: { kind: "disabled", color: color(vc.trendLimit), limit: vc.trendLimit }, limit: vc.trendLimit };
  }
  const d = inp.memo(`delta/${field}/${band}`, () => computeDelta(cur, old));
  const limit = limitFor(inp.limitMode, d, vc.trendLimit, vc.autoRound);
  return {
    d,
    raster: { kind: "scalar", values: d, lut: buildLut(color(limit), -limit, limit) },
    colorbar: { kind: "diverging", color: color(limit), limit, format },
    limit,
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
