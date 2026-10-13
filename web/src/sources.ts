// Where a map's frames come from: which product, run and hour, for each side
// of a view. Shared by the site's maps and presentation mode's slots.
import type { ProductConfig } from "./config";
import type { FrameCache } from "./frames";
import type { FramePair } from "./alignment";
import type { CompareRun, ViewState } from "./state";
import { fmtTime, parseRunId } from "./time";
import { viewById } from "./views";
import type { FieldNeeds, Mode } from "./views/types";
import type { Manifest } from "./types";

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
}

/**
 * The sources and fields a frame draws: the current run, the older run or
 * other model, and the right-hand map side by side. `compare` is the
 * compared product in compare mode.
 */
export function planFrame(s: ViewState, product: Product, compare: Product | null, pair: FramePair): FramePlan {
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
  return { all, cur, covered, bProduct, bPick, bSource, older, side, needsCur, needsOld, needsB };
}
