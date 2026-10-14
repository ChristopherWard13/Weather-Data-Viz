// Where a map's frames come from: which product, run and hour, for each side
// of a view. Shared by the site's maps and presentation mode's slots.
import { AMOUNT_HOURS, latestOf, sumBands, windowFor, windowHours, type Window } from "./accum";
import type { ProductConfig } from "./config";
import { FrameUnavailable, type FrameCache } from "./frames";
import type { FramePair } from "./alignment";
import type { CompareRun, ViewState } from "./state";
import { addHours, fhrLabel, fmtTime, parseRunId, runId } from "./time";
import { viewById } from "./views";
import type { FieldNeeds, Mode } from "./views/types";
import type { Bands, Manifest } from "./types";

/** A product with its manifest and frame cache, loaded once per page. */
export interface Product {
  cfg: ProductConfig;
  manifest: Manifest;
  frames: FrameCache;
}

/** A run and hour of some product: where a map's frames come from. */
export interface Source {
  product: Product;
  run: string;
  fhr: number;
}

export const cycleLabel = (run: string) => `${run.slice(8, 10)}Z`;

/** The product's displayed hours, from its manifest. */
export function hoursOf(p: Product): { min: number; max: number; step: number } {
  const h = p.manifest.display_hours;
  return { min: h[0], max: h[h.length - 1], step: p.cfg.fhr.step };
}

/** Is `f` one of the product's displayed hours? */
export function hasHour(p: Product, f: number): boolean {
  const { min, max, step } = hoursOf(p);
  return f >= min && f <= max && (f - min) % step === 0;
}

/**
 * The run of `p` to show at a valid time: its newest run that starts at or
 * before it and reaches it, or null.
 */
export function sourceAt(p: Product, valid: Date): Source | null {
  for (const r of p.manifest.runs) {
    const f = Math.round((valid.getTime() - parseRunId(r.id).getTime()) / 3600e3);
    if (hasHour(p, f)) return { product: p, run: r.id, fhr: f };
  }
  return null;
}

/**
 * The compared model's run for this frame, by the compare-run choice: its
 * newest run that reaches the valid time, the current run's cycle, or a
 * picked run. `why` says why there's none.
 */
export function compareSource(p: Product, pair: FramePair, choice: CompareRun): { src: Source | null; why: string } {
  if (choice === "latest") return { src: sourceAt(p, pair.valid), why: "no run reaches it" };
  const id = choice === "same" ? pair.currentRun : choice;
  const init = parseRunId(id);
  if (!p.manifest.runs.some((r) => r.id === id)) {
    const why = init.getUTCHours() % p.cfg.cycleHours
      ? `it has no ${cycleLabel(id)} run`
      : `its ${fmtTime(init)} run isn't available`;
    return { src: null, why };
  }
  const f = Math.round((pair.valid.getTime() - init.getTime()) / 3600e3);
  if (hasHour(p, f)) return { src: { product: p, run: id, fhr: f }, why: "" };
  return { src: null, why: `its ${fmtTime(init)} run doesn't reach it` };
}

/** The mode a view draws in: compare is the forecast side by side, or a trend-style difference. */
export function viewModeOf(s: Pick<ViewState, "mode" | "compareView">): Mode {
  if (s.mode === "compare") return s.compareView === "diff" ? "trend" : "fcst";
  return s.mode;
}

export interface FramePlan {
  all: FieldNeeds;
  cur: Source;
  /** The run shown has a frame at this valid time. */
  covered: boolean;
  /** The compared model, in compare mode. */
  bProduct: Product | null;
  bPick: { src: Source | null; why: string } | null;
  bSource: Source | null;
  /** Where the comparison comes from: the older run (trend) or the other model (difference). */
  older: Source | null;
  /** Side by side: a second map. */
  side: boolean;
  needsCur: string[];
  needsOld: string[];
  needsB: string[];
  /**
   * A total's window (24 h or Total), shared by every source drawn, or null
   * for the frames at the valid time. Its fields are in `sums`.
   */
  acc: Window | null;
  /** Fields loaded as totals over `acc`, and the bands summed. */
  sums: Record<string, string[]>;
}

/**
 * The sources and fields a frame draws: the current run, the older run or
 * other model, and the right-hand map side by side. `compare` is the
 * compared product in compare mode. A total's window starts at the latest
 * init among the runs drawn, or at `startAtLeast` (presentation slots share
 * one start).
 */
