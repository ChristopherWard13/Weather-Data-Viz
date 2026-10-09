import { geoPath, type GeoProjection } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryObject } from "topojson-specification";
import type { Feature, Geometry } from "geojson";
import basemap from "./assets/basemap-50m.topo.json";
import { domainOutline } from "./projection";
import type { Grid } from "./types";

type Layer = "coastline" | "countries" | "states" | "lakes";

const topo = basemap as unknown as Topology<Record<Layer, GeometryObject>>;
const layers = Object.fromEntries(
  (["coastline", "countries", "states", "lakes"] as Layer[]).map((k) => [
    k,
    feature(topo, topo.objects[k]) as unknown as Feature<Geometry>,
  ]),
) as Record<Layer, Feature<Geometry>>;

const STYLE: { layer: Layer; color: string; width: number }[] = [
  { layer: "states", color: "rgba(70, 70, 70, 0.55)", width: 0.6 },
  { layer: "lakes", color: "rgba(60, 60, 60, 0.7)", width: 0.7 },
  { layer: "countries", color: "rgba(55, 55, 55, 0.85)", width: 0.9 },
  { layer: "coastline", color: "rgba(55, 55, 55, 0.85)", width: 0.9 },
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
