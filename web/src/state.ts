import { config } from "./config";

export type LimitMode = "fixed" | "auto";

export interface ViewState {
  /** Current run id, or null for "latest". */
  run: string | null;
  lag: number;
  fhr: number;
  isotachs: number[];
  limitMode: LimitMode;
}

export function defaultState(): ViewState {
  return {
    run: null,
    lag: config.defaultLag,
    fhr: config.fhr.min,
    isotachs: [...config.defaultIsotachs],
    limitMode: "fixed",
  };
}

/** Parse ?run=&lag=&f=&iso=&lim=; anything invalid falls back to its default. */
export function parseState(search: string): ViewState {
  const q = new URLSearchParams(search);
  const s = defaultState();

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
  if (iso !== null) {
    const vals = iso === "" || iso === "none"
      ? []
      : iso.split(",").map(Number).filter((v) => config.isotachOptions.includes(v));
    s.isotachs = [...new Set(vals)].sort((a, b) => a - b);
  }

  const lim = q.get("lim");
  if (lim === "auto" || lim === "fixed") s.limitMode = lim;
  return s;
}

export function serializeState(s: ViewState): string {
  const q = new URLSearchParams();
  if (s.run) q.set("run", s.run);
  q.set("lag", String(s.lag));
  q.set("f", String(s.fhr));
  q.set("iso", s.isotachs.length ? s.isotachs.join(",") : "none");
  q.set("lim", s.limitMode);
  return `?${q.toString().replace(/%2C/g, ",")}`;
}
