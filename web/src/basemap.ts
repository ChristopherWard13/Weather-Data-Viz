import { geoPath, type GeoProjection } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryObject } from "topojson-specification";
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from "geojson";
import basemap from "./assets/basemap-50m.topo.json";
import { boxBounds, domainOutline } from "./projection";
import { config } from "./config";
import type { Grid } from "./types";

type Layer = "coastline" | "countries" | "states" | "lakes";

const topo = basemap as unknown as Topology<Record<Layer | "regions" | "statePolys", GeometryObject>>;
const layers = Object.fromEntries(
  (["coastline", "countries", "states", "lakes"] as Layer[]).map((k) => [
    k,
    feature(topo, topo.objects[k]) as unknown as Feature<Geometry>,
  ]),
) as Record<Layer, Feature<Geometry>>;

const STYLE: { layer: Layer; color: string; width: number }[] = [
  { layer: "states", color: "rgba(55, 55, 55, 0.72)", width: 0.85 },
  { layer: "lakes", color: "rgba(50, 50, 50, 0.78)", width: 0.9 },
  { layer: "countries", color: "rgba(40, 40, 40, 0.9)", width: 1.15 },
  { layer: "coastline", color: "rgba(40, 40, 40, 0.9)", width: 1.15 },
];

/** Coastlines, borders, and large lakes: thin neutral gray lines. */
export function drawBasemap(ctx: CanvasRenderingContext2D, proj: GeoProjection): void {
  const path = geoPath(proj, ctx);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const { layer, color, width } of STYLE) {
    ctx.beginPath();
    path(layers[layer]);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  ctx.restore();
}

export function drawDomainOutline(ctx: CanvasRenderingContext2D, proj: GeoProjection, grid: Grid): void {
  ctx.save();
  ctx.beginPath();
  domainOutline(grid, 0.25).forEach((pt, i) => {
    const [x, y] = proj(pt)!;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.strokeStyle = "rgba(30, 41, 59, 0.75)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

/** Clip subsequent drawing to the data domain. */
export function clipToDomain(ctx: CanvasRenderingContext2D, proj: GeoProjection, grid: Grid): void {
  const ring = domainOutline(grid, 0.25);
  ctx.beginPath();
  // Planar polygon through projected points; avoids spherical winding rules.
  ring.forEach((pt, i) => {
    const [x, y] = proj(pt)!;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.clip();
}

// ------------------------------------------------------------------ regions

type Ring = [number, number][];

type Rings = Map<string, { rings: Ring[]; box: [number, number, number, number] }>;

/** Rings of lon/lat per feature id, with their bounding box. */
function ringsOf(object: GeometryObject, id: (f: Feature) => string): Rings {
  return new Map(
    (feature(topo, object) as unknown as FeatureCollection<Polygon | MultiPolygon>).features.map((f) => {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      const rings = polys.flat() as Ring[];
      const pts = rings.flat();
      const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
      return [id(f), { rings, box: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)] }];
    }),
  );
}

/** Region click targets: US states merged by region. */
const regionRings = ringsOf(topo.objects.regions, (f) => String(f.id));
/** State click targets, by state region id (the postal code in lower case). */
const stateRings = ringsOf(topo.objects.statePolys, (f) => String(f.id).toLowerCase());

/**
 * The id whose rings contain a lon/lat, or null: a planar even-odd test on
 * lon/lat (the rings are small, and it doesn't depend on winding order).
 */
function hit(rings: Rings, lon: number, lat: number): string | null {
  for (const [id, { rings: rs, box }] of rings) {
    if (lon < box[0] || lon > box[2] || lat < box[1] || lat > box[3]) continue;
    let inside = false;
    for (const ring of rs) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    if (inside) return id;
  }
  return null;
}

/**
 * The region whose click target contains a lon/lat, or null: its states'
 * polygons, or its box for island regions.
 */
export function regionAt(lon: number, lat: number): string | null {
  for (const r of config.regions) {
    if (r.hit === "box" && lat >= r.box.lat[0] && lat <= r.box.lat[1] && lon >= r.box.lon[0] && lon <= r.box.lon[1]) return r.id;
  }
  return hit(regionRings, lon, lat);
}

/** The state (its region id) under a lon/lat, or null. */
export function stateAt(lon: number, lat: number): string | null {
  return hit(stateRings, lon, lat);
}

/** Outline a region's click target (projected point by point, like the domain clip). */
export function traceRegion(ctx: CanvasRenderingContext2D, proj: GeoProjection, id: string): void {
  ctx.beginPath();
  const r = config.regions.find((x) => x.id === id);
  const rings = r?.hit === "box" ? [domainOutline(boxBounds(r.box), 0.5)] : (r?.state ? stateRings : regionRings).get(id)?.rings ?? [];
  for (const ring of rings) {
    ring.forEach((pt, i) => {
      const [x, y] = proj(pt)!;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }
}
