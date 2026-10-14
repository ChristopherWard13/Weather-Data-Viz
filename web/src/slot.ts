// One presentation slot: a site view (the link form, without its time) drawn
// at the frame's shared valid time. Loads the frames, builds the scene, and
// says what the corner label and color bar show.
import { pairFor, type FramePair } from "./alignment";
import type { ColorbarSpec } from "./colorbar";
import { FrameUnavailable } from "./frames";
import { loadFields, planFrame, viewModeOf, type Product } from "./sources";
import type { Period, Window } from "./accum";
import { SNOW_RATIO } from "./views/precip";
import type { ViewState } from "./state";
import { addHours, dayLabel, fhrLabel, fmtValid, parseRunId, runId, type Zone } from "./time";
import { hoursBetween } from "./timeaxis";
import type { Units } from "./units";
import { fieldItem, viewById } from "./views";
import type { Scene, ViewInputs } from "./views/types";
import type { Bands } from "./types";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Sun 18Z": a run by its UTC day and cycle. */
export const runName = (run: string) => `${DAYS[parseRunId(run).getUTCDay()]} ${run.slice(8, 10)}Z`;

export interface SlotFrame {
  spec: ViewState;
  product: Product;
  /** The compared model of a difference map. */
  other: Product | null;
  pair: FramePair;
  /** What the map draws; null leaves it empty (with `status` saying why). */
  scene: Scene | null;
  /** Why the map is empty or has no comparison, or null when it draws normally. */
  status: string | null;
  /** The corner label: what this map is, and when. */
  title: string;
  when: string;
  /** The field and mode, for the shared header when every slot shows the same. */
  field: string;
  /** The field without a total's start, for file names: "Total snowfall (10:1)". */
  name: string;
  /** The window a total covers (shared by every slot), or null. */
  acc: Window | null;
}

export interface SlotContext {
  products: Map<string, Product>;
  zone: Zone;
  units: Units;
  now: Date;
  /** Per-slot memo for contours and extrema; keys carry their sources. */
  memo: Map<string, unknown>;
}

/**
 * The field a slot shows, as a viewer would say it: "500 mb vorticity",
 * "Gusts", "24-hour snowfall (10:1)". `hours` is a 24-h total's span, when
 * the window cuts it short.
 */
export function fieldName(s: Pick<ViewState, "view" | "variable"> & { period?: Period }, hours?: number): string {
  if (s.view === "h500") return s.variable === "hgt" ? "500 mb heights" : "500 mb vorticity";
  if (s.view === "precip") {
    const what = s.variable === "snow" ? `snowfall (${SNOW_RATIO}:1)` : "precipitation";
    const period = s.period ?? "6h";
    return period === "total" ? `Total ${what}` : `${period === "24h" ? hours || 24 : 6}-hour ${what}`;
  }
  const noun = fieldItem(s.view, s.variable).noun;
  return noun[0].toUpperCase() + noun.slice(1);
}

/** The run a slot shows: its pinned run if still retained, else the latest. */
export function slotRun(s: ViewState, p: Product): string {
  return s.run && p.manifest.runs.some((r) => r.id === s.run) ? s.run : p.manifest.latest!;
}

/**
 * The current and older runs at a valid time. The hour can be one the run
 * doesn't have, even before its init (which `pairFor` refuses).
 */
function pairAt(run: string, valid: Date, lag: number): FramePair {
  const init = parseRunId(run);
  const fhr = hoursBetween(init, valid);
  if (fhr >= 0) return pairFor(init, fhr, lag);
  const olderInit = addHours(init, -lag);
  return { valid, currentInit: init, currentFhr: fhr, olderInit, olderFhr: fhr + lag, currentRun: run, olderRun: runId(olderInit) };
}

const reason = (r: PromiseSettledResult<unknown> | undefined) =>
  !r || r.status === "fulfilled" ? "not loaded" : r.reason instanceof FrameUnavailable ? r.reason.message : String(r.reason);

/**
 * The runs a slot draws at `valid`, for working out the window its totals
 * share with the other slots: the latest init among them.
 */
export function slotWindowStart(spec: ViewState, valid: Date, c: Pick<SlotContext, "products">): Date | null {
  const product = c.products.get(spec.product)!;
  const s: ViewState = { ...spec, compareView: "diff" };
  const other = s.mode === "compare" && s.compare ? c.products.get(s.compare) ?? null : null;
  return planFrame(s, product, other, pairAt(slotRun(s, product), valid, s.lag)).acc?.start ?? null;
}

/**
 * Load a slot's frames at `valid` and build what it draws. Totals start at
 * `windowStart` when given (the latest among the slots), so every slot sums
 * the same hours, as they all show the same valid time.
 */
