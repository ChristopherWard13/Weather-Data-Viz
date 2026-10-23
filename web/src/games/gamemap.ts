// What the daily games' pages share: the Lower 48 map (its projection, size
// and shading of a game's grid), the colours for each field, the viewer's
// units, and results kept in this browser.
import { geoPath, type GeoProjection } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryObject } from "topojson-specification";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import basemap from "../assets/basemap-50m.topo.json";
import type { ColorbarSpec } from "../colorbar";
import {
  buildLut, DEWPT_F, PRECIP_DRY, QPF_TOTAL_BINS, QPF_TOTAL_COLORS, redBlue, rgbaOf, stopsColor, TEMP_F, WIND_KT,
  type ColorFn,
} from "../palettes";
import { parsePrefs } from "../prefs";
import { baseProjection, boxBounds, buildLookup, centralMeridian, domainOutline, type Lookup } from "../projection";
import { shadeBinned, shadeScalar } from "../raster";
import type { Grid } from "../types";
import { speedQ, tempQ, ticksIn, type Units } from "../units";
import { gameUnits, type Area, type MapGrid } from "./score";

/** An element with text (never HTML: station names come from IEM). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}

// ------------------------------------------------------------------ colours

export interface Shade {
  color: ColorFn;
  /** How the map's values are shaded, and the key under it. */
  lut?: ReturnType<typeof buildLut>;
  bins?: { edges: number[]; colors: [number, number, number, number][] };
  colorbar: (lo: number, hi: number, units: Units) => ColorbarSpec;
}

const tempColor = stopsColor(TEMP_F);
const dewColor = stopsColor(DEWPT_F);
const windColor = stopsColor(WIND_KT);
const CHANGE_LIMIT = 20;
const changeColor = redBlue(CHANGE_LIMIT);
const binColor = (v: number) => {
  let b = -1;
  for (let k = 0; k < QPF_TOTAL_BINS.length; k++) if (v >= QPF_TOTAL_BINS[k]) b = k;
  return b < 0 ? PRECIP_DRY : QPF_TOTAL_COLORS[b];
};

function continuous(color: ColorFn, unitsQ: (u: Units) => ReturnType<typeof tempQ>, every: number, suffix = "") {
  return (lo: number, hi: number, units: Units): ColorbarSpec => {
    const t = ticksIn(unitsQ(units), lo, hi, every);
    return { kind: "continuous", color, min: lo, max: hi, ticks: t.ticks, extend: "none", format: (v) => `${t.format(v)}${suffix}` };
  };
}

export const TEMP_SHADE: Shade = {
  color: tempColor, lut: buildLut(tempColor, -40, 120), colorbar: continuous(tempColor, (u) => tempQ(u, "F"), 10, "°"),
};
export const DEW_SHADE: Shade = {
  color: dewColor, lut: buildLut(dewColor, -20, 80), colorbar: continuous(dewColor, (u) => tempQ(u, "F"), 10, "°"),
};
export const GUST_SHADE: Shade = {
  color: windColor, lut: buildLut(windColor, 0, 80), colorbar: continuous(windColor, (u) => speedQ(u), 10),
};
export const RAIN_SHADE: Shade = {
  color: binColor,
  bins: { edges: QPF_TOTAL_BINS, colors: QPF_TOTAL_COLORS.map(rgbaOf) },
  colorbar: () => ({ kind: "bins", bins: QPF_TOTAL_BINS, colors: QPF_TOTAL_COLORS, label: "Inches" }),
};
export const CHANGE_SHADE: Shade = {
  color: changeColor, lut: buildLut(changeColor, -CHANGE_LIMIT, CHANGE_LIMIT),
  colorbar: (_lo, _hi, u) => ({ kind: "diverging", color: changeColor, limit: CHANGE_LIMIT, scale: tempQ(u, "F").scale }),
};

// ------------------------------------------------------------------ the map

const topo = basemap as unknown as Topology<Record<"statePolys", GeometryObject>>;
export const statePolys = (feature(topo, topo.objects.statePolys) as unknown as FeatureCollection<Polygon | MultiPolygon>)
  .features as Feature<Polygon | MultiPolygon>[];

export function fit(area: Area, width: number, height: number): GeoProjection {
  const outline = { type: "MultiPoint" as const, coordinates: domainOutline(boxBounds(area), 0.5) };
  return baseProjection(centralMeridian(area)).fitExtent([[8, 8], [width - 8, height - 8]], outline);
}

