// The shared repo-root config/, bundled at build time.
import site from "../../config/site.json";
import grids from "../../config/grids.json";
import regionsJson from "../../config/regions.json";
// Generated with the basemap (npm run basemap): each state's box and label point
import statesJson from "./assets/states.json";

interface ModelJson {
  name: string;
  /** Who to credit on images: "NOAA", "ECMWF (CC BY 4.0; modified)". No ", ": exports break lines there. */
  credit: string;
  about?: string;
  cycle_interval_hours: number;
  /** Measured minutes after init by which a whole run is posted. */
  latency_minutes: number;
  forecast_hours: { min: number; max: number; step: number };
  lags_hours: number[];
  default_lag_hours: number;
  fields: Record<string, unknown>;
  /** false for models with no precipitation type (AIGFS, AIGEFS, HGEFS). */
  precip_type?: boolean;
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
  /** Model-bar group ("Global", "AI", …). */
  group: string;
  /** Display grid id, e.g. "na025". */
  grid: string;
  /** The model outputs precipitation type; without it, wet points are type 5 ("unspecified"). */
  precipType: boolean;
  cycleHours: number;
  /** Measured minutes after init by which a whole run is posted (when the next run is due). */
  latencyMinutes: number;
  /** Who to credit on images: "NOAA", "ECMWF (CC BY 4.0; modified)". No ", ": exports break lines there. */
  credit: string;
  /** What the model's fields are made of, when the name doesn't say (the ECMWF ENS mean's members). */
  about?: string;
}

const products: ProductConfig[] = site.model_bar.flatMap(({ group, products: ids }) => ids.map((id) => {
  for (const [path, m] of Object.entries(modelFiles)) {
    if (id in m.products) {
      return {
        id,
        model: path.split("/").pop()!.replace(/\.json$/, ""),
        group,
        grid: m.products[id].grid,
        name: m.name,
        fhr: { ...m.forecast_hours },
        lags: [...m.lags_hours].sort((a, b) => a - b),
        defaultLag: m.default_lag_hours,
        fields: Object.keys(m.fields),
        precipType: m.precip_type ?? true,
        cycleHours: m.cycle_interval_hours,
        latencyMinutes: m.latency_minutes,
        credit: m.credit,
        about: m.about,
      };
    }
  }
  throw new Error(`config/site.json lists product ${id}, which no config/models/*.json defines`);
}));

/** A lat/lon box: south, north, west, east (degrees, west negative). */
export interface Box {
  lat: [number, number];
  lon: [number, number];
}

/**
 * A region of the map. Focusing one only refits the projection to its box;
 * `states` (two-letter codes) form its click target, merged into the basemap's
 * `regions` layer by scripts/build-basemap.mjs.
 */
export interface RegionConfig {
  id: string;
  label: string;
  parent: string | null;
  box: Box;
  states: string[];
  /** Click target: the states' polygons, or the whole box (islands too small to hit at continental zoom). */
  hit: "states" | "box";
  /** A single state, reached by clicking it inside a focused region; its label point. */
  state?: { code: string; label: [number, number] };
}

/**
 * The smallest box a state shows (degrees of longitude and latitude), so a
 * small state keeps its neighbours and the 0.25° cells stay a sensible size.
 */
export const MIN_STATE_BOX = { lon: 6, lat: 4.5 };

interface StateJson {
  id: string;
  name: string;
  region: string;
  box: [number, number, number, number];
  label: [number, number];
}

/** A box grown about its center to at least `min` degrees each way. */
export function growBox(box: Box, min: { lon: number; lat: number }): Box {
  const grow = ([a, b]: [number, number], size: number): [number, number] => {
    const pad = Math.max(0, size - (b - a)) / 2;
    return [a - pad, b + pad];
  };
  return { lat: grow(box.lat, min.lat), lon: grow(box.lon, min.lon) };
}

type GridJson = { lat_min: number; lat_max: number; lon_min: number; lon_max: number };
const gridBox = (id: string): Box => {
  const g = (grids as Record<string, GridJson>)[id];
  if (!g) throw new Error(`config/regions.json: unknown grid ${id}`);
  return { lat: [g.lat_min, g.lat_max], lon: [g.lon_min, g.lon_max] };
};

interface RegionJson {
  id: string;
  label: string;
  parent?: string;
  grid?: string;
  lat?: [number, number];
  lon?: [number, number];
  states?: string[];
  hit?: "states" | "box";
}

const regions: RegionConfig[] = (regionsJson.regions as RegionJson[]).map((r, i, all) => ({
  id: r.id,
  label: r.label,
  // The first region is the root; the rest hang off it unless they name a parent
  parent: i === 0 ? null : (r.parent ?? all[0].id),
  box: r.grid ? gridBox(r.grid) : { lat: r.lat!, lon: r.lon! },
  states: r.states ?? [],
  hit: r.hit ?? "states",
}));

// States hang off their region; their ids are the postal codes in lower case
for (const st of statesJson as StateJson[]) {
  const [w, so, e, n] = st.box;
  regions.push({
    id: st.id.toLowerCase(),
    label: st.name,
    parent: st.region,
    box: growBox({ lat: [so, n], lon: [w, e] }, MIN_STATE_BOX),
    states: [st.id],
    hit: "states",
    state: { code: st.id, label: st.label },
  });
}

const views = site.views as Record<string, { trend_limit: number; auto_round: number }>;

export const config = {
  /** Products in model-bar order; the first is the default. */
  products,
  /** Model-bar groups in order. */
  groups: site.model_bar.map((g) => g.group),
  /** Regions, then states (alphabetical); the first is the default view. */
  regions,
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

export const DEFAULT_REGION = regions[0].id;

/**
 * How far a region sits below the root: North America 0, Mainland US and
 * Hawaii 1, Mainland US's regions 2, states 3. From depth 2 a click zooms
 * to a state rather than a region.
 */
export function regionDepth(r: RegionConfig): number {
  let d = 0;
  for (let p = r.parent; p; p = regionById(p)?.parent ?? null) d++;
  return d;
}

export function regionById(id: string | null | undefined): RegionConfig | undefined {
  return regions.find((r) => r.id === id);
}

/** Does a product's display grid cover a region's box? */
export function gridCovers(gridId: string, box: Box): boolean {
  const g = gridBox(gridId);
  return g.lat[0] <= box.lat[0] && g.lat[1] >= box.lat[1] && g.lon[0] <= box.lon[0] && g.lon[1] >= box.lon[1];
}
