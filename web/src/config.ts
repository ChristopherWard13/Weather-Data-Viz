// The shared repo-root config/, bundled at build time. GFS is the only
// product so far, so its model file supplies the hours and lags.
import site from "../../config/site.json";
import gfs from "../../config/models/gfs.json";

function range(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let v = min; v <= max; v += step) out.push(v);
  return out;
}

export interface ViewConfig {
  trendLimit: number;
  autoRound: number;
}

const views = site.views as Record<string, { trend_limit: number; auto_round: number }>;

export const config = {
  modelName: gfs.name,
  fhr: { ...gfs.forecast_hours },
  lags: [...gfs.lags_hours].sort((a, b) => a - b),
  defaultLag: gfs.default_lag_hours,
  isotachOptions: range(site.views.jet.isotachs_kt.min, site.views.jet.isotachs_kt.max, site.views.jet.isotachs_kt.step),
  defaultIsotachs: [...site.views.jet.isotachs_kt.default],
  views: Object.fromEntries(
    Object.entries(views).map(([k, v]) => [k, { trendLimit: v.trend_limit, autoRound: v.auto_round }]),
  ) as Record<string, ViewConfig>,
  projection: {
    centralMeridian: site.projection.central_meridian,
    parallels: site.projection.parallels as [number, number],
  },
};
