import { contours } from "d3-contour";
import type { GeoProjection } from "d3-geo";
import type { Grid } from "./types";
import { nearestGridPoint } from "./projection";
import { screenBearing } from "./barbs";

export interface IsoLine {
  value: number;
  /** [lon, lat] vertices */
  coords: [number, number][];
  closed: boolean;
}

/**
 * `passes` of a 3x3 binomial (1-2-1) filter, edges clamped.
 *
 * Frames are stored at a fixed step (1 kt, 1 °F, ...), so in flat parts of a
 * field a contour follows the quantization steps and comes out jagged, with
 * single-cell specks. One light pass (half-power scale ~0.5°, below the GFS
 * effective resolution) removes that; noisier fields such as sea-level
 * pressure over terrain take a few. Used for contouring only: shading, the
 * readout, and the stats use the raw values.
 */
export function smoothForContours(frame: ArrayLike<number>, nx: number, ny: number, passes = 1): Float32Array {
  let src = Float32Array.from(frame);
  const tmp = new Float32Array(nx * ny);
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const l = src[row + Math.max(0, i - 1)];
        const r = src[row + Math.min(nx - 1, i + 1)];
        tmp[row + i] = 0.25 * l + 0.5 * src[row + i] + 0.25 * r;
      }
    }
    for (let j = 0; j < ny; j++) {
      const up = Math.max(0, j - 1) * nx;
      const dn = Math.min(ny - 1, j + 1) * nx;
      const row = j * nx;
      for (let i = 0; i < nx; i++) out[row + i] = 0.25 * tmp[up + i] + 0.5 * tmp[row + i] + 0.25 * tmp[dn + i];
    }
    src = out;
  }
  return src;
}

/**
 * Contours of `values` (native grid, row 0 north) at each threshold, as
 * lon/lat polylines.
 *
 * d3-contour works in a pixel space where grid value (i, j) sits at
 * (i + 0.5, j + 0.5), and it closes every ring along the outer frame of the
 * grid (x = 0, x = nx, y = 0, y = ny). Those frame segments are not real
 * contours, so rings are cut there and kept as open polylines.
 */
