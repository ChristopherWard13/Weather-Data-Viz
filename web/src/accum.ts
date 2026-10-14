// Totals over a valid-time window (Phase 3.8): the 6-h frames summed over a
// window every map on screen shares, never each model's own run total, so two
// runs or two models are always compared over the same hours.
import { addHours } from "./time";
import { hoursBetween } from "./timeaxis";
import type { Bands } from "./types";

export type Period = "6h" | "24h" | "total";

export const PERIODS: { id: Period; label: string }[] = [
  { id: "6h", label: "6 h" },
  { id: "24h", label: "24 h" },
  { id: "total", label: "Total" },
];

export const isPeriod = (p: string | null | undefined): p is Period => PERIODS.some((x) => x.id === p);

/** Every precipitation and snowfall frame is a 6-hour amount, whatever the product's step. */
export const AMOUNT_HOURS = 6;

/** The hours a total covers: (from, to], where `start` is the earliest any of it may begin. */
export interface Window {
  period: Exclude<Period, "6h">;
  /** The latest first valid time among the runs shown: no total reaches before it. */
  start: Date;
  from: Date;
  to: Date;
  /** Hours summed: 24 for a full day; fewer where the day reaches before `start`. */
  hours: number;
}

/**
 * The window ending at `to`: the 24 hours before it, or everything since
 * `start` for Total. A 24-h window never reaches before `start`, so early on
 * it covers fewer hours (and says so).
 */
export function windowFor(period: Exclude<Period, "6h">, to: Date, start: Date): Window {
  const day = addHours(to, -24);
  const from = period === "24h" && day > start ? day : start;
  const hours = Math.max(0, Math.floor(hoursBetween(from, to) / AMOUNT_HOURS) * AMOUNT_HOURS);
  return { period, start, from: addHours(to, -hours), to, hours };
}

/** The forecast hours of a run (`init`) whose 6-h amounts make up the window, in order. */
export function windowHours(init: Date, w: Window): number[] {
  const out: number[] = [];
  for (let h = w.hours; h > 0; h -= AMOUNT_HOURS) out.push(hoursBetween(init, addHours(w.to, AMOUNT_HOURS - h)));
  return out;
}

/** Sum the named bands of each frame; other bands (precipitation type) can't be summed and are left out. */
export function sumBands(frames: Bands[], bands: string[]): Bands {
  const out: Bands = {};
  for (const name of bands) {
    const first = frames[0][name];
    const total = new Float32Array(first.length);
    for (const f of frames) {
      const v = f[name];
      for (let k = 0; k < total.length; k++) total[k] += v[k];
    }
    out[name] = total;
  }
  return out;
}

/** The latest of some times: where a shared window starts. */
export const latestOf = (times: Date[]): Date => new Date(Math.max(...times.map((t) => t.getTime())));
