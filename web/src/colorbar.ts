import { colorFor, tickStep } from "./colormap";

const NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export function fmtSigned(v: number): string {
  if (v === 0) return "0";
  return v > 0 ? `+${v}` : `−${Math.abs(v)}`;
}

/**
 * Horizontal colorbar for Δ in kt, symmetric about 0, with pointed ends to show
 * that values beyond ±limit are clipped.
 */
export function renderColorbar(host: HTMLElement, limit: number, opts: { auto: boolean; disabled: boolean }): void {
  // Lay out in real pixels so labels keep their size at any width.
  const W = Math.max(280, Math.round(host.clientWidth || 1000));
  const H = 44, padX = 14, barY = 4, barH = 14, tip = 11;
  const x0 = padX + tip, x1 = W - padX - tip;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Δ|V| colorbar from −${limit} to +${limit} kt` });
  svg.classList.toggle("disabled", opts.disabled);

  const defs = el("defs", {});
  const grad = el("linearGradient", { id: "cb-grad", x1: 0, x2: 1, y1: 0, y2: 0 });
  const N = 32;
  for (let i = 0; i <= N; i++) {
    const v = -limit + (2 * limit * i) / N;
    grad.appendChild(el("stop", { offset: i / N, "stop-color": colorFor(v, limit) }));
  }
  defs.appendChild(grad);
  svg.appendChild(defs);

  svg.appendChild(el("rect", { x: x0, y: barY, width: x1 - x0, height: barH, fill: "url(#cb-grad)" }));
  svg.appendChild(el("path", { d: `M${x0},${barY} L${x0 - tip},${barY + barH / 2} L${x0},${barY + barH} Z`, fill: colorFor(-limit, limit) }));
  svg.appendChild(el("path", { d: `M${x1},${barY} L${x1 + tip},${barY + barH / 2} L${x1},${barY + barH} Z`, fill: colorFor(limit, limit) }));
  svg.appendChild(el("path", {
    d: `M${x0},${barY} L${x0 - tip},${barY + barH / 2} L${x0},${barY + barH} L${x1},${barY + barH} L${x1 + tip},${barY + barH / 2} L${x1},${barY} Z`,
    fill: "none", stroke: "rgba(0,0,0,0.45)", "stroke-width": 1,
  }));

  const step = tickStep(limit);
  const nTicks = Math.round((2 * limit) / step);
  // Thin labels to keep ~40 px apart; 0 is always labeled (nTicks is even).
  const every = Math.max(1, Math.ceil(40 / ((x1 - x0) / nTicks)));
  for (let k = 0; k <= nTicks; k++) {
    const v = -limit + k * step;
    const x = x0 + (k / nTicks) * (x1 - x0);
    svg.appendChild(el("line", { x1: x, x2: x, y1: barY + barH, y2: barY + barH + 4, stroke: "rgba(0,0,0,0.6)" }));
    if ((k - nTicks / 2) % every !== 0) continue;
    const t = el("text", { x, y: barY + barH + 17, "text-anchor": "middle", class: v === 0 ? "cb-tick zero" : "cb-tick" });
    t.textContent = fmtSigned(Math.round(v));
    svg.appendChild(t);
  }

  host.replaceChildren(svg);
  host.dataset.limit = String(limit);
  host.dataset.mode = opts.auto ? "auto" : "fixed";
}
