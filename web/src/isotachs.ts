import { contours } from "d3-contour";
import type { GeoProjection } from "d3-geo";
import type { Grid } from "./types";

export interface IsoLine {
  value: number;
  /** [lon, lat] vertices */
  coords: [number, number][];
  closed: boolean;
}

/**
 * One pass of a 3x3 binomial (1-2-1) filter, edges clamped.
 *
 * Frames are stored to the nearest knot, so in flat parts of the field a
 * contour follows 1 kt steps and comes out jagged, with single-cell specks.
 * This light pass (half-power scale ~0.5 deg, below the GFS effective
 * resolution) removes that quantization texture. It is used for contouring only;
 * shading, the readout, and the stats use the raw values.
 */
export function smoothForContours(frame: ArrayLike<number>, nx: number, ny: number): Float32Array {
  const tmp = new Float32Array(nx * ny);
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      const l = frame[row + Math.max(0, i - 1)];
      const r = frame[row + Math.min(nx - 1, i + 1)];
      tmp[row + i] = 0.25 * l + 0.5 * frame[row + i] + 0.25 * r;
    }
  }
  for (let j = 0; j < ny; j++) {
    const up = Math.max(0, j - 1) * nx;
    const dn = Math.min(ny - 1, j + 1) * nx;
    const row = j * nx;
    for (let i = 0; i < nx; i++) out[row + i] = 0.25 * tmp[up + i] + 0.5 * tmp[row + i] + 0.25 * tmp[dn + i];
  }
  return out;
}

/**
 * Isotachs of `values` (native grid, row 0 north) at each threshold, as
 * lon/lat polylines.
 *
 * d3-contour works in a pixel space where grid value (i, j) sits at
 * (i + 0.5, j + 0.5), and it closes every ring along the outer frame of the
 * grid (x = 0, x = nx, y = 0, y = ny). Those frame segments are not real
 * isotachs, so rings are cut there and kept as open polylines.
 */
export function isotachLines(values: ArrayLike<number>, grid: Grid, thresholds: number[]): IsoLine[] {
  const { nx, ny } = grid;
  const gen = contours().size([nx, ny]).smooth(true);
  const out: IsoLine[] = [];
  for (const t of thresholds) {
    const mp = gen.contour(values as number[], t);
    for (const polygon of mp.coordinates) {
      for (const ring of polygon) {
        for (const part of splitAtFrame(ring as [number, number][], nx, ny)) {
          out.push({
            value: t,
            closed: part.closed,
            coords: part.points.map(([x, y]) => toLonLat(x, y, grid)),
          });
        }
      }
    }
  }
  return out;
}

export function toLonLat(x: number, y: number, grid: Grid): [number, number] {
  return [grid.lon0 + (x - 0.5) * grid.dlon, grid.lat0 + (y - 0.5) * grid.dlat];
}

function onFrame([x, y]: [number, number], nx: number, ny: number): boolean {
  return x <= 0 || x >= nx || y <= 0 || y >= ny;
}

export function splitAtFrame(
  ring: [number, number][],
  nx: number,
  ny: number,
): { points: [number, number][]; closed: boolean }[] {
  // Rings come closed (first == last); drop the duplicate.
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.slice(0, -1)
    : ring.slice();
  const start = pts.findIndex((p) => onFrame(p, nx, ny));
  if (start < 0) return pts.length > 2 ? [{ points: [...pts, pts[0]], closed: true }] : [];
  const rotated = [...pts.slice(start), ...pts.slice(0, start)];
  const parts: { points: [number, number][]; closed: boolean }[] = [];
  let run: [number, number][] = [];
  for (const p of rotated) {
    if (onFrame(p, nx, ny)) {
      if (run.length > 1) parts.push({ points: run, closed: false });
      run = [];
    } else {
      run.push(p);
    }
  }
  if (run.length > 1) parts.push({ points: run, closed: false });
  return parts;
}

interface Placed {
  x: number;
  y: number;
  r: number;
}

/** Stroke isotachs and label them in kt along the line. */
export function drawIsotachs(
  ctx: CanvasRenderingContext2D,
  proj: GeoProjection,
  lines: IsoLine[],
  width: number,
  height: number,
): void {
  const projected = lines.map((l) => ({
    value: l.value,
    pts: l.coords.map((c) => proj(c)!).filter(Boolean) as [number, number][],
  }));

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1.35;
  ctx.beginPath();
  for (const { pts } of projected) {
    if (pts.length < 2) continue;
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  }
  ctx.stroke();

  ctx.font = "600 11px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const placed: Placed[] = [];
  const longestFirst = projected
    .map((p) => ({ ...p, len: pathLength(p.pts) }))
    .sort((a, b) => b.len - a.len);
  for (const { value, pts, len } of longestFirst) {
    if (len < 70) continue;
    const label = String(value);
    const w = ctx.measureText(label).width;
    const r = w / 2 + 7;
    const spacing = 300;
    const n = Math.max(1, Math.floor(len / spacing));
    for (let k = 0; k < n; k++) {
      const s = (len * (k + 0.5)) / n;
      const at = pointAt(pts, s, 9);
      if (!at) continue;
      const { x, y, angle } = at;
      if (x < r || y < 8 || x > width - r || y > height - 8) continue;
      if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + r)) continue;
      placed.push({ x, y, r });
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.strokeText(label, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}

function pathLength(pts: [number, number][]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Point at arc length s, with the line's direction smoothed over ±span px, kept upright. */
function pointAt(pts: [number, number][], s: number, span: number) {
  const at = (target: number): [number, number] | null => {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (acc + seg >= target) {
        const t = seg ? (target - acc) / seg : 0;
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
      }
      acc += seg;
    }
    return null;
  };
  const c = at(s), a = at(Math.max(0, s - span)), b = at(s + span);
  if (!c || !a || !b) return null;
  let angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;
  return { x: c[0], y: c[1], angle };
}
