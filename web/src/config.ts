// The shared repo-root config/, bundled at build time.
import site from "../../config/site.json";

interface ModelJson {
  name: string;
  forecast_hours: { min: number; max: number; step: number };
  lags_hours: number[];
  default_lag_hours: number;
  fields: Record<string, unknown>;
  products: Record<string, { grid: string }>;
}

const modelFiles = import.meta.glob<ModelJson>("../../config/models/*.json", { eager: true, import: "default" });

function range(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let v = min; v <= max; v += step) out.push(v);
  return out;
}

export interface ViewConfig {
  trendLimit: number;
  autoRound: number;
}

/** A model on one display grid, as the site offers it. Hours shown come from its manifest. */
export interface ProductConfig {
  id: string;
  model: string;
  name: string;
  fhr: { min: number; max: number; step: number };
  lags: number[];
  defaultLag: number;
  fields: string[];
}

const products: ProductConfig[] = site.products.map((id) => {
  for (const [path, m] of Object.entries(modelFiles)) {
    if (id in m.products) {
      return {
        id,
        model: path.split("/").pop()!.replace(/\.json$/, ""),
        name: m.name,
        fhr: { ...m.forecast_hours },
        lags: [...m.lags_hours].sort((a, b) => a - b),
        defaultLag: m.default_lag_hours,
        fields: Object.keys(m.fields),
      };
    }
  }
  throw new Error(`config/site.json lists product ${id}, which no config/models/*.json defines`);
});

const views = site.views as Record<string, { trend_limit: number; auto_round: number }>;

export const config = {
  /** Products in model-bar order; the first is the default. */
  products,
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

export const DEFAULT_PRODUCT = products[0].id;

export function productById(id: string | null | undefined): ProductConfig | undefined {
  return products.find((p) => p.id === id);
}
