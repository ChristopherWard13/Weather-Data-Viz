import type { GeoProjection } from "d3-geo";

/**
 * Unit screen vector for a compass bearing (degrees clockwise from true
 * north) at a lon/lat. On a conic projection "up" is only north along the
 * central meridian, so this projects a short step along the bearing instead
 * of assuming a fixed rotation.
 */
export function screenBearing(proj: GeoProjection, lon: number, lat: number, bearing: number): [number, number] {
  const rad = (bearing * Math.PI) / 180;
  const step = 0.2;
  const p0 = proj([lon, lat])!;
  const p1 = proj([lon + (Math.sin(rad) * step) / Math.cos((lat * Math.PI) / 180), lat + Math.cos(rad) * step])!;
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const n = Math.hypot(dx, dy) || 1;
  return [dx / n, dy / n];
}

/** Pennants (50 kt), full barbs (10 kt), half barbs (5 kt), after rounding to 5 kt. */
export function barbCounts(speedKt: number): { pennants: number; barbs: number; half: number; calm: boolean } {
  const s = Math.round(speedKt / 5) * 5;
  if (s < 5) return { pennants: 0, barbs: 0, half: 0, calm: true };
  const pennants = Math.floor(s / 50);
  const barbs = Math.floor((s - 50 * pennants) / 10);
  const half = (s - 50 * pennants - 10 * barbs) / 5;
  return { pennants, barbs, half, calm: false };
}

/**
 * One wind barb at (x, y). The staff points toward where the wind comes from
 * (`toward` is that unit screen vector); feathers go on the clockwise side,
 * the Northern Hemisphere convention.
 */
export function drawBarb(ctx: CanvasRenderingContext2D, x: number, y: number, toward: [number, number], speedKt: number, size = 22): void {
  const { pennants, barbs, half, calm } = barbCounts(speedKt);
  if (calm) {
    ctx.beginPath();
    ctx.arc(x, y, 2.6, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  const [sx, sy] = toward;
  const [fx, fy] = [-sy, sx]; // clockwise side on screen (y down)
  const feather = size * 0.45;
  const gap = size * 0.16;
  const tipX = x + sx * size, tipY = y + sy * size;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(tipX, tipY);
  let d = 0; // distance back from the tip
  for (let p = 0; p < pennants; p++) {
    const ax = tipX - sx * d, ay = tipY - sy * d;
    const bx = tipX - sx * (d + gap * 1.4), by = tipY - sy * (d + gap * 1.4);
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + fx * feather, ay + fy * feather);
    ctx.lineTo(bx, by);
    ctx.closePath();
    d += gap * 1.6;
  }
  if (pennants && !barbs && !half) d += gap * 0.2;
  for (let b = 0; b < barbs; b++) {
    const ax = tipX - sx * d, ay = tipY - sy * d;
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + fx * feather + sx * feather * 0.35, ay + fy * feather + sy * feather * 0.35);
    d += gap;
  }
  if (half) {
    if (!pennants && !barbs) d += gap; // a lone half barb sits in from the tip
    const ax = tipX - sx * d, ay = tipY - sy * d;
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + fx * feather * 0.5 + sx * feather * 0.18, ay + fy * feather * 0.5 + sy * feather * 0.18);
  }
  ctx.stroke();
  if (pennants) {
    // Fill only the pennant triangles
    ctx.beginPath();
    let dd = 0;
    for (let p = 0; p < pennants; p++) {
      const ax = tipX - sx * dd, ay = tipY - sy * dd;
      const bx = tipX - sx * (dd + gap * 1.4), by = tipY - sy * (dd + gap * 1.4);
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax + fx * feather, ay + fy * feather);
      ctx.lineTo(bx, by);
      ctx.closePath();
      dd += gap * 1.6;
    }
    ctx.fill();
  }
}

export interface BarbField {
  speed: Float32Array;
  /** Degrees the wind blows FROM. */
  dir: Float32Array;
  minSpeed?: number;
}

/** Barbs on a regular screen lattice, sampled at the nearest grid point. */
export function drawBarbs(
  ctx: CanvasRenderingContext2D,
  proj: GeoProjection,
  sampleAt: (x: number, y: number) => { k: number; lon: number; lat: number } | null,
  field: BarbField,
  width: number,
  height: number,
  spacing: number,
  color: string,
): void {
  ctx.save();
  ctx.lineWidth = 1.1;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  const size = Math.min(24, spacing * 0.72);
  for (let y = spacing / 2; y < height; y += spacing) {
    for (let x = spacing / 2; x < width; x += spacing) {
      const s = sampleAt(x, y);
      if (!s) continue;
      const v = field.speed[s.k];
      if (field.minSpeed !== undefined && v < field.minSpeed) continue;
      drawBarb(ctx, x, y, screenBearing(proj, s.lon, s.lat, field.dir[s.k]), v, size);
    }
  }
  ctx.restore();
}
