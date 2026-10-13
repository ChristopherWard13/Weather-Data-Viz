import { PTYPE_COLORS, PTYPE_LABELS, PTYPE_UNSPECIFIED, QPF_BINS, tickStep, type ColorFn } from "./palettes";

export type ColorbarSpec =
  | {
      kind: "continuous";
      color: ColorFn;
      min: number;
      max: number;
      ticks: number[];
      format?: (v: number) => string;
      /** Pointed ends show that values beyond the range are clamped. */
      extend: "both" | "max" | "none";
    }
  /** `scale` converts a stored difference to the unit shown (kt to mph: 1.15), so ticks fall on round shown values. */
  | { kind: "diverging"; color: ColorFn; limit: number; format?: (v: number) => string; scale?: number }
  /**
   * Precipitation by type. `untyped`: the model has no type output (one
   * neutral row). `untypedModel`: side by side with a model that has types,
   * the type rows plus a neutral row named for the model without.
   */
  | { kind: "precip"; untyped?: boolean; untypedModel?: string }
  | { kind: "disabled"; color: ColorFn; limit: number; scale?: number };

const NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export function fmtSigned(v: number, digits = 0): string {
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return (0).toFixed(digits);
  return v > 0 ? `+${s}` : `−${s}`;
}

/** Decimals that label every multiple of `step` exactly (2.5 needs one). */
function decimals(step: number): number {
  return Number.isInteger(step) ? 0 : Number.isInteger(Math.round(step * 1e6) / 1e5) ? 1 : 2;
}

/**
 * A ±limit bar's ticks (stored values) and labels in the shown unit: `scale`
 * converts a stored difference to it, so ticks fall on round shown values.
 */
export function divergingTicks(limit: number, scale = 1): { ticks: number[]; labels: string[] } {
  const step = tickStep(limit * scale);
  const d = decimals(step);
  const n = Math.floor((limit * scale) / step + 1e-9);
  const ticks: number[] = [];
  for (let k = -n; k <= n; k++) ticks.push((k * step) / scale);
  return { ticks, labels: ticks.map((v) => fmtSigned(v * scale, d)) };
}

let gradId = 0;

interface Bar {
  min: number;
  max: number;
  ticks: number[];
  fmt: (v: number) => string;
  color: ColorFn;
  extend: "both" | "max" | "none";
  /** The tick to emphasize and to always label (a diverging bar's 0), or -1. */
  zeroIdx: number;
}

/** A continuous or diverging bar's range, ticks and labels. */
function barOf(spec: Exclude<ColorbarSpec, { kind: "precip" }>): Bar {
  if (spec.kind === "continuous") {
    const { min, max, ticks, color } = spec;
    return { min, max, ticks, color, fmt: spec.format ?? ((v) => String(v)), extend: spec.extend, zeroIdx: -1 };
  }
  const limit = spec.limit;
  const scale = spec.scale ?? 1;
  const t = divergingTicks(limit, scale);
  const d = decimals(tickStep(limit * scale));
  const fmt = spec.kind === "diverging" && spec.format ? spec.format : (v: number) => fmtSigned(v * scale, d);
  return {
    min: -limit, max: limit, color: spec.color, ticks: t.ticks, fmt, extend: "both",
    zeroIdx: t.ticks.findIndex((x) => Math.abs(x) < 1e-9),
  };
}

