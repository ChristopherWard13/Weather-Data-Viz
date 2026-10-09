// The shared repo-root config.json, bundled at build time.
import raw from "../../config.json";

export interface AppConfig {
  levelLabel: string;
  modelName: string;
  fhr: { min: number; max: number; step: number };
  lags: number[];
  defaultLag: number;
  isotachOptions: number[];
  defaultIsotachs: number[];
  colorbar: { defaultLimit: number; autoRound: number };
  projection: { centralMeridian: number; parallels: [number, number] };
}

function range(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let v = min; v <= max; v += step) out.push(v);
  return out;
}

export const config: AppConfig = {
  levelLabel: raw.model.level_label,
  modelName: raw.model.name.toUpperCase(),
  fhr: { ...raw.forecast_hours },
  lags: [...raw.lags_hours].sort((a, b) => a - b),
  defaultLag: raw.default_lag_hours,
  isotachOptions: range(raw.isotachs_kt.min, raw.isotachs_kt.max, raw.isotachs_kt.step),
  defaultIsotachs: [...raw.isotachs_kt.default],
  colorbar: { defaultLimit: raw.colorbar.default_limit_kt, autoRound: raw.colorbar.auto_round_kt },
  projection: {
    centralMeridian: raw.projection.central_meridian,
    parallels: raw.projection.parallels as [number, number],
  },
};
