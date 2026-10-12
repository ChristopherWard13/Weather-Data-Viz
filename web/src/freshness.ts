import { addHours, fmtStamp, fmtTime, parseRunId } from "./time";

/** How long past a cycle's posting time the site waits (for the job to run) before calling it late. */
export const LATE_GRACE_MIN = 90;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface Cadence {
  name: string;
  cycleHours: number;
  /** Measured minutes after init by which a whole run is posted at the source. */
  latencyMinutes: number;
}

/**
 * When the cycle after `latest` should be posted at the source. The scheduler
 * Worker starts the product's workflow by the same rule
 * (scheduler/src/freshness.ts).
 */
export function nextDue(latest: string, p: Cadence): Date {
  return new Date(addHours(parseRunId(latest), p.cycleHours).getTime() + p.latencyMinutes * 60_000);
}

export interface ChipRun {
  /** "12Z" for a run from today (UTC), "Sun 12Z" otherwise. */
  label: string;
  /** The next run is overdue, so the one shown is older than it should be. */
  late: boolean;
  title: string;
}

/** What a model chip says about its latest run at `now`. */
export function chipRun(latest: string, p: Cadence, now: Date): ChipRun {
  const init = parseRunId(latest);
  const hh = `${latest.slice(8, 10)}Z`;
  const today = init.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  const label = today ? hh : `${DAYS[init.getUTCDay()]} ${hh}`;
  const due = nextDue(latest, p);
  const late = now.getTime() - due.getTime() >= LATE_GRACE_MIN * 60_000;
  const next = addHours(init, p.cycleHours);
  const title = `${p.name}: latest run ${fmtTime(init)}` +
    (late ? `. Late: the ${fmtTime(next)} run was due by ${fmtStamp(due)} and hasn't arrived yet.` : "");
  return { label, late, title };
}