/** Render a colorbar into `host`, laid out in real pixels so labels keep their size. */
export function renderColorbar(host: HTMLElement, spec: ColorbarSpec): void {
  if (spec.kind === "precip") {
    renderPrecipLegend(host, !!spec.untyped, spec.untypedModel);
    return;
  }
  const W = Math.max(280, Math.round(host.clientWidth || 1000));
  const H = 44, padX = 14, barY = 4, barH = 14, tip = 11;
  const { min, max, ticks, fmt, color, extend, zeroIdx } = barOf(spec);
  const x0 = padX + (extend !== "none" ? tip : 0);
  const x1 = W - padX - (extend === "both" || extend === "max" ? tip : 0);
  const xOf = (v: number) => x0 + ((v - min) / (max - min)) * (x1 - x0);

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `colorbar from ${fmt(min)} to ${fmt(max)}` });
  svg.classList.toggle("disabled", spec.kind === "disabled");
  const id = `cb-grad-${++gradId}`;
  const defs = el("defs", {});
  const grad = el("linearGradient", { id, x1: 0, x2: 1, y1: 0, y2: 0 });
  const N = 96;
  for (let i = 0; i <= N; i++) {
    grad.appendChild(el("stop", { offset: i / N, "stop-color": color(min + ((max - min) * i) / N) }));
  }
  defs.appendChild(grad);
  svg.appendChild(defs);

  let outline = `M${x0},${barY}`;
  if (extend === "both") {
    svg.appendChild(el("path", { d: `M${x0},${barY} L${x0 - tip},${barY + barH / 2} L${x0},${barY + barH} Z`, fill: color(min) }));
    outline += ` L${x0 - tip},${barY + barH / 2} L${x0},${barY + barH}`;
  } else {
    outline += ` L${x0},${barY + barH}`;
  }
  svg.appendChild(el("rect", { x: x0, y: barY, width: x1 - x0, height: barH, fill: `url(#${id})` }));
  outline += ` L${x1},${barY + barH}`;
  if (extend !== "none") {
    svg.appendChild(el("path", { d: `M${x1},${barY} L${x1 + tip},${barY + barH / 2} L${x1},${barY + barH} Z`, fill: color(max) }));
    outline += ` L${x1 + tip},${barY + barH / 2} L${x1},${barY}`;
  } else {
    outline += ` L${x1},${barY}`;
  }
  svg.appendChild(el("path", { d: `${outline} Z`, fill: "none", stroke: "rgba(0,0,0,0.45)", "stroke-width": 1 }));

  // Thin labels to keep ~40 px apart; for diverging bars 0 is always labeled.
  const spacing = ticks.length > 1 ? (xOf(ticks[1]) - xOf(ticks[0])) : 100;
  const every = Math.max(1, Math.ceil(40 / spacing));
  // Only a diverging bar has a meaningful center to emphasize.
  ticks.forEach((v, k) => {
    const x = xOf(v);
    svg.appendChild(el("line", { x1: x, x2: x, y1: barY + barH, y2: barY + barH + 4, stroke: "rgba(0,0,0,0.6)" }));
    if (Math.abs(k - (zeroIdx >= 0 ? zeroIdx : 0)) % every !== 0) return;
    const t = el("text", { x, y: barY + barH + 17, "text-anchor": "middle", class: k === zeroIdx ? "cb-tick zero" : "cb-tick" });
    t.textContent = fmt(v);
    svg.appendChild(t);
  });

  host.replaceChildren(svg);
  host.dataset.min = String(min);
  host.dataset.max = String(max);
  host.dataset.kind = spec.kind;
}

/**
 * Rows of discrete swatches, one row per precipitation type. A model with no
 * type output gets one neutral row, and the legend says type isn't available.
 */
function renderPrecipLegend(host: HTMLElement, untyped: boolean, untypedModel?: string): void {
  const wrap = document.createElement("div");
  wrap.className = "ptype-legend";
  wrap.style.setProperty("--bins", String(QPF_BINS.length));
  const codes = untyped ? [PTYPE_UNSPECIFIED] : untypedModel ? [1, 2, 3, 4, PTYPE_UNSPECIFIED] : [1, 2, 3, 4];
  for (const code of codes) {
    const label = document.createElement("span");
    label.className = "ptype-label";
    label.textContent = code !== PTYPE_UNSPECIFIED ? PTYPE_LABELS[code] : untypedModel ?? "Precip";
    wrap.appendChild(label);
    for (const c of PTYPE_COLORS[code]) {
      const sw = document.createElement("span");
      sw.className = "ptype-swatch";
      sw.style.background = c;
      wrap.appendChild(sw);
    }
  }
  wrap.appendChild(document.createElement("span"));
  for (const b of QPF_BINS) {
    const t = document.createElement("span");
    t.className = "ptype-tick";
    t.textContent = b < 1 ? String(b).replace(/^0/, "") : String(b);
    wrap.appendChild(t);
  }
  const parts: HTMLElement[] = [wrap];
  if (untyped || untypedModel) {
    const note = document.createElement("p");
    note.className = "ptype-note";
    note.textContent = untyped
      ? "Precipitation type isn't available: this model doesn't output it."
      : `${untypedModel} doesn't output precipitation type, so its precipitation is grey.`;
    parts.push(note);
  }
  host.replaceChildren(...parts);
  host.dataset.kind = untyped ? "precip-untyped" : untypedModel ? "precip-mixed" : "precip";
}

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

/**
 * Draw a colorbar onto a canvas (presentation frames and exports carry their
 * own): `w` wide at (x, y), sizes in layout pixels times `px`, with `caption`
 * under it. Returns the height used.
 */
export function drawColorbar(
  ctx: CanvasRenderingContext2D, spec: ColorbarSpec, x: number, y: number, w: number, caption: string, px = 1,
): number {
  ctx.save();
  ctx.textBaseline = "top";
  let h: number;
  if (spec.kind === "precip") h = drawPrecipLegend(ctx, spec, x, y, w, px);
  else h = drawBar(ctx, spec, x, y, w, px);
  if (caption) {
    ctx.font = `550 ${14.5 * px}px ${FONT}`;
    ctx.fillStyle = "#334155";
    ctx.textAlign = "center";
    ctx.fillText(caption, x + w / 2, y + h + 4 * px, w);
    h += 4 * px + 17 * px;
  }
  ctx.restore();
  return h;
}