export function planFrame(
  s: ViewState, product: Product, compare: Product | null, pair: FramePair, startAtLeast?: Date | null,
): FramePlan {
  const view = viewById(s.view);
  const vm = viewModeOf(s);
  const overlays = new Set(s.overlays);
  const all = view.fields(vm, s.variable, overlays);
  const cur: Source = { product, run: pair.currentRun, fhr: pair.currentFhr };
  // On the shared axis the run shown may not reach this time: nothing of its own to load or compare
  const covered = hasHour(product, pair.currentFhr);
  const bProduct = s.mode === "compare" ? compare : null;
  const bPick = bProduct ? compareSource(bProduct, pair, s.compareRun) : null;
  const bSource = bPick?.src ?? null;
  const older: Source | null = !covered ? null : s.mode === "trend"
    ? { product, run: pair.olderRun, fhr: pair.olderFhr }
    : vm === "trend" ? bSource : null;
  const side = s.mode === "compare" && vm === "fcst";
  const sideNeeds = side && bProduct ? view.fields("fcst", s.variable, overlays) : null;

  // Overlays from fields a product doesn't have (AIFS gust) are just left out
  const has = (p: Product) => (f: string) => f === all.primary || f in p.manifest.fields;
  const needsCur = covered ? all.current.filter(has(cur.product)) : [];
  const needsOld = older ? all.older.filter(has(older.product)) : [];
  const needsB = sideNeeds && bSource ? sideNeeds.current.filter(has(bSource.product)) : [];

  let acc: Window | null = null;
  const sums: Record<string, string[]> = {};
  if (view.sums && s.period !== "6h" && all.primary in view.sums) {
    sums[all.primary] = view.sums[all.primary];
    acc = windowFor(s.period, pair.valid, windowStart([cur, older, side ? bSource : null], startAtLeast));
  }
  return { all, cur, covered, bProduct, bPick, bSource, older, side, needsCur, needsOld, needsB, acc, sums };
}

/** Where a total's window starts: the latest init among the runs drawn, and no earlier than `atLeast`. */
export function windowStart(sources: (Source | null)[], atLeast?: Date | null): Date {
  const inits = sources.filter((x): x is Source => !!x).map((x) => parseRunId(x.run));
  return latestOf(atLeast ? [...inits, atLeast] : inits);
}

/** The forecast hours a source reads for a field: the window's, for a total, or just its own. */
export function hoursFor(src: Source, field: string, plan: Pick<FramePlan, "acc" | "sums">): number[] {
  return plan.acc && field in plan.sums ? windowHours(parseRunId(src.run), plan.acc) : [src.fhr];
}

/**
 * Load a source's fields: each a frame at its hour, or for a total the sum of
 * the window's frames. A window with no 6-h amounts yet (the valid time is
 * where it starts) has nothing to load.
 */
export function loadFields(src: Source, ids: string[], plan: Pick<FramePlan, "acc" | "sums">): Promise<PromiseSettledResult<Bands>[]> {
  return Promise.allSettled(ids.map((f) => {
    if (!plan.acc || !(f in plan.sums)) return src.product.frames.get(src.run, f, src.fhr);
    const hours = windowHours(parseRunId(src.run), plan.acc);
    if (!hours.length) return Promise.reject(new FrameUnavailable(src.run, f, src.fhr, "the total starts at this time"));
    // Name the hour a total lacks, not the hour shown
    const lacking = (h: number, why: string) => new FrameUnavailable(src.run, f, h, `the total needs ${fhrLabel(h)}: ${why}`);
    for (const h of hours) {
      const why = src.product.frames.missingReason(src.run, f, h);
      if (why) return Promise.reject(lacking(h, why));
    }
    return Promise.all(hours.map((h) => src.product.frames.get(src.run, f, h).catch((e: unknown) => {
      throw lacking(h, e instanceof Error ? e.message : String(e));
    }))).then((frames) => sumBands(frames, plan.sums[f]));
  }));
}

/** A run's first missing 6-h amount of a field, and the last valid time a total over it can reach. */
export interface TotalGap {
  product: Product;
  run: string;
  fhr: number;
  /** The valid time before the gap: no total reaches past it. */
  reach: Date;
}

/**
 * The first 6-h amount `run` lacks within the product's hours (an hour that
 * never posted, or the rest of a run still posting), or null with none.
 */
export function firstGap(p: Product, run: string, field: string): TotalGap | null {
  const entry = p.manifest.runs.find((r) => r.id === run);
  const spec = p.manifest.fields[field];
  if (!entry || !spec) return null;
  const have = new Set(entry.hours[field] ?? []);
  for (let f = Math.max(spec.min_fhr, AMOUNT_HOURS); f <= hoursOf(p).max; f += AMOUNT_HOURS) {
    if (!have.has(f)) return { product: p, run, fhr: f, reach: addHours(parseRunId(run), f - AMOUNT_HOURS) };
  }
  return null;
}

/**
 * Where a view of totals has to stop: the earliest gap among the runs it
 * sums (the run shown, the older run of a trend, the compared model's run),
 * or null for anything else. Past it every total would lack an hour, so the
 * scrubber ends there.
 */
export function totalsGap(s: ViewState, product: Product, compare: Product | null, run: string): TotalGap | null {
  const view = viewById(s.view);
  if (!view.sums || s.period === "6h") return null;
  const field = view.fields("fcst", s.variable, new Set()).primary;
  if (!(field in view.sums)) return null;
  const runs: [Product, string | null][] = [[product, run]];
  if (s.mode === "trend") runs.push([product, runId(addHours(parseRunId(run), -s.lag))]);
  if (s.mode === "compare" && compare) {
    runs.push([compare, s.compareRun === "latest" ? compare.manifest.latest : s.compareRun === "same" ? run : s.compareRun]);
  }
  let earliest: TotalGap | null = null;
  for (const [p, r] of runs) {
    const gap = r ? firstGap(p, r, field) : null;
    if (gap && (!earliest || gap.reach < earliest.reach)) earliest = gap;
  }
  return earliest;
}