export async function loadSlot(spec: ViewState, valid: Date, c: SlotContext, windowStart?: Date | null): Promise<SlotFrame> {
  const product = c.products.get(spec.product)!;
  const s: ViewState = { ...spec, compareView: "diff" }; // side by side is two slots
  const other = s.mode === "compare" && s.compare ? c.products.get(s.compare) ?? null : null;
  const run = slotRun(s, product);
  const pair = pairAt(run, valid, s.lag);
  const view = viewById(s.view);
  const vm = viewModeOf(s);
  const plan = planFrame(s, product, other, pair, windowStart);
  const { all, cur, covered, older, needsCur, needsOld, acc } = plan;

  const load = (src: typeof cur | null, ids: string[]) => (src ? loadFields(src, ids, plan) : Promise.resolve([]));
  const [curRes, oldRes] = await Promise.all([load(cur, needsCur), load(older, needsOld)]);
  const settle = (ids: string[], res: PromiseSettledResult<Bands>[]) =>
    Object.fromEntries(ids.map((f, i) => [f, res[i]?.status === "fulfilled" ? res[i].value : null]));
  const curBands = settle(needsCur, curRes);
  const oldBands = settle(needsOld, oldRes);
  for (const src of [cur, older]) {
    // Warm the next frame, which a loop or a step asks for next
    if (src) for (const f of src === cur ? needsCur : needsOld) src.product.frames.preload(src.run, f, src.fhr + src.product.cfg.fhr.step);
  }

  const name = product.cfg.name, oName = other?.cfg.name ?? "";
  let status: string | null = null;
  let draw = true;
  if (s.mode === "compare" && !other) {
    status = "Pick a model to subtract";
    draw = false;
  } else if (other && other.cfg.grid !== product.cfg.grid) {
    status = `${name} and ${oName} are on different grids`;
    draw = false;
  } else if (!covered) {
    const h = product.manifest.display_hours;
    const before = pair.currentFhr < h[0];
    const edge = addHours(pair.currentInit, before ? h[0] : h[h.length - 1]);
    status = `${name}'s ${runName(run)} run ${before ? "starts" : "ends"} ${fmtValid(edge, c.zone)}`;
    draw = false;
  } else if (acc && acc.hours === 0) {
    status = `The ${acc.period === "total" ? "total" : "24-h total"} starts at ${fmtValid(acc.start, c.zone)}`;
    draw = false;
  } else if (!curBands[all.primary]) {
    status = `No ${name} frame (${reason(curRes[needsCur.indexOf(all.primary)])})`;
    draw = false;
  } else if (vm === "trend" && !oldBands[all.primary]) {
    status = s.mode === "trend"
      ? `No comparison: needs the ${runName(pair.olderRun)} run at ${fhrLabel(pair.olderFhr)}`
      : `No comparison: ${oName} has no frame at this time (${older ? reason(oldRes[needsOld.indexOf(all.primary)]) : plan.bPick!.why})`;
  }

  const sides = s.mode === "compare"
    ? { cur: name, old: oName, minus: `${name} ${runName(run)} minus ${oName}${older ? ` ${runName(older.run)}` : ""}` }
    : { cur: "Current", old: "Older", minus: `${runName(run)} minus ${runName(pair.olderRun)}` };
  let scene: Scene | null = null;
  if (draw) {
    const key = (src: typeof cur | null) => (src ? `${src.product.cfg.id}:${src.run}/${src.fhr}` : "-");
    const prefix = `${view.id}|${key(cur)}|${key(older)}|${acc ? `${acc.period}/${acc.from.getTime()}|` : ""}`;
    const inputs: ViewInputs = {
      grid: product.manifest.grid,
      focus: null, // stats aren't shown in a slot
      mode: vm,
      variable: s.variable,
      overlays: new Set(s.overlays),
      isotachs: s.isotachs,
      limitMode: s.limitMode,
      pair,
      cur: curBands,
      old: oldBands,
      sides,
      precipType: product.cfg.precipType,
      acc,
      units: c.units,
      memo: <T,>(k: string, make: () => T): T => {
        const full = prefix + k;
        if (c.memo.has(full)) return c.memo.get(full) as T;
        const v = make();
        c.memo.set(full, v);
        if (c.memo.size > 120) c.memo.delete(c.memo.keys().next().value!);
        return v;
      },
    };
    scene = view.scene(inputs);
  }

  const what = fieldName(s, acc?.hours);
  // A total says where it starts, in the shared header (every slot's start is the same)
  const field = what + (acc?.period === "total" ? ` since ${fmtValid(acc.start, c.zone)}` : "");
  const title = s.mode === "compare"
    ? `${name} ${runName(run)} minus ${oName}${older ? ` ${runName(older.run)}` : ""} · ${s.view === "h500" ? "500 mb heights" : what}`
    : s.mode === "trend"
      ? `${name} ${runName(run)} run · ${what}, change since ${runName(pair.olderRun)}`
      : `${name} ${runName(run)} run · ${what}`;
  const when = [fmtValid(valid, c.zone), covered ? fhrLabel(pair.currentFhr) : "", dayLabel(c.now, valid, c.zone)].filter(Boolean).join(" · ");
  return { spec: s, product, other, pair, scene, status, title, when, field, name: what, acc };
}

/** What a slot's color bar will be, known from its view before any frame loads. */
export interface SlotBar {
  /** Equal keys draw the same bar, so one can serve every slot. */
  key: string;
  /** Stands in for the bar's shape when laying out (only its kind and rows matter). */
  spec: ColorbarSpec;
}

/**
 * A slot's color bar, from its view, mode and units. Forecast bars have fixed
 * ranges, so slots showing the same field share one. Trend and difference
 * bars name their runs in the caption (and an auto scale varies by frame), so
 * each slot keeps its own: `slot` makes their keys unique.
 */
export function slotBar(s: ViewState, product: Product, units: Units, slot: number): SlotBar {
  const vm = viewModeOf({ ...s, compareView: "diff" });
  const stand = (): ColorbarSpec => ({ kind: "diverging", color: () => "", limit: 1 });
  if (vm === "trend") return { key: `trend|${slot}`, spec: stand() };
  if (s.view === "precip" && (s.variable === "snow" || s.period !== "6h")) {
    // Totals and snowfall: one row of bins, the same for every model
    // The caption names the period, so only slots with the same period share a bar
    return { key: `bins|${s.variable}|${s.period}`, spec: { kind: "bins", bins: [], colors: [], label: "" } };
  }
  if (s.view === "precip") {
    const untyped = !product.cfg.precipType;
    return { key: `precip|${untyped}`, spec: { kind: "precip", untyped } };
  }
  return { key: `${s.view}|${s.variable}|${units.speed}|${units.temp}`, spec: stand() };
}
