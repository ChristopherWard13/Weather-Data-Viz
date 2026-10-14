// Presentation frames: the layout of each silhouette in a fixed 1920 × 1080
// (or 1080 × 1920) space, and drawing a whole frame (header, slots, corner
// labels, color bars, credit) onto one canvas, so a capture or an export
// carries everything.
import { colorbarHeight, drawColorbar } from "./colorbar";
import type { SlotBar, SlotFrame } from "./slot";
import { dayLabel, fmtValid, type Zone } from "./time";

export type Orientation = "16:9" | "9:16";
export type SilhouetteId = "single" | "pair" | "quad" | "tall" | "stack";

export interface Silhouette {
  id: SilhouetteId;
  label: string;
  frame: Orientation;
  cols: number;
  rows: number;
}

/** In picker order. Three stacked in 9:16 leaves no room for titles. */
export const SILHOUETTES: Silhouette[] = [
  { id: "single", label: "One map", frame: "16:9", cols: 1, rows: 1 },
  { id: "pair", label: "Two side by side", frame: "16:9", cols: 2, rows: 1 },
  { id: "quad", label: "Four", frame: "16:9", cols: 2, rows: 2 },
  { id: "tall", label: "One map", frame: "9:16", cols: 1, rows: 1 },
  { id: "stack", label: "Two stacked", frame: "9:16", cols: 1, rows: 2 },
];

export const silhouetteById = (id: string | null | undefined) => SILHOUETTES.find((s) => s.id === id);
export const slotCount = (s: Silhouette) => s.cols * s.rows;

export function frameSize(o: Orientation): { w: number; h: number } {
  return o === "16:9" ? { w: 1920, h: 1080 } : { w: 1080, h: 1920 };
}

/**
 * Where Shorts draws its own buttons and captions over a 1080 × 1920 frame,
 * measured 2026-10-12 on m.youtube.com/shorts at 360 × 640 (× 3): the top bar
 * is 144 px; the like, comment and share column covers the right 156 px from
 * y = 1188 down; the channel line and a one-line caption start 252 px above
 * the bottom, and `bottom` leaves room for a second caption line. The 9:16
 * header and color bar stay clear of them; the guide (G) shades them.
 */
export const SHORTS_SAFE = { top: 144, right: 156, rightFrom: 1188, bottom: 300, left: 48 };
// `left` is the captions' margin, kept by the header and color bar; nothing covers the left edge above them.

/**
 * Map labels and lines are drawn this much larger than on the site, so they
 * stay readable in a 480p downscale of a 1080p frame (Q6): a 12 px contour
 * label becomes about 16 px.
 */
export const MAP_SCALE = 1.3;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SlotBox {
  /** The slot's whole area. */
  rect: Rect;
  /** The map within it. */
  map: Rect;
  /** Its own color bar under the map, when the bars aren't shared. */
  bar: Rect | null;
}

export interface FrameLayout {
  silhouette: Silhouette;
  w: number;
  h: number;
  header: Rect;
  slots: SlotBox[];
  /** One color bar for every slot, when they'd all draw the same. */
  sharedBar: Rect | null;
}

const PAD = 20;
const GAP = 12;
const HEADER_H = 66;

/** Do the slots' color bars all draw the same, so one can serve them all? */
export function barsShared(bars: (SlotBar | null)[]): boolean {
  return bars.length > 0 && bars.every((b) => b && b.key === bars[0]!.key);
}

/** Height a color bar block takes, with its caption and margin. */
const barBlock = (b: SlotBar) => colorbarHeight(b.spec, "caption") + 10;

/**
 * Lay out a frame from what each slot's color bar will be (from its view,
 * not from what loaded), so the maps hold still through a loop even where a
 * slot's run ends. Per-slot bars are all as tall as the tallest, so the maps
 * line up.
 */
