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
  bias, checkPuzzle, fieldLine, formatValue, leadDays, rating, roundValues, runLabel, shareText, shiftNote, square,
  timeReadout, verdict, type MField, type MPuzzle, type MRound, type Pick,
} from "./measured-score";
import { dayLine } from "./score";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  game: $("game"), number: $("number"), date: $("date"), chips: $<HTMLOListElement>("chips"), hudScore: $("hud-score"),
  round: $("round"), count: $("round-count"), label: $("round-label"), prompt: $("prompt"), detail: $("detail"),
  rule: $("rule"), pair: $("pair"),
  sides: [$("side-0"), $("side-1")], maps: [$<HTMLCanvasElement>("map-0"), $<HTMLCanvasElement>("map-1")],
  overs: [$<HTMLCanvasElement>("over-0"), $<HTMLCanvasElement>("over-1")], badges: [$("badge-0"), $("badge-1")],
  picks: [$<HTMLButtonElement>("pick-0"), $<HTMLButtonElement>("pick-1")], readout: $("readout"),
  keyBar: $("key-bar"), foot: $("foot"), result: $("result"), next: $<HTMLButtonElement>("next"),
  summary: $("summary"), total: $("total"), squares: $("squares"), rating: $("rating"),
  summaryRounds: $<HTMLTableSectionElement>("summary-rounds"), share: $<HTMLButtonElement>("share"),
  shareNote: $("share-note"), banner: $("banner"),
};

const SHADES: Record<MField, Shade> = { t2m: TEMP_SHADE, d2m: DEW_SHADE, gust: GUST_SHADE, rain: RAIN_SHADE };
const LETTERS = ["A", "B"] as const;
/** A day's picks, and how many were right once every round is played (the landing page shows it). */
const saved = savedDays<{ picks: (Pick | null)[]; score?: number }>("rtr:game:measured");
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
    readoutHint();
    return;
  }
  const name = (j: 0 | 1) => (picks[shown] === null ? LETTERS[j] : r.answer === j ? "Measured" : r.model.name);
  const chip = (j: 0 | 1, v: number) =>
    h("span", "mm-chip", h("span", "mm-chip-name fx", name(j)), h("b", "fx", formatValue(r.field, v, units)));
  el.readout.replaceChildren(chip(0, va), chip(1, vb),
    h("span", "mm-where", `${Math.abs(ll[1]).toFixed(1)}° N, ${Math.abs(ll[0]).toFixed(1)}° W`));
}

function readoutHint(): void {
  el.readout.replaceChildren(h("span", "mm-where", "Point at either map to compare the two there"));
}

function clearReadout(): void {
  if (!view) return;
  for (const over of el.overs) over.getContext("2d")!.clearRect(0, 0, view.width, view.height);
}

// ------------------------------------------------------------------ the game

const fmt = (n: number) => n.toLocaleString("en-US");

/** A number that counts up when the final score shows (see tally()). */
function num(n: number, cls = ""): HTMLElement {
  const b = h("b", cls, fmt(n));
  b.dataset.count = String(n);
  return b;
}

function render(): void {
  const p = puzzle!;
  const done = current >= p.rounds.length;
  el.game.dataset.state = done ? "done" : "playing";
  // The tally's animations play once, when a round is decided: not again on a resize or the next render
  el.result.classList.remove("fresh");
  el.summary.classList.remove("fresh");

  el.chips.replaceChildren(...p.rounds.map((r, k) => {
    const b = h("button", "chip fx");
    b.type = "button";
    b.disabled = k > current;
    if (k === shown) b.setAttribute("aria-current", "step");
    if (picks[k] !== null) {
      b.dataset.result = isRight(k) ? "right" : "wrong";
      b.append(h("span", "chip-n", String(k + 1)), h("span", "chip-mark", isRight(k) ? "✓" : "✗"));
    } else {
      b.append(h("span", "chip-n", String(k + 1)));
    }
    b.title = `Round ${k + 1}: ${r.title}`;
    b.setAttribute("aria-label", picks[k] !== null ? `Round ${k + 1}, ${isRight(k) ? "right" : "wrong"}` : `Round ${k + 1}`);
    b.addEventListener("click", () => show(k));
    return h("li", "", b);
  }));
  el.hudScore.textContent = `${p.rounds.filter((_, k) => isRight(k)).length}/${p.rounds.length}`;

  const k = Math.min(shown, p.rounds.length - 1);
  const r = p.rounds[k];
  const pick = picks[k];
  const when = timeReadout(r);
  el.round.dataset.field = r.field;
  el.count.textContent = `Round ${k + 1}/${p.rounds.length}`;
  el.label.textContent = r.title;
  el.prompt.textContent = when.value;
  el.detail.textContent = fieldLine(r);
  el.rule.textContent = when.caption;
  draw(r);
  renderKey(r);
  readoutHint();

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
  el.next.textContent = done ? "Final score ▶" : "Next round ▶";
  if (pick !== null) renderResult(r, pick);
  else el.result.replaceChildren(h("p", "round-hint fx", "Which map was measured?"));

  el.summary.hidden = !summaryOpen;
  if (summaryOpen) renderSummary();
}

