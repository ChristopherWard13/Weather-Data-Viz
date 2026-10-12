// One valid-time axis for every model (Q13): the scrubber spans the latest
// runs of all of them, so switching model at a valid time never moves it.
import { addHours, startOfDay, type Zone } from "./time";

const HOUR = 3600_000;

/** A span of valid times, ends included. */
export interface Span {
  start: Date;
  end: Date;
}

export interface Axis extends Span {
  /** Hours between positions. */
  step: number;
}

export const hoursBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / HOUR);

/** The valid times a run covers: its init plus its first and last displayed hour. */
export function coverage(init: Date, hours: { min: number; max: number }): Span {
  return { start: addHours(init, hours.min), end: addHours(init, hours.max) };
}

/** From the earliest start to the latest end of the runs given. */
export function axisOf(spans: Span[], step: number): Axis {
  if (!spans.length) throw new Error("an axis needs at least one run");
  const start = Math.min(...spans.map((s) => s.start.getTime()));
  const end = Math.max(...spans.map((s) => s.end.getTime()));
  return { start: new Date(start), end: new Date(end), step };
}

/** The axis position at or after `t` (`dir` 1) or at or before it (`dir` -1). */
export function snap(axis: Axis, t: Date, dir: 1 | -1): Date {
  const h = (t.getTime() - axis.start.getTime()) / HOUR / axis.step;
  return addHours(axis.start, (dir > 0 ? Math.ceil(h - 1e-9) : Math.floor(h + 1e-9)) * axis.step);
}

/** `span` clipped to the axis and snapped inward to its positions, or null if nothing is left. */
export function clip(axis: Axis, span: Span): Span | null {
  const start = snap(axis, new Date(Math.max(span.start.getTime(), axis.start.getTime())), 1);
  const end = snap(axis, new Date(Math.min(span.end.getTime(), axis.end.getTime())), -1);
  return start <= end ? { start, end } : null;
}

/** Days 1 to `days` in the zone: from today's midnight to `days` midnights later, on the axis. */
export function daysWindow(axis: Axis, now: Date, zone: Zone, days: number): Span | null {
  const start = startOfDay(now, zone);
  // Midnight `days` later, found by stepping past each day (DST days aren't 24 h)
  let end = start;
  for (let i = 0; i < days; i++) end = startOfDay(addHours(end, 26), zone);
  return clip(axis, { start, end });
}

/** Midnights in the zone from `span.start` to `span.end`. */
export function dayTicks(span: Span, zone: Zone): Date[] {
  const out: Date[] = [];
  let t = startOfDay(span.start, zone);
  if (t < span.start) t = startOfDay(addHours(t, 26), zone);
  while (t <= span.end) {
    out.push(t);
    t = startOfDay(addHours(t, 26), zone);
  }
  return out;
}

export function contains(span: Span, t: Date): boolean {
  return t >= span.start && t <= span.end;
}