export function layoutFrame(sil: Silhouette, bars: (SlotBar | null)[]): FrameLayout {
  const { w, h } = frameSize(sil.frame);
  const tall = sil.frame === "9:16";
  const inset = tall ? SHORTS_SAFE : { top: 0, right: 0, bottom: 0, left: 0 };
  // Shorts' right-hand buttons start low, so the header has the full width
  const header: Rect = { x: PAD + inset.left, y: PAD + inset.top, w: w - 2 * PAD - inset.left, h: tall ? HEADER_H + 54 : HEADER_H };

  const shared = barsShared(bars);
  const barW = Math.min(1100, w - 2 * PAD - inset.left - inset.right);
  const sharedH = shared ? barBlock(bars[0]!) : 0;
  const bottom = h - PAD - inset.bottom;
  const sharedBar: Rect | null = shared ? { x: (w - barW) / 2 + (inset.left - inset.right) / 2, y: bottom - sharedH + 10, w: barW, h: sharedH - 10 } : null;

  // Maps run edge to edge across a tall frame (under Shorts' buttons is still map)
  const area: Rect = tall
    ? { x: 0, y: header.y + header.h + GAP, w, h: 0 }
    : { x: PAD, y: header.y + header.h + GAP, w: w - 2 * PAD, h: 0 };
  area.h = (shared ? sharedBar!.y - GAP : bottom) - area.y;

  const own = shared ? 0 : Math.max(0, ...bars.map((b) => (b ? barBlock(b) : 0)));
  const cw = (area.w - GAP * (sil.cols - 1)) / sil.cols;
  const ch = (area.h - GAP * (sil.rows - 1)) / sil.rows;
  const slots: SlotBox[] = [];
  for (let r = 0; r < sil.rows; r++) {
    for (let c = 0; c < sil.cols; c++) {
      const rect = { x: area.x + c * (cw + GAP), y: area.y + r * (ch + GAP), w: cw, h: ch };
      const map = { ...rect, h: rect.h - own };
      const inner = tall ? Math.min(rect.w - inset.left - inset.right, barW) : Math.min(rect.w - 24, barW);
      const bar = own ? { x: rect.x + (rect.w - inner) / 2 + (tall ? (inset.left - inset.right) / 2 : 0), y: map.y + map.h + 8, w: inner, h: own - 10 } : null;
      slots.push({ rect, map, bar });
    }
  }
  return { silhouette: sil, w, h, header, slots, sharedBar };
}

/** Sources to credit for the slots shown: "Data: NOAA, ECMWF (CC BY 4.0; modified)". */
export function creditLine(frames: (SlotFrame | null)[]): string {
  const credits = new Set<string>();
  for (const f of frames) {
    if (!f) continue;
    credits.add(f.product.cfg.credit);
    if (f.other) credits.add(f.other.cfg.credit);
  }
  return credits.size ? `Data: ${[...credits].join(", ")}` : "";
}

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const INK = "#0f172a";
const MUTED = "#475569";
const BG = "#eef2f6";

