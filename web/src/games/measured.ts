// Modeled or Measured (build plan G2): the page at /play/measured/. One puzzle
// a day from the data bucket (games/measured/latest.json, or ?date=YYYY-MM-DD);
// picks stay in this browser (rtr:game:measured).
import "../styles.css";
import "./games.css";
import "./measured.css";
import type { GeoProjection } from "d3-geo";
import { drawBasemap } from "../basemap";
import { renderColorbar } from "../colorbar";
import { productBase } from "../manifest";
import {
  areaAspect, DEW_SHADE, drawLand, fit, GUST_SHADE, h, RAIN_SHADE, savedDays, shadeGrid, siteRoot, sizeCanvas,
  TEMP_SHADE, valueAtPoint, viewerUnits, type Shade,
} from "./gamemap";
import {
  biasLine, checkPuzzle, fieldLine, forecastLine, formatValue, leadDays, rating, roundValues, shareText, square, whenLine,
  type MField, type MPuzzle, type MRound, type Pick,
} from "./measured-score";
import { dayLine } from "./score";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  game: $("game"), number: $("number"), date: $("date"), chips: $<HTMLOListElement>("chips"),
  round: $("round"), count: $("round-count"), prompt: $("prompt"), detail: $("detail"), pair: $("pair"),
  sides: [$("side-0"), $("side-1")], maps: [$<HTMLCanvasElement>("map-0"), $<HTMLCanvasElement>("map-1")],
  overs: [$<HTMLCanvasElement>("over-0"), $<HTMLCanvasElement>("over-1")], badges: [$("badge-0"), $("badge-1")],
  picks: [$<HTMLButtonElement>("pick-0"), $<HTMLButtonElement>("pick-1")], readout: $("readout"),
  keyBar: $("key-bar"), foot: $("foot"), result: $("result"), next: $<HTMLButtonElement>("next"),
  summary: $("summary"), total: $("total"), squares: $("squares"), rating: $("rating"),
  summaryRounds: $<HTMLOListElement>("summary-rounds"), share: $<HTMLButtonElement>("share"),
  shareNote: $("share-note"), banner: $("banner"),
};

const SHADES: Record<MField, Shade> = { t2m: TEMP_SHADE, d2m: DEW_SHADE, gust: GUST_SHADE, rain: RAIN_SHADE };
const LETTERS = ["A", "B"] as const;
const saved = savedDays<{ picks: (Pick | null)[] }>("rtr:game:measured");
const units = viewerUnits();

let puzzle: MPuzzle | null = null;
let picks: (Pick | null)[] = [];
let current = 0; // the round being played (rounds.length once all are done)
let shown = 0; // the round on screen
let summaryOpen = false;
let view: { proj: GeoProjection; width: number; height: number } | null = null;
const decoded = new WeakMap<MRound, [Float32Array, Float32Array]>();

function valuesOf(r: MRound): [Float32Array, Float32Array] {
  let v = decoded.get(r);
  if (!v) {
    v = [roundValues(r, 0), roundValues(r, 1)];
    decoded.set(r, v);
  }
  return v;
}

const isRight = (k: number) => picks[k] !== null && picks[k] === puzzle!.rounds[k].answer;

// ------------------------------------------------------------------ the maps

/** Each map's size: half the round's width side by side, the whole width stacked on a phone. */
function sizeFor(): { width: number; height: number } {
  const p = puzzle!;
  const stacked = matchMedia("(max-width: 760px)").matches;
  const full = Math.max(280, el.pair.clientWidth);
  const width = Math.floor(stacked ? full : (full - 12) / 2);
  const height = Math.round(Math.min(width / areaAspect(p.area), stacked ? (window.innerHeight - 220) / 2 : 9999));
  return { width, height: Math.max(160, height) };
}

function draw(r: MRound): void {
  const p = puzzle!;
  const { width, height } = sizeFor();
  const proj = fit(p.area, width, height);
  const values = valuesOf(r);
  for (const k of [0, 1] as const) {
    const ctx = sizeCanvas(el.maps[k], width, height);
    drawLand(ctx, proj, width, height);
    shadeGrid(ctx, proj, p.grid, values[k], SHADES[r.field], width, height);
    drawBasemap(ctx, proj);
    sizeCanvas(el.overs[k], width, height);
  }
  view = { proj, width, height };
}

