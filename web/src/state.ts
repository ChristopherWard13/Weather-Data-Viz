import { isPeriod, type Period } from "./accum";
import { config, DEFAULT_PRODUCT, DEFAULT_REGION, productById, regionById, type ProductConfig } from "./config";
import { addHours, parseRunId, runId } from "./time";
import { defaultOverlays, isViewId, viewById } from "./views";
import type { LimitMode, Mode, ViewId } from "./views/types";

export type { LimitMode };

/** Forecast and trend come from the view; compare puts a second model beside it. */
export type AppMode = Mode | "compare";
export type CompareView = "side" | "diff";
/**
 * Which run of the compared model: its newest that reaches the valid time,
 * the run with the same init as the current one, or a run id.
 */
export type CompareRun = "latest" | "same" | string;

export interface ViewState {
  /** Product id, e.g. "gfs" (URL `m`). */
  product: string;
  /** Region in focus (URL `r`). */
  region: string;
  view: ViewId;
  /** Current run id, or null for "latest". */
  run: string | null;
  lag: number;
  fhr: number;
  /**
   * Valid time from a link (URL `t`, YYYYMMDDHH), until the app resolves it
   * to a forecast hour of the run it shows; null after that.
   */
  valid: string | null;
  isotachs: number[];
  limitMode: LimitMode;
  mode: AppMode;
  variable: string;
  overlays: string[];
  /** Precipitation: per 6 h, 24-h totals, or totals over the shared window (URL `acc`). */
  period: Period;
  /** Compare mode's other product (URL `c`), or null for the default. */
  compare: string | null;
  /** Compare mode: side by side, or the difference map (URL `cv`). */
  compareView: CompareView;
  /** Compare mode: the other model's run (URL `crun`). */
  compareRun: CompareRun;
}

/** Per-view settings that survive switching fields. */
export interface ViewPrefs {
  mode: AppMode;
  variable: string;
  overlays: string[];
}

export function viewDefaults(id: ViewId): ViewPrefs {
  const v = viewById(id);
  return { mode: v.defaultMode, variable: v.variables?.[0].id ?? "", overlays: defaultOverlays(v) };
}

export function defaultState(view: ViewId = "jet", product: string = DEFAULT_PRODUCT): ViewState {
  const p = productById(product)!;
  return {
    product: p.id,
    region: DEFAULT_REGION,
    view,
    run: null,
    lag: p.defaultLag,
    fhr: p.fhr.min,
    valid: null,
    isotachs: [...config.defaultIsotachs],
    limitMode: "fixed",
    ...viewDefaults(view),
    period: "6h",
    compare: null,
    compareView: "side",
    compareRun: "latest",
  };
}

/** Is `f` one of the product's forecast hours (its full configured range)? */
export function isProductHour(p: ProductConfig, f: number): boolean {
  return Number.isInteger(f) && f >= p.fhr.min && f <= p.fhr.max && (f - p.fhr.min) % p.fhr.step === 0;
}

const RUN_ID = /^\d{10}$/;

/**
 * Parse ?m=&r=&v=&mode=&var=&acc=&run=&lag=&t=&iso=&ov=&lim=&c=&cv=&crun=; anything
 * invalid falls back to its default. Older links still open: without `m`
 * they show GFS, without `v` (from before the tabs) the jet trend, and a
 * forecast hour `f` (before `t`) counts from the link's run.
 */
export function parseState(search: string): ViewState {
  const q = new URLSearchParams(search);
  const vParam = q.get("v");
  const product = productById(q.get("m")) ?? productById(DEFAULT_PRODUCT)!;
  const s = defaultState(isViewId(vParam) ? vParam : "jet", product.id);
  const view = viewById(s.view);

  s.region = regionById(q.get("r"))?.id ?? DEFAULT_REGION;

  const run = q.get("run");
  if (run && RUN_ID.test(run)) s.run = run;

  const lag = Number(q.get("lag"));
  if (product.lags.includes(lag)) s.lag = lag;

  const fRaw = q.get("f");
  const f = Number(fRaw);
  if (fRaw !== null && fRaw !== "" && isProductHour(product, f)) s.fhr = f;

  const t = q.get("t");
  if (t && RUN_ID.test(t) && !Number.isNaN(parseRunId(t).getTime())) {
    s.valid = t;
    if (s.run) {
      const h = (parseRunId(t).getTime() - parseRunId(s.run).getTime()) / 3600e3;
      if (isProductHour(product, h)) s.fhr = h;
    }
  }

  const iso = q.get("iso");
  if (iso !== null) s.isotachs = parseList(iso, (v) => config.isotachOptions.includes(Number(v))).map(Number).sort((a, b) => a - b);

  const mode = q.get("mode");
  if (mode && ((view.modes as string[]).includes(mode) || mode === "compare")) s.mode = mode as AppMode;

  const variable = q.get("var");
  if (variable && view.variables?.some((x) => x.id === variable)) s.variable = variable;

  const acc = q.get("acc");
  if (view.periods && isPeriod(acc)) s.period = acc;

  const ov = q.get("ov");
  if (ov !== null) s.overlays = parseList(ov, (v) => view.overlays.some((o) => o.id === v));

  const lim = q.get("lim");
  if (lim === "auto" || lim === "fixed") s.limitMode = lim;

  s.compare = productById(q.get("c"))?.id ?? null;
  const cv = q.get("cv");
  if (cv === "side" || cv === "diff") s.compareView = cv;
  const crun = q.get("crun");
  if (crun === "same" || (crun && RUN_ID.test(crun))) s.compareRun = crun;
  return s;
}

/** What a bare URL opens on a first visit: the 500 mb forecast over Mainland US. */
export const FIRST_VISIT = "?v=h500&r=us";

/**
 * A view to remember for the next bare visit: everything but the run, time and
 * compared run, so it opens on the newest data.
 */
export function rememberable(search: string): string {
  const q = new URLSearchParams(search);
  for (const k of ["run", "t", "f", "crun"]) q.delete(k);
  return `?${q.toString().replace(/%2C/g, ",")}`;
}

function parseList(raw: string, ok: (v: string) => boolean): string[] {
  if (raw === "" || raw === "none") return [];
  return [...new Set(raw.split(",").filter(ok))];
}

/**
 * The URL for a state shown on `run`. Only a past run is pinned (`run`); a link
 * to the latest run follows whatever is newest when it's opened, at the same
 * valid time (`t`). `run=latest` and no `run` mean the same.
 */
export function serializeState(s: ViewState, run: string): string {
  const q = new URLSearchParams();
  const view = viewById(s.view);
  q.set("m", s.product);
  q.set("r", s.region);
  q.set("v", s.view);
  q.set("mode", s.mode);
  if (view.variables) q.set("var", s.variable);
  if (view.periods) q.set("acc", s.period);
  if (s.run) q.set("run", s.run);
  q.set("lag", String(s.lag));
  q.set("t", runId(addHours(parseRunId(run), s.fhr)));
  if (s.view === "jet") q.set("iso", s.isotachs.length ? s.isotachs.join(",") : "none");
  q.set("ov", s.overlays.length ? s.overlays.join(",") : "none");
  q.set("lim", s.limitMode);
  if (s.mode === "compare") {
    if (s.compare) q.set("c", s.compare);
    q.set("cv", s.compareView);
    if (s.compareRun !== "latest") q.set("crun", s.compareRun);
  }
  return `?${q.toString().replace(/%2C/g, ",")}`;
}
