import { PTYPE_COLORS, PTYPE_LABELS, QPF_BINS, tickStep, type ColorFn } from "./palettes";

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
  | { kind: "diverging"; color: ColorFn; limit: number; format?: (v: number) => string }
  | { kind: "precip" }
  | { kind: "disabled"; color: ColorFn; limit: number };

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

function decimals(step: number): number {
  return step >= 1 ? 0 : step >= 0.1 ? (Math.round(step * 10) === step * 10 ? 1 : 2) : 2;
}

let gradId = 0;

/** Render a colorbar into `host`, laid out in real pixels so labels keep their size. */
export function renderColorbar(host: HTMLElement, spec: ColorbarSpec): void {
  if (spec.kind === "precip") {
    renderPrecipLegend(host);
    return;
  }
  const W = Math.max(280, Math.round(host.clientWidth || 1000));
  const H = 44, padX = 14, barY = 4, barH = 14, tip = 11;
  let min: number, max: number, ticks: number[], fmt: (v: number) => string, color: ColorFn;
  let extend: "both" | "max" | "none" = "both";
  if (spec.kind === "continuous") {
    ({ min, max, ticks, color } = spec);
    fmt = spec.format ?? ((v) => String(v));
    extend = spec.extend;
  } else {
    const limit = spec.limit;
    const step = tickStep(limit);
    const d = decimals(step);
    min = -limit;
    max = limit;
    color = spec.color;
    ticks = [];
    for (let k = 0; k <= Math.round((2 * limit) / step); k++) ticks.push(-limit + k * step);
    fmt = spec.kind === "diverging" && spec.format ? spec.format : (v) => fmtSigned(v, d);
  }
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
  const zeroIdx = spec.kind === "continuous" ? -1 : ticks.findIndex((t) => Math.abs(t) < 1e-9);
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

/** Rows of discrete swatches, one row per precipitation type. */
function renderPrecipLegend(host: HTMLElement): void {
  const wrap = document.createElement("div");
  wrap.className = "ptype-legend";
  for (const code of [1, 2, 3, 4]) {
    const label = document.createElement("span");
    label.className = "ptype-label";
    label.textContent = PTYPE_LABELS[code];
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
  host.replaceChildren(wrap);
  host.dataset.kind = "precip";
}