/** The area's width over its height, as drawn. */
export function areaAspect(area: Area): number {
  const p = fit(area, 1000, 1000);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const pt of domainOutline(boxBounds(area), 0.5)) {
    const [x, y] = p(pt as [number, number])!;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return (x1 - x0) / (y1 - y0);
}

/** Size a canvas in CSS pixels and return its context, scaled for the screen. */
export function sizeCanvas(c: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(width * dpr);
  c.height = Math.round(height * dpr);
  c.style.width = `${width}px`;
  c.style.height = `${height}px`;
  const ctx = c.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** The map under the weather: sea, then the states in white. */
export function drawLand(ctx: CanvasRenderingContext2D, proj: GeoProjection, width: number, height: number): void {
  const path = geoPath(proj, ctx);
  ctx.fillStyle = "#e4e9f0";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  for (const f of statePolys) {
    ctx.beginPath();
    path(f);
    ctx.fill();
  }
}

export function asGrid(g: MapGrid): Grid {
  return {
    ...g, id: "game", lat_min: g.lat0 + g.dlat * (g.ny - 1), lat_max: g.lat0, lon_min: g.lon0,
    lon_max: g.lon0 + g.dlon * (g.nx - 1), row_order: "north_to_south", col_order: "west_to_east",
  } as unknown as Grid;
}

/** Pixel lookups into a game's grid, by grid and canvas size. */
const lookups = new Map<string, Lookup>();

/**
 * A game grid's values, shaded at CSS-pixel resolution (the field is smooth)
 * and scaled to the canvas, over the Lower 48 only: the guessable area,
 * without the grid's curved edge out at sea.
 */
export function shadeGrid(ctx: CanvasRenderingContext2D, proj: GeoProjection, g: MapGrid, values: Float32Array, shade: Shade,
                          width: number, height: number): void {
  const key = `${g.lat0},${g.lon0},${g.dlat},${g.ny}x${g.nx}@${width}x${height}`;
  let lookup = lookups.get(key);
  if (!lookup) {
    lookup = buildLookup(proj, asGrid(g), width, height);
    lookups.set(key, lookup);
  }
  const image = new ImageData(width, height);
  if (shade.bins) shadeBinned(image.data, lookup, values, g.nx, shade.bins.edges, shade.bins.colors, [0, 0, 0, 0]);
  else shadeScalar(image.data, lookup, values, g.nx, shade.lut!);
  const off = document.createElement("canvas");
  off.width = width;
  off.height = height;
  off.getContext("2d")!.putImageData(image, 0, 0);
  ctx.save();
  const path = geoPath(proj, ctx);
  ctx.beginPath();
  for (const f of statePolys) path(f);
  ctx.clip();
  ctx.globalAlpha = 0.85;
  ctx.drawImage(off, 0, 0, width, height);
  ctx.restore();
}

/** The value of a game grid at a point, or NaN off the grid or where it's missing. */
export function valueAtPoint(g: MapGrid, values: Float32Array, lon: number, lat: number): number {
  const r = Math.round((lat - g.lat0) / g.dlat);
  const c = Math.round((lon - g.lon0) / g.dlon);
  if (r < 0 || r >= g.ny || c < 0 || c >= g.nx) return NaN;
  return values[r * g.nx + c];
}

// ------------------------------------------------------------------ the viewer

/** The viewer's units from the site's display settings, if they've ever saved any. */
export function viewerUnits(): Units {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem("rtr:display");
  } catch {
    raw = null;
  }
  return gameUnits(raw ? parsePrefs(raw, undefined).units : null);
}

/** Each day's play, kept in this browser under `key` for the last `keepDays` days played. */
export function savedDays<T>(key: string, keepDays = 60) {
  const load = (): Record<string, T> => {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
      return v && typeof v === "object" ? (v as Record<string, T>) : {};
    } catch {
      return {};
    }
  };
  const save = (date: string, value: T): void => {
    const all = load();
    all[date] = value;
    const days = Object.keys(all).sort().slice(-keepDays);
    try {
      localStorage.setItem(key, JSON.stringify(Object.fromEntries(days.map((d) => [d, all[d]]))));
    } catch {
      // Storage blocked (private mode): the game still plays, it just won't be remembered
    }
  };
  return { load, save };
}

/** The site's root, two levels above a game's page. */
export const siteRoot = new URL("../../", document.baseURI).toString();