/** `text` cut to `max` pixels wide, with an ellipsis. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

function roundRect(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, radius);
}

export interface FrameText {
  valid: Date;
  zone: Zone;
  now: Date;
}

/**
 * Draw a whole frame at `k` canvas pixels per layout pixel. `maps[i]` is slot
 * i's map canvas, already drawn at its map rect's size times `k`; null
 * leaves the slot empty with `frames[i]?.status` or a prompt.
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  k: number,
  layout: FrameLayout,
  frames: (SlotFrame | null)[],
  maps: (HTMLCanvasElement | null)[],
  text: FrameText,
  opts: { guide?: boolean; selected?: number | null; empty?: string } = {},
): void {
  ctx.save();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, layout.w, layout.h);
  drawHeader(ctx, layout, frames, text);

  layout.slots.forEach((box, i) => {
    const f = frames[i] ?? null;
    const m = box.map;
    ctx.fillStyle = "#fff";
    ctx.fillRect(box.rect.x, box.rect.y, box.rect.w, box.rect.h);
    const canvas = maps[i];
    if (canvas) ctx.drawImage(canvas, m.x, m.y, m.w, m.h);
    ctx.strokeStyle = "rgba(15,23,42,0.22)";
    ctx.lineWidth = 1;
    ctx.strokeRect(m.x + 0.5, m.y + 0.5, m.w - 1, m.h - 1);
    if (f) drawCornerLabel(ctx, m, f);
    // Empty: centered over the map; no comparison: a note under the label
    if (!f) drawStatus(ctx, m, opts.empty ?? "Loading…");
    else if (f.status) drawStatus(ctx, m, f.status, !!f.scene);
    if (box.bar && f?.scene) drawColorbar(ctx, f.scene.colorbar, box.bar.x, box.bar.y, box.bar.w, f.scene.caption);
    if (opts.selected === i) {
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 4;
      ctx.strokeRect(box.rect.x + 2, box.rect.y + 2, box.rect.w - 4, box.rect.h - 4);
    }
  });

  // The shared bar is any drawn slot's: they're the same by construction
  const drawn = frames.find((f) => f?.scene)?.scene;
  if (layout.sharedBar && drawn) {
    const b = layout.sharedBar;
    drawColorbar(ctx, drawn.colorbar, b.x, b.y, b.w, drawn.caption);
  }
  if (opts.guide && layout.silhouette.frame === "9:16") drawSafeGuide(ctx, layout);
  ctx.restore();
}

function drawHeader(ctx: CanvasRenderingContext2D, layout: FrameLayout, frames: (SlotFrame | null)[], text: FrameText): void {
  const hd = layout.header;
  const tall = layout.silhouette.frame === "9:16";
  const fields = new Set(frames.map((f) => f?.field ?? null));
  const field = fields.size === 1 && !fields.has(null) ? [...fields][0] : null;
  const day = dayLabel(text.now, text.valid, text.zone);
  const when = [fmtValid(text.valid, text.zone), day].filter(Boolean).join(" · ");
  const credit = creditLine(frames);

  ctx.textBaseline = "alphabetic";
  // The mark and credit: right in 16:9, under the title in 9:16
  ctx.textAlign = "right";
  const markW = tall ? 0 : 360;
  if (!tall) {
    ctx.font = `800 26px ${FONT}`;
    ctx.fillStyle = "#1d4ed8";
    ctx.fillText("runtorunwx.com", hd.x + hd.w, hd.y + 30);
    ctx.fillStyle = MUTED;
    // One line under the mark, two 15 px apart, or (four sources, e.g. GFS, ECMWF, GEM and ICON)
    // three 13 px apart: the last baseline is 70 px down, past the 66 px header but clear of the
    // maps, which begin 12 px below it. Four lines would reach them (a fifth source)
    creditLines(ctx, credit, markW).forEach((line, i, all) => ctx.fillText(line, hd.x + hd.w,
      hd.y + (all.length === 1 ? 54 : all.length === 2 ? 48 + i * 15 : 44 + i * 13)));
  }
  ctx.textAlign = "left";
  const maxW = hd.w - markW - (tall ? 0 : 24);
  if (field) {
    ctx.font = `800 30px ${FONT}`;
    ctx.fillStyle = INK;
    ctx.fillText(fitText(ctx, field, maxW), hd.x, hd.y + 30);
    ctx.font = `600 21px ${FONT}`;
    ctx.fillStyle = "#1e293b";
    ctx.fillText(fitText(ctx, when, maxW), hd.x, hd.y + 58);
  } else {
    ctx.font = `800 30px ${FONT}`;
    ctx.fillStyle = INK;
    ctx.fillText(fitText(ctx, when, maxW), hd.x, hd.y + 40);
  }
  if (tall) {
    ctx.font = `800 24px ${FONT}`;
    ctx.fillStyle = "#1d4ed8";
    const y = hd.y + (field ? 92 : 74);
    ctx.fillText("runtorunwx.com", hd.x, y);
    ctx.fillStyle = MUTED;
    creditLines(ctx, credit, hd.w).forEach((line, i) => ctx.fillText(line, hd.x, y + 20 + i * 16));
  }
}

/**
 * The credit in as few lines as fit `max`: 14 px, or 12.5 px on lines broken
 * between sources (three in 16:9 when four sources are shown). Never cut: the
 * licences need it whole.
 * Leaves the font set.
 */
