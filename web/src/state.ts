import { config } from "./config";
import { defaultOverlays, isViewId, viewById } from "./views";
import type { LimitMode, Mode, ViewId } from "./views/types";

export type { LimitMode };

export interface ViewState {
  view: ViewId;
  /** Current run id, or null for "latest". */
  run: string | null;
  lag: number;
  fhr: number;
  isotachs: number[];
  limitMode: LimitMode;
  mode: Mode;
  variable: string;
  overlays: string[];
}

/** Per-view settings that survive switching tabs. */
export interface ViewPrefs {
  mode: Mode;
  variable: string;
  overlays: string[];
}

export function viewDefaults(id: ViewId): ViewPrefs {
  const v = viewById(id);
  return { mode: v.defaultMode, variable: v.variables?.[0].id ?? "", overlays: defaultOverlays(v) };
}

export function defaultState(view: ViewId = "jet"): ViewState {
  return {
    view,
    run: null,
    lag: config.defaultLag,
    fhr: config.fhr.min,
    isotachs: [...config.defaultIsotachs],
    limitMode: "fixed",
    ...viewDefaults(view),
  };
}

/**
 * Parse ?v=&mode=&var=&run=&lag=&f=&iso=&ov=&lim=; anything invalid falls back
 * to its default. Links from before the tabs existed (no `v`) open the jet trend.
 */
export function parseState(search: string): ViewState {
  const q = new URLSearchParams(search);
  const vParam = q.get("v");
  const s = defaultState(isViewId(vParam) ? vParam : "jet");
  const view = viewById(s.view);

  const run = q.get("run");
  if (run && /^\d{10}$/.test(run)) s.run = run;

  const lag = Number(q.get("lag"));
  if (config.lags.includes(lag)) s.lag = lag;

  const fRaw = q.get("f");
  const f = Number(fRaw);
  if (fRaw !== null && fRaw !== "" && Number.isInteger(f) && f >= config.fhr.min && f <= config.fhr.max && (f - config.fhr.min) % config.fhr.step === 0) {
    s.fhr = f;
  }

  const iso = q.get("iso");
  if (iso !== null) s.isotachs = parseList(iso, (v) => config.isotachOptions.includes(Number(v))).map(Number).sort((a, b) => a - b);

  const mode = q.get("mode");
  if (mode && (view.modes as string[]).includes(mode)) s.mode = mode as Mode;

  const variable = q.get("var");
  if (variable && view.variables?.some((x) => x.id === variable)) s.variable = variable;

  const ov = q.get("ov");
  if (ov !== null) s.overlays = parseList(ov, (v) => view.overlays.some((o) => o.id === v));

  const lim = q.get("lim");
  if (lim === "auto" || lim === "fixed") s.limitMode = lim;
  return s;
}

function parseList(raw: string, ok: (v: string) => boolean): string[] {
  if (raw === "" || raw === "none") return [];
  return [...new Set(raw.split(",").filter(ok))];
}

export function serializeState(s: ViewState): string {
  const q = new URLSearchParams();
  const view = viewById(s.view);
  q.set("v", s.view);
  q.set("mode", s.mode);
  if (view.variables) q.set("var", s.variable);
  if (s.run) q.set("run", s.run);
  q.set("lag", String(s.lag));
  q.set("f", String(s.fhr));
  if (s.view === "jet") q.set("iso", s.isotachs.length ? s.isotachs.join(",") : "none");
  q.set("ov", s.overlays.length ? s.overlays.join(",") : "none");
  q.set("lim", s.limitMode);
  return `?${q.toString().replace(/%2C/g, ",")}`;
}
