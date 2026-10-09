// Valid-time alignment; mirrors pipeline/src/wxtrend/alignment.py and is
// checked against the same shared test vectors.
import { addHours, runId } from "./time";

export interface FramePair {
  valid: Date;
  currentInit: Date;
  currentFhr: number;
  olderInit: Date;
  olderFhr: number;
  currentRun: string;
  olderRun: string;
}

export function validTime(init: Date, fhr: number): Date {
  return addHours(init, fhr);
}

/** Current (T0, f) is compared with the run from T0 - L at hour f + L. */
export function pairFor(init: Date, fhr: number, lag: number): FramePair {
  if (!(lag > 0)) throw new Error("lag must be positive");
  if (fhr < 0) throw new Error("forecast hour must be non-negative");
  const olderInit = addHours(init, -lag);
  const olderFhr = fhr + lag;
  return {
    valid: validTime(init, fhr),
    currentInit: init,
    currentFhr: fhr,
    olderInit,
    olderFhr,
    currentRun: runId(init),
    olderRun: runId(olderInit),
  };
}