function creditLines(ctx: CanvasRenderingContext2D, credit: string, max: number): string[] {
  ctx.font = `500 14px ${FONT}`;
  if (ctx.measureText(credit).width <= max) return [credit];
  ctx.font = `500 12.5px ${FONT}`;
  if (ctx.measureText(credit).width <= max) return [credit];
  const parts = credit.split(", ");
  const lines: string[] = [];
  for (const p of parts) {
    const last = lines.length ? `${lines[lines.length - 1]}, ${p}` : p;
    if (lines.length && ctx.measureText(last).width <= max) lines[lines.length - 1] = last;
    else lines.push(p);
  }
  return lines;
}

/** Everything about the slot's forecast, top left of its map: model, run, field and mode, then when. */
function drawCornerLabel(ctx: CanvasRenderingContext2D, m: Rect, f: SlotFrame): void {
  const max = m.w - 40;
  ctx.font = `750 19px ${FONT}`;
  const title = fitText(ctx, f.title, max);
  const tw = ctx.measureText(title).width;
  ctx.font = `550 16px ${FONT}`;
  const when = fitText(ctx, f.when, max);
  const ww = ctx.measureText(when).width;
  const box = { x: m.x + 10, y: m.y + 10, w: Math.max(tw, ww) + 20, h: 58 };
  roundRect(ctx, box, 6);
  ctx.fillStyle = "rgba(255,255,255,0.93)";
  ctx.fill();
  ctx.strokeStyle = "rgba(15,23,42,0.18)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `750 19px ${FONT}`;
  ctx.fillStyle = INK;
  ctx.fillText(title, box.x + 10, box.y + 25);
  ctx.font = `550 16px ${FONT}`;
  ctx.fillStyle = "#334155";
  ctx.fillText(when, box.x + 10, box.y + 48);
}

/** Why a slot's map is empty (centered), or a note under its label when it still draws. */
function drawStatus(ctx: CanvasRenderingContext2D, m: Rect, text: string, small = false): void {
  ctx.font = `600 ${small ? 15 : 18}px ${FONT}`;
  const t = fitText(ctx, text, m.w - 60);
  const tw = ctx.measureText(t).width;
  const box = small
    ? { x: m.x + 10, y: m.y + 74, w: tw + 20, h: 28 }
    : { x: m.x + (m.w - tw - 32) / 2, y: m.y + m.h / 2 - 20, w: tw + 32, h: 40 };
  roundRect(ctx, box, small ? 6 : 20);
  ctx.fillStyle = small ? "rgba(254,243,199,0.95)" : "rgba(15,23,42,0.82)";
  ctx.fill();
  ctx.fillStyle = small ? "#78350f" : "#fff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(t, box.x + (small ? 10 : 16), box.y + box.h / 2);
  ctx.textBaseline = "alphabetic";
}

/** Shorts' own buttons and captions, outlined; never exported. */
function drawSafeGuide(ctx: CanvasRenderingContext2D, layout: FrameLayout): void {
  const s = SHORTS_SAFE;
  const bottom = layout.h - s.bottom;
  ctx.save();
  ctx.fillStyle = "rgba(220,38,38,0.16)";
  ctx.fillRect(0, 0, layout.w, s.top);
  ctx.fillRect(0, bottom, layout.w, s.bottom);
  ctx.fillRect(layout.w - s.right, s.rightFrom, s.right, bottom - s.rightFrom);
  // The safe area's outline, stepping in where the buttons start
  ctx.setLineDash([10, 8]);
  ctx.strokeStyle = "rgba(220,38,38,0.85)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(s.left, s.top);
  ctx.lineTo(layout.w, s.top);
  ctx.moveTo(layout.w - s.right, s.rightFrom);
  ctx.lineTo(layout.w - s.right, bottom);
  ctx.lineTo(0, bottom);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `700 20px ${FONT}`;
  ctx.fillStyle = "rgba(153,27,27,0.95)";
  ctx.textAlign = "center";
  ctx.fillText("Shorts covers the shaded edges (guide only, not exported)", layout.w / 2, layout.h - s.bottom + 34);
  ctx.restore();
}
