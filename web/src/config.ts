// The shared repo-root config.json, bundled at build time.
import raw from "../../config.json";

function range(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let v = min; v <= max; v += step) out.push(v);
  return out;
}

export interface ViewConfig {
  trendLimit: number;
  autoRound: number;
}

const views = raw.views as Record<string, { trend_limit: number; auto_round: number }>;

export const config = {
  modelName: raw.model.name.toUpperCase(),
  fhr: { ...raw.forecast_hours },
  lags: [...raw.lags_hours].sort((a, b) => a - b),
  defaultLag: raw.default_lag_hours,
  isotachOptions: range(raw.views.jet.isotachs_kt.min, raw.views.jet.isotachs_kt.max, raw.views.jet.isotachs_kt.step),
  defaultIsotachs: [...raw.views.jet.isotachs_kt.default],
  views: Object.fromEntries(
    Object.entries(views).map(([k, v]) => [k, { trendLimit: v.trend_limit, autoRound: v.auto_round }]),
  ) as Record<string, ViewConfig>,
  projection: {
    centralMeridian: raw.projection.central_meridian,
    parallels: raw.projection.parallels as [number, number],
  },
};
