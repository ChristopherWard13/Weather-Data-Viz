import { geoConicConformal, type GeoProjection } from "d3-geo";
import type { Grid } from "./types";
import { config } from "./config";

/** Points along the domain boundary, densified so curved edges fit correctly. */
export function domainOutline(grid: Grid, stepDeg = 1): [number, number][] {
  const { lon_min: w, lon_max: e, lat_min: s, lat_max: n } = grid;
  const pts: [number, number][] = [];
  for (let x = w; x < e; x += stepDeg) pts.push([x, n]);
  for (let y = n; y > s; y -= stepDeg) pts.push([e, y]);
  for (let x = e; x > w; x -= stepDeg) pts.push([x, s]);
  for (let y = s; y < n; y += stepDeg) pts.push([w, y]);
  return pts;
}

export function baseProjection(): GeoProjection {
  return geoConicConformal()
    .parallels(config.projection.parallels)
    .rotate([-config.projection.centralMeridian, 0])
    .precision(0.2);
}

/** Width / height of the domain once projected. */
export function domainAspect(grid: Grid): number {
  const p = baseProjection().scale(1).translate([0, 0]);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const pt of domainOutline(grid, 0.5)) {
    const [x, y] = p(pt)!;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return (x1 - x0) / (y1 - y0);
}

/** Lambert conformal conic fit to the data domain within a width x height box. */
export function fitProjection(grid: Grid, width: number, height: number, pad = 6): GeoProjection {
  const outline = { type: "MultiPoint" as const, coordinates: domainOutline(grid, 0.5) };
  return baseProjection().fitExtent(
    [[pad, pad], [width - pad, height - pad]],
    outline,
  );
}

/**
 * Per-output-pixel lookup into the native grid, computed once per canvas size
 * by inverse projection. For pixel k, `index[k]` is the flat grid index of the
 * north-west corner of the enclosing cell (or -1 outside the domain) and
 * `fx[k]`, `fy[k]` are the bilinear weights toward the east and south.
 */
export interface Lookup {
  width: number;
  height: number;
  index: Int32Array;
  fx: Float32Array;
  fy: Float32Array;
}

export function buildLookup(proj: GeoProjection, grid: Grid, width: number, height: number): Lookup {
  const n = width * height;
  const index = new Int32Array(n).fill(-1);
  const fx = new Float32Array(n);
  const fy = new Float32Array(n);
  const { nx, ny, lon0, lat0, dlon, dlat } = grid;
  const invert = proj.invert!;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const ll = invert([px + 0.5, py + 0.5]);
      if (!ll) continue;
      const k = py * width + px;
      const gx = gridX(ll[0], lon0, dlon);
      const gy = (ll[1] - lat0) / dlat;
      if (gx < 0 || gx > nx - 1 || gy < 0 || gy > ny - 1) continue;
      const i = Math.min(Math.floor(gx), nx - 2);
      const j = Math.min(Math.floor(gy), ny - 2);
      index[k] = j * nx + i;
      fx[k] = gx - i;
      fy[k] = gy - j;
    }
  }
  return { width, height, index, fx, fy };
}

/** Fractional column for a longitude, tolerant of ±360 wrapping. */
export function gridX(lon: number, lon0: number, dlon: number): number {
  let d = lon - lon0;
  d = ((d % 360) + 540) % 360 - 180; // into [-180, 180)
  return d / dlon;
}

/** Nearest native grid point to a lon/lat, or null outside the domain. */
export function nearestGridPoint(
  grid: Grid,
  lon: number,
  lat: number,
): { i: number; j: number; lon: number; lat: number } | null {
  const gx = gridX(lon, grid.lon0, grid.dlon);
  const gy = (lat - grid.lat0) / grid.dlat;
  const i = Math.round(gx);
  const j = Math.round(gy);
  if (i < 0 || i >= grid.nx || j < 0 || j >= grid.ny) return null;
  return { i, j, lon: grid.lon0 + i * grid.dlon, lat: grid.lat0 + j * grid.dlat };
}