function show(k: number): void {
  shown = k;
  render();
}

function renderResult(r: MRound, pick: Pick): void {
  const right = pick === r.answer;
  const off = bias(r, units);
  const note = shiftNote(r, units);
  const tile = (cls: string, label: string, value: string, sub: string) =>
    h("div", `tile ${cls}`, h("span", "tile-label fx", label), h("span", "tile-num fx", value), h("span", "tile-sub", sub));
  el.result.replaceChildren(
    h("p", `stamp fx stamp-${right ? 3 : 0}`, verdict(right)),
    h("p", "mm-answer fx", `${LETTERS[r.answer]} was measured`),
    h("div", "tiles",
      tile("tile-model", "Model", r.model.name, `${runLabel(r)} run`),
      tile("tile-lead", "Lead", leadDays(r), "days ahead"),
      tile("tile-bias", "Bias", off.value, off.word)),
    ...(note ? [h("p", "mm-source", note)] : []),
    h("p", "mm-source", `${r.measured}.`),
  );
}

/** The final score's stamp colour: the same tiers as Wx Marks the Spot's. */
function ratingTier(n: number, of: number): number {
  return n === of ? 3 : n >= of - 1 ? 2 : n * 2 >= of ? 1 : 0;
}

function renderSummary(): void {
  const p = puzzle!;
  const right = p.rounds.map((_, k) => isRight(k));
  const n = right.filter(Boolean).length;
  el.total.replaceChildren(num(n), h("small", "", ` / ${p.rounds.length}`));
  el.squares.textContent = right.map(square).join(" ");
  el.rating.textContent = rating(n, p.rounds.length);
  el.rating.className = `stamp fx stamp-${ratingTier(n, p.rounds.length)}`;
  el.summaryRounds.replaceChildren(...p.rounds.map((r, k) => {
    const go = h("button", "board-round fx", String(k + 1));
    go.type = "button";
    go.setAttribute("aria-label", `Show round ${k + 1}`);
    go.addEventListener("click", () => {
      show(k);
      el.round.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    const row = h("tr", "",
      h("td", "", go),
      h("td", "board-event", r.title),
      h("td", "board-num", r.model.name),
      h("td", "board-num", `${leadDays(r)} days`),
      h("td", "board-num board-pts fx", right[k] ? "✓" : "✗"));
    row.dataset.tier = right[k] ? "3" : "0";
    return row;
  }));
}

/** Count the new numbers up and pop the stamp, like an arcade tally (not when motion is reduced). */
function tally(root: HTMLElement): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const nums = [...root.querySelectorAll<HTMLElement>("[data-count]")];
  const t0 = performance.now();
  const step = (now: number) => {
    const f = Math.min(1, (now - t0) / 700);
    for (const n of nums) if (n.isConnected) n.textContent = fmt(Math.round(Number(n.dataset.count) * (1 - (1 - f) ** 3)));
    if (f < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  root.classList.remove("fresh");
  void root.offsetWidth;
  root.classList.add("fresh");
}

function choose(j: Pick): void {
  if (!puzzle || shown !== current || current >= puzzle.rounds.length) return;
  picks[current] = j;
  current += 1;
  const done = current >= puzzle.rounds.length;
  saved.save(puzzle.date, done ? { picks, score: puzzle.rounds.filter((_, k) => isRight(k)).length } : { picks });
  render();
  tally(el.result);
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
    tally(el.summary);
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
  // A day finished before scores were saved: save it now, for the landing page
  if (summaryOpen) saved.save(p.date, { picks, score: p.rounds.filter((_, k) => isRight(k)).length });
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