function renderKey(r: MRound): void {
  const [a, b] = valuesOf(r);
  let lo = Infinity, hi = -Infinity;
  for (const vs of [a, b]) {
    for (const v of vs) {
      if (v === v) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  renderColorbar(el.keyBar, SHADES[r.field].colorbar(Math.floor(lo / 10) * 10, Math.ceil(hi / 10) * 10, units));
}

/** Both maps' values under the pointer, and a cross at the same spot on each. */
function readout(ev: PointerEvent, k: 0 | 1): void {
  if (!puzzle || !view) return;
  const r = puzzle.rounds[shown];
  const rect = el.maps[k].getBoundingClientRect();
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  const ll = view.proj.invert?.([x, y]);
  if (!ll) return;
  const [a, b] = valuesOf(r);
  const va = valueAtPoint(puzzle.grid, a, ll[0], ll[1]);
  const vb = valueAtPoint(puzzle.grid, b, ll[0], ll[1]);
  for (const over of el.overs) {
    const ctx = over.getContext("2d")!;
    ctx.clearRect(0, 0, view.width, view.height);
    if (va !== va) continue;
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y);
    ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 7);
    ctx.stroke();
  }
  if (va !== va || vb !== vb) {
    el.readout.textContent = "Point at the Lower 48 to compare the two maps there.";
    return;
  }
  const where = `${Math.abs(ll[1]).toFixed(1)}° N, ${Math.abs(ll[0]).toFixed(1)}° W`;
  const name = (j: 0 | 1) => (picks[shown] === null ? LETTERS[j] : r.answer === j ? "Measured" : r.model.name);
  el.readout.replaceChildren(
    `${where}: `,
    h("strong", "", `${name(0)} ${formatValue(r.field, va, units)}`), " · ",
    h("strong", "", `${name(1)} ${formatValue(r.field, vb, units)}`),
  );
}

function clearReadout(): void {
  if (!view) return;
  for (const over of el.overs) over.getContext("2d")!.clearRect(0, 0, view.width, view.height);
}

// ------------------------------------------------------------------ the game

function render(): void {
  const p = puzzle!;
  const done = current >= p.rounds.length;
  el.game.dataset.state = done ? "done" : "playing";

  el.chips.replaceChildren(...p.rounds.map((r, k) => {
    const b = h("button", "chip");
    b.type = "button";
    b.disabled = k > current;
    if (k === shown) b.setAttribute("aria-current", "step");
    if (picks[k] !== null) b.append(h("span", "chip-sq", square(isRight(k))), h("span", "", String(k + 1)));
    else b.append(h("span", "", String(k + 1)));
    b.title = `Round ${k + 1}: ${r.title}`;
    b.setAttribute("aria-label", picks[k] !== null ? `Round ${k + 1}, ${isRight(k) ? "right" : "wrong"}` : `Round ${k + 1}`);
    b.addEventListener("click", () => {
      shown = k;
      render();
    });
    return h("li", "", b);
  }));

  const k = Math.min(shown, p.rounds.length - 1);
  const r = p.rounds[k];
  const pick = picks[k];
  el.count.textContent = `Round ${k + 1} of ${p.rounds.length} · ${r.title}`;
  el.prompt.textContent = "Which map is measured?";
  el.detail.textContent = `${fieldLine(r)}: ${whenLine(r)}.`;
  draw(r);
  renderKey(r);
  el.readout.textContent = "Point at either map to compare the two there.";

  for (const j of [0, 1] as const) {
    const side = el.sides[j];
    const revealed = pick !== null;
    side.dataset.role = revealed ? (r.answer === j ? "measured" : "modeled") : "";
    side.dataset.picked = String(pick === j);
    el.badges[j].textContent = revealed ? (r.answer === j ? "Measured" : `${r.model.name} forecast`) : LETTERS[j];
    el.picks[j].hidden = revealed;
    el.picks[j].disabled = k !== current;
  }

  el.next.hidden = pick === null || k !== current - 1 || (done && summaryOpen);
  el.next.textContent = done ? "See my score" : "Next round";
  if (pick !== null) renderResult(r, pick);
  else el.result.replaceChildren(h("p", "round-hint", "One of these is a forecast. Pick the map that shows what really happened."));

  el.summary.hidden = !summaryOpen;
  if (summaryOpen) renderSummary();
}