export function contourLines(values: ArrayLike<number>, grid: Grid, thresholds: number[]): IsoLine[] {
  const { nx, ny } = grid;
  const gen = contours().size([nx, ny]).smooth(true);
  const out: IsoLine[] = [];
  for (const t of thresholds) {
    const mp = gen.contour(values as number[], t);
    for (const polygon of mp.coordinates) {
      for (const ring of polygon) {
        for (const part of splitAtFrame(ring as [number, number][], nx, ny)) {
          out.push({ value: t, closed: part.closed, coords: part.points.map(([x, y]) => toLonLat(x, y, grid)) });
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

// ---------------------------------------------------------------- drawing

export interface ContourStyle {
  color: string;
  width: number;
  dash?: number[];
  /** Label text for a contour value; omit for unlabeled lines. */
  label?: (v: number) => string;
  labelColor?: string;
  /** Minimum on-screen distance between labels of one line. */
  labelSpacing?: number;
  /** Per-value overrides, e.g. a bold freezing line among thin isotherms. */
  emphasize?: { value: number; color: string; width: number };
}

/** Optional flow arrows: chevrons along each line pointing downwind. */
export interface FlowArrows {
  /** Direction the wind blows FROM (degrees), native grid. */
  dir: Float32Array;
  grid: Grid;
  spacing?: number;
}

interface Placed {
  x: number;
  y: number;
  r: number;
}

/** Stroke contours, then label them along the line (and optionally add flow arrows). */
export function drawContours(
  ctx: CanvasRenderingContext2D,
  proj: GeoProjection,
  lines: IsoLine[],
  style: ContourStyle,
  width: number,
  height: number,
  arrows?: FlowArrows,
): void {
  const projected = lines.map((l) => ({
    value: l.value,
    pts: l.coords.map((c) => proj(c)!).filter(Boolean) as [number, number][],
  }));

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const strokeAll = (filter: (v: number) => boolean, color: string, w: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.setLineDash(style.dash ?? []);
    ctx.beginPath();
    for (const { value, pts } of projected) {
      if (!filter(value) || pts.length < 2) continue;
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    }
    ctx.stroke();
  };
  const em = style.emphasize;
  strokeAll((v) => !em || v !== em.value, style.color, style.width);
  if (em) {
    // White casing keeps the emphasized line readable over any shading.
    strokeAll((v) => v === em.value, "rgba(255,255,255,0.85)", em.width + 2.2);
    strokeAll((v) => v === em.value, em.color, em.width);
  }
  ctx.setLineDash([]);

  const placed: Placed[] = [];
  const withLen = projected.map((p) => ({ ...p, len: pathLength(p.pts) })).sort((a, b) => b.len - a.len);

  if (style.label) {
    ctx.font = "600 11px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const spacing = style.labelSpacing ?? 300;
    for (const { value, pts, len } of withLen) {
      if (len < 70) continue;
      const label = style.label(value);
      const w = ctx.measureText(label).width;
      const r = w / 2 + 7;
      const n = Math.max(1, Math.floor(len / spacing));
      for (let k = 0; k < n; k++) {
        const at = pointAt(pts, (len * (k + 0.5)) / n, 9);
        if (!at) continue;
        const { x, y, angle } = at;
        if (x < r || y < 8 || x > width - r || y > height - 8) continue;
        if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + r)) continue;
        placed.push({ x, y, r });
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(upright(angle));
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.strokeText(label, 0, 0);
        ctx.fillStyle = (em && value === em.value ? em.color : style.labelColor) ?? style.color;
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    }
  }

  if (arrows) drawFlowArrows(ctx, proj, withLen, arrows, placed, style.color);
  ctx.restore();
}

/** Chevrons along each line, pointing the way the wind blows there. */
function drawFlowArrows(
  ctx: CanvasRenderingContext2D,
  proj: GeoProjection,
  lines: { pts: [number, number][]; len: number }[],
  arrows: FlowArrows,
  placed: Placed[],
  color: string,
): void {
  const spacing = arrows.spacing ?? 120;
  const size = 6.5;
  for (const { pts, len } of lines) {
    if (len < 60) continue;
    const n = Math.max(1, Math.round(len / spacing));
    for (let k = 0; k < n; k++) {
      const at = pointAt(pts, (len * (k + 0.5)) / n, 6);
      if (!at) continue;
      if (placed.some((p) => Math.hypot(p.x - at.x, p.y - at.y) < p.r + size + 4)) continue;
      const ll = proj.invert!([at.x, at.y]);
      const gp = ll && nearestGridPoint(arrows.grid, ll[0], ll[1]);
      if (!ll || !gp) continue;
      const from = arrows.dir[gp.j * arrows.grid.nx + gp.i];
      const [wx, wy] = screenBearing(proj, ll[0], ll[1], (from + 180) % 360);
      let tx = Math.cos(at.angle), ty = Math.sin(at.angle);
      const dot = tx * wx + ty * wy;
      if (Math.abs(dot) < 0.55) continue; // flow crosses the line here: no clear direction to show
      if (dot < 0) { tx = -tx; ty = -ty; }
      placed.push({ x: at.x, y: at.y, r: size });
      const back = (s: number) => [
        at.x - tx * size + s * -ty * size * 0.62,
        at.y - ty * size + s * tx * size * 0.62,
      ];
      const [ax, ay] = back(1), [bx, by] = back(-1);
      const tipX = at.x + tx * size * 0.35, tipY = at.y + ty * size * 0.35;
      for (const [stroke, w] of [["rgba(255,255,255,0.9)", 4], [color, 1.8]] as const) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
    }
  }
}

function upright(angle: number): number {
  if (angle > Math.PI / 2) return angle - Math.PI;
  if (angle < -Math.PI / 2) return angle + Math.PI;
  return angle;
}

function pathLength(pts: [number, number][]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Point at arc length s and the line's direction, smoothed over ±span px. */
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
  return { x: c[0], y: c[1], angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}