/** Height `drawColorbar` takes, without drawing. */
export function colorbarHeight(spec: ColorbarSpec, caption: string, px = 1): number {
  const rows = spec.kind !== "precip" ? 0 : spec.untyped ? 1 : spec.untypedModel ? 5 : 4;
  const body = spec.kind === "precip" ? precipRows(rows) * px : 42 * px;
  return body + (caption ? 21 * px : 0);
}

function drawBar(ctx: CanvasRenderingContext2D, spec: Exclude<ColorbarSpec, { kind: "precip" }>, x: number, y: number, w: number, px: number): number {
  const { min, max, ticks, fmt, color, extend, zeroIdx } = barOf(spec);
  const barH = 16 * px, tip = 12 * px, pad = 2 * px;
  const x0 = x + pad + (extend !== "none" ? tip : 0);
  const x1 = x + w - pad - (extend !== "none" ? tip : 0);
  const xOf = (v: number) => x0 + ((v - min) / (max - min)) * (x1 - x0);
  const grad = ctx.createLinearGradient(x0, 0, x1, 0);
  const N = 96;
  for (let i = 0; i <= N; i++) grad.addColorStop(i / N, color(min + ((max - min) * i) / N));
  ctx.globalAlpha = spec.kind === "disabled" ? 0.35 : 1;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  if (extend === "both") ctx.lineTo(x0 - tip, y + barH / 2);
  ctx.lineTo(x0, y + barH);
  ctx.lineTo(x1, y + barH);
  if (extend !== "none") ctx.lineTo(x1 + tip, y + barH / 2);
  ctx.lineTo(x1, y);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fillRect(x0, y, x1 - x0, barH);
  if (extend === "both") {
    ctx.fillStyle = color(min);
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, y);
    ctx.lineTo(x0 - tip, y + barH / 2);
    ctx.lineTo(x0 + 0.5, y + barH);
    ctx.fill();
  }
  if (extend !== "none") {
    ctx.fillStyle = color(max);
    ctx.beginPath();
    ctx.moveTo(x1 - 0.5, y);
    ctx.lineTo(x1 + tip, y + barH / 2);
    ctx.lineTo(x1 - 0.5, y + barH);
    ctx.fill();
  }
  // Outline
  ctx.beginPath();
  ctx.moveTo(x0, y);
  if (extend === "both") ctx.lineTo(x0 - tip, y + barH / 2);
  ctx.lineTo(x0, y + barH);
  ctx.lineTo(x1, y + barH);
  if (extend !== "none") ctx.lineTo(x1 + tip, y + barH / 2);
  ctx.lineTo(x1, y);
  ctx.closePath();
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = px;
  ctx.stroke();

  const size = 14 * px;
  ctx.font = `600 ${size}px ${FONT}`;
  ctx.textAlign = "center";
  const widest = Math.max(...ticks.map((v) => ctx.measureText(fmt(v)).width));
  const spacing = ticks.length > 1 ? xOf(ticks[1]) - xOf(ticks[0]) : 100;
  const every = Math.max(1, Math.ceil((widest + 10 * px) / spacing));
  ticks.forEach((v, k) => {
    const tx = xOf(v);
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.beginPath();
    ctx.moveTo(tx, y + barH);
    ctx.lineTo(tx, y + barH + 4 * px);
    ctx.stroke();
    if (Math.abs(k - (zeroIdx >= 0 ? zeroIdx : 0)) % every !== 0) return;
    ctx.fillStyle = k === zeroIdx ? "#0f172a" : "#334155";
    ctx.fillText(fmt(v), tx, y + barH + 6 * px);
  });
  ctx.globalAlpha = 1;
  return 42 * px;
}

const precipRows = (rows: number) => rows * 17 + 22;

function drawPrecipLegend(ctx: CanvasRenderingContext2D, spec: Extract<ColorbarSpec, { kind: "precip" }>, x: number, y: number, w: number, px: number): number {
  const codes = spec.untyped ? [PTYPE_UNSPECIFIED] : spec.untypedModel ? [1, 2, 3, 4, PTYPE_UNSPECIFIED] : [1, 2, 3, 4];
  const rowH = 17 * px, labelW = Math.min(110 * px, w * 0.22);
  const sw = (w - labelW) / QPF_BINS.length;
  ctx.font = `600 ${14 * px}px ${FONT}`;
  codes.forEach((code, r) => {
    const ry = y + r * rowH;
    ctx.fillStyle = "#334155";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const label = code !== PTYPE_UNSPECIFIED ? PTYPE_LABELS[code] : spec.untypedModel ?? "Precip";
    ctx.fillText(label, x + labelW - 8 * px, ry + rowH / 2, labelW - 8 * px);
    PTYPE_COLORS[code].forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(x + labelW + i * sw, ry + 1.5 * px, sw - 1.5 * px, rowH - 3 * px);
    });
  });
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = "#334155";
  QPF_BINS.forEach((b, i) => {
    ctx.fillText(b < 1 ? String(b).replace(/^0/, "") : String(b), x + labelW + i * sw, y + codes.length * rowH + 4 * px);
  });
  return codes.length * rowH + 22 * px;
}