function renderResult(r: MRound, pick: Pick): void {
  const right = pick === r.answer;
  el.result.replaceChildren(
    h("p", `round-answer mm-verdict ${right ? "mm-right" : "mm-wrong"}`,
      right ? `Right: ${LETTERS[r.answer]} was measured.` : `Not this time: ${LETTERS[r.answer]} was measured.`),
    h("p", "mm-line", `${LETTERS[1 - r.answer]} was ${forecastLine(r)}. ${biasLine(r, units)}`),
    h("p", "mm-source", `${r.measured}.`),
  );
}

function renderSummary(): void {
  const p = puzzle!;
  const right = p.rounds.map((_, k) => isRight(k));
  const n = right.filter(Boolean).length;
  el.total.textContent = `${n} of ${p.rounds.length} right`;
  el.squares.textContent = right.map(square).join(" ");
  el.rating.textContent = rating(n, p.rounds.length);
  el.summaryRounds.replaceChildren(...p.rounds.map((r, k) => h("li", "",
    h("span", "sr-q", r.title),
    h("span", "sr-a", `${r.model.name}, about ${leadDays(r)} days ahead`),
    h("span", "sr-p", h("strong", "", right[k] ? "Right" : "Wrong")),
  )));
}

function choose(j: Pick): void {
  if (!puzzle || shown !== current || current >= puzzle.rounds.length) return;
  picks[current] = j;
  current += 1;
  saved.save(puzzle.date, { picks });
  render();
  el.next.focus({ preventScroll: true });
  el.foot.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function next(): void {
  if (!puzzle) return;
  if (current < puzzle.rounds.length) {
    shown = current;
    render();
    el.round.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    summaryOpen = true;
    render();
    el.summary.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

async function share(): Promise<void> {
  if (!puzzle) return;
  const url = `${location.origin}${location.pathname}`;
  const text = shareText(puzzle, puzzle.rounds.map((_, k) => isRight(k)), url);
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ text });
      return;
    }
    await navigator.clipboard.writeText(text);
    el.shareNote.textContent = "Copied. Paste it anywhere.";
  } catch (e) {
    // Closing the share sheet isn't a failure; anything else shows the text to copy by hand
    if ((e as Error).name !== "AbortError") el.shareNote.textContent = text;
  }
}

function showBanner(text: string): void {
  el.banner.textContent = text;
  el.banner.hidden = false;
}

async function start(): Promise<void> {
  const base = productBase(import.meta.env.VITE_DATA_BASE, "games/measured", siteRoot);
  const asked = new URLSearchParams(location.search).get("date");
  const day = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : null;
  try {
    const res = await fetch(new URL(day ? `${day}.json` : "latest.json", base), { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const p = (await res.json()) as MPuzzle;
    checkPuzzle(p);
    puzzle = p;
  } catch (e) {
    el.game.dataset.state = "error";
    showBanner(day ? `There's no puzzle for ${day}.` : "Today's puzzle isn't ready yet. Check back soon.");
    console.warn("puzzle:", e);
    return;
  }
  const p = puzzle;
  el.number.textContent = `#${p.number}`;
  el.date.textContent = dayLine(p.date);
  const before = saved.load()[p.date]?.picks ?? [];
  picks = p.rounds.map((_, k) => (before[k] === 0 || before[k] === 1 ? before[k] : null));
  current = picks.findIndex((x) => x === null);
  if (current < 0) current = p.rounds.length;
  shown = Math.min(current, p.rounds.length - 1);
  summaryOpen = current >= p.rounds.length;
  render();
}

for (const j of [0, 1] as const) {
  el.picks[j].addEventListener("click", () => choose(j));
  const wrap = el.maps[j].parentElement!;
  wrap.addEventListener("pointermove", (ev) => readout(ev, j));
  wrap.addEventListener("pointerdown", (ev) => readout(ev, j));
  // A finger lifting also leaves: keep its cross and values until the next touch
  wrap.addEventListener("pointerleave", (ev) => ev.pointerType !== "touch" && clearReadout());
}
el.next.addEventListener("click", next);
el.share.addEventListener("click", () => void share());
new ResizeObserver(() => puzzle && render()).observe(el.pair);
void start();
