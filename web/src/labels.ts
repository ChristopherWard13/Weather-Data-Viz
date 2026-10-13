// Cities and state abbreviations over the map (Q7): "the heaviest band sets
// up over Chicago" needs a Chicago on the map.
import type { GeoProjection } from "d3-geo";
import citiesJson from "../../config/cities.json";
import { config } from "./config";

interface City {
  name: string;
  lat: number;
  lon: number;
  tier: 1 | 2;
}

const CITIES = (citiesJson.cities as City[]).slice().sort((a, b) => a.tier - b.tier);
const STATES = config.regions.filter((r) => r.state).map((r) => ({ code: r.state!.code, at: r.state!.label }));

/** Views narrower than this (degrees of longitude) add the tier-2 cities. */
export const TIER2_SPAN = 25;
/** Views narrower than this show state abbreviations. */
export const STATES_SPAN = 30;

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

type StateLabel = { code: string; x: number; y: number; size: number };
type CityLabel = { name: string; x: number; y: number; size: number; tier: 1 | 2; align: "left" | "right" };

/**
 * Which labels go where, without overlapping: the big cities first, then
 * state abbreviations (they sit at fixed points), then the tier-2 cities. A
 * city's name goes right of its dot, or left when that's off the canvas or
 * taken. `span` is how many degrees of longitude the view shows; `px` scales
 * every size.
 */
export function placeLabels(
  project: (lon: number, lat: number) => [number, number] | null,
  width: number,
  height: number,
  span: number,
  measure: (text: string, size: number, weight: number) => number,
  px = 1,
): { states: StateLabel[]; cities: CityLabel[] } {
  const taken: Rect[] = [];
  const free = (r: Rect) => r.x0 >= 0 && r.y0 >= 0 && r.x1 <= width && r.y1 <= height && !taken.some((t) => overlaps(t, r));
  const states: StateLabel[] = [];
  const cities: CityLabel[] = [];

  const placeCities = (tier: 1 | 2) => {
    for (const c of CITIES) {
      if (c.tier !== tier) continue;
      const p = project(c.lon, c.lat);
      if (!p) continue;
      const size = (tier === 1 ? 12.5 : 11.5) * px;
      const dot = 3 * px, gap = 4 * px;
      const w = measure(c.name, size, tier === 1 ? 650 : 550);
      const dotRect = { x0: p[0] - dot, y0: p[1] - dot, x1: p[0] + dot, y1: p[1] + dot };
      const right = { x0: p[0] - dot, y0: p[1] - size * 0.6, x1: p[0] + dot + gap + w, y1: p[1] + size * 0.6 };
      const left = { x0: p[0] - dot - gap - w, y0: p[1] - size * 0.6, x1: p[0] + dot, y1: p[1] + size * 0.6 };
      if (!free(dotRect)) continue;
      const spot = free(right) ? right : free(left) ? left : null;
      if (!spot) continue;
      taken.push(spot);
      cities.push({ name: c.name, x: p[0], y: p[1], size, tier, align: spot === right ? "left" : "right" });
    }
  };

  placeCities(1);
  if (span < STATES_SPAN) {
    const size = 12.5 * px;
    for (const s of STATES) {
      const p = project(s.at[0], s.at[1]);
      if (!p) continue;
      const w = measure(s.code, size, 700) + 2 * px;
      const r = { x0: p[0] - w / 2, y0: p[1] - size / 2, x1: p[0] + w / 2, y1: p[1] + size / 2 };
      if (!free(r)) continue;
      taken.push(r);
      states.push({ code: s.code, x: p[0], y: p[1], size });
    }
  }
  if (span < TIER2_SPAN) placeCities(2);
  return { states, cities };
}

/** Draw the placed labels: dark text on a white halo, so they read over any shading. */
export function drawLabels(ctx: CanvasRenderingContext2D, proj: GeoProjection, width: number, height: number, span: number, px = 1): void {
  const measure = (text: string, size: number, weight: number) => {
    ctx.font = `${weight} ${size}px ${FONT}`;
    return ctx.measureText(text).width;
  };
  const { states, cities } = placeLabels((lon, lat) => proj([lon, lat]), width, height, span, measure, px);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  for (const s of states) {
    ctx.font = `700 ${s.size}px ${FONT}`;
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.strokeText(s.code, s.x, s.y);
    ctx.fillStyle = "rgba(51,65,85,0.72)";
    ctx.fillText(s.code, s.x, s.y);
  }
  for (const c of cities) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, 2.6 * px, 0, 2 * Math.PI);
    ctx.fillStyle = "#0f172a";
    ctx.lineWidth = 1.6 * px;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.fill();
    ctx.font = `${c.tier === 1 ? 650 : 550} ${c.size}px ${FONT}`;
    ctx.textAlign = c.align;
    const x = c.align === "left" ? c.x + 6.5 * px : c.x - 6.5 * px;
    ctx.lineWidth = 3.5 * px;
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.strokeText(c.name, x, c.y);
    ctx.fillStyle = "#0f172a";
    ctx.fillText(c.name, x, c.y);
  }
  ctx.restore();
}
