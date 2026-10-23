// Station ID (build plan G3): the page at /play/station/. One puzzle a day
// from the data bucket (games/station/latest.json, or ?date=YYYY-MM-DD);
// guesses stay in this browser (rtr:game:station).
import "../styles.css";
import "./games.css";
import "./station.css";
import type { GeoProjection } from "d3-geo";
import { drawBasemap } from "../basemap";
import { productBase } from "../manifest";
import { areaAspect, drawLand, fit, h, savedDays, siteRoot, sizeCanvas, viewerUnits } from "./gamemap";
import { dayLine, type Area } from "./score";
import {
  bandLabel, bandOf, bandSquare, bandWord, CARD_TITLES, checkPuzzle, compare, FAMILY_WORDS, getter, listOf, ROWS,
  shareText, verdict, type SPuzzle,
} from "./station-score";
import { tally } from "./tally";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  game: $("game"), number: $("number"), date: $("date"), chips: $<HTMLOListElement>("chips"), hudScore: $("hud-score"),
  howtoCities: $("howto-cities"), leftout: $("leftout"), board: $<HTMLTableElement>("board"), clockNote: $("clock-note"),
  wrap: $("map-wrap"), canvas: $<HTMLCanvasElement>("map"), tip: $("tip"), unzoom: $<HTMLButtonElement>("unzoom"), bar: $("bar"),
  search: $<HTMLInputElement>("search"), cityList: $("city-list"), chosen: $("chosen"), guess: $<HTMLButtonElement>("guess"),
  guesses: $<HTMLOListElement>("guesses"), summary: $("summary"), kicker: $("kicker"), answer: $("answer"),
  answerStation: $("answer-station"), squares: $("squares"), rating: $("rating"), share: $<HTMLButtonElement>("share"),
  shareNote: $("share-note"), banner: $("banner"),
};

/** A day's guesses (city ids), and the guesses it took once finished (0: not found; the landing page shows it). */
const saved = savedDays<{ guesses: string[]; score?: number; max?: number }>("rtr:game:station");
const units = viewerUnits();

/** Each band's colour, near to far (the share squares' colours), and the answer's. */
const BAND_COLORS = ["#eab308", "#f59e0b", "#e5484d", "#334155"];
const FOUND = "#2fb344";
const bandColor = (b: number) => (b < 0 ? FOUND : BAND_COLORS[Math.min(b, BAND_COLORS.length - 1)]);

let puzzle: SPuzzle | null = null;
let guesses: number[] = [];
let selected: number | null = null;
let hovered: number | null = null;
let view: { proj: GeoProjection; width: number; height: number; xy: ([number, number] | null)[]; base: HTMLCanvasElement } | null = null;
/** On a phone, a tap where dots crowd together zooms in to this box. */
let zoom: Area | null = null;
const labels = new Map<string, number>();

const coarse = () => matchMedia("(pointer: coarse)").matches;
const solved = () => guesses.includes(puzzle!.answer);
const isDone = () => solved() || guesses.length >= puzzle!.guesses;
const cardsShown = () => (isDone() ? puzzle!.cards.length : Math.min(guesses.length + 1, puzzle!.cards.length));
const cityName = (k: number) => `${puzzle!.cities[k][1]}, ${puzzle!.cities[k][2]}`;
const label = (k: number) => `${cityName(k)} · ${puzzle!.cities[k][3]}`;

// ------------------------------------------------------------------ the map

function sizeFor(): { width: number; height: number } {
  const width = Math.max(280, el.wrap.clientWidth);
  const height = Math.round(Math.min(width / areaAspect(puzzle!.area), Math.max(240, window.innerHeight - 200)));
  return { width, height: Math.max(200, height) };
}

/** Land and state lines, drawn once a size (and zoom: setZoom clears the view). */
function layout(): void {
  const p = puzzle!;
  const { width, height } = sizeFor();
  if (view && view.width === width && view.height === height) return;
  const proj = fit(zoom ?? p.area, width, height);
  const base = document.createElement("canvas");
  const ctx = sizeCanvas(base, width, height);
  drawLand(ctx, proj, width, height);
  drawBasemap(ctx, proj);
  view = { proj, width, height, base, xy: p.cities.map((c) => proj([c[5], c[4]]) as [number, number] | null) };
}

function radius(): number {
  return zoom ? 5 : Math.max(2.6, Math.min(4.2, view!.width / 250));
}

/** A box about 14° of longitude wide around a point, or the whole map (null). */
function setZoom(at: [number, number] | null): void {
  zoom = at && { id: "zoom", label: "", lat: [at[1] - 4.5, at[1] + 4.5], lon: [at[0] - 7, at[0] + 7] };
  el.unzoom.hidden = zoom === null;
  view = null;
  drawMap();
}

function drawMap(): void {
  const p = puzzle!;
  layout();
  const { width, height, base, xy } = view!;
  const ctx = sizeCanvas(el.canvas, width, height);
  ctx.drawImage(base, 0, 0, width, height);
  const r = radius();
  const done = isDone();
  const dot = (k: number, size: number, fill: string, line = 1.2) => {
    const pt = xy[k];
    if (!pt) return;
    ctx.beginPath();
    ctx.arc(pt[0], pt[1], size, 0, 2 * Math.PI);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = line;
    ctx.strokeStyle = "#13365c";
    ctx.stroke();
  };
  const marked = new Set([...guesses, ...(done ? [p.answer] : [])]);
  p.cities.forEach((_, k) => marked.has(k) || dot(k, r, "#ffffff"));
  // The pointer's dot and the chosen one, above the rest
  for (const k of [hovered, selected]) if (k !== null && !marked.has(k)) dot(k, r + 2.5, "#ff9a1f", 2);
  const badge = (k: number, fill: string, text: string) => {
    const pt = xy[k];
    if (!pt) return;
    dot(k, 9, fill, 2);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, pt[0], pt[1] + 0.5);
  };
  guesses.forEach((g, n) => g !== p.answer && badge(g, bandColor(bandOf(p, g)), String(n + 1)));
  if (done) badge(p.answer, FOUND, "★");
}

/** The city whose dot is nearest the point, within `reach` pixels. */
function nearest(x: number, y: number, reach: number): number | null {
  let best: number | null = null, d2 = reach * reach;
  view!.xy.forEach((pt, k) => {
    if (!pt) return;
    const d = (pt[0] - x) ** 2 + (pt[1] - y) ** 2;
    if (d <= d2) [best, d2] = [k, d];
  });
  return best;
}

function showTip(k: number | null): void {
  if (k === null || !view?.xy[k]) {
    el.tip.hidden = true;
    return;
  }
  const [x, y] = view.xy[k]!;
  el.tip.replaceChildren(h("b", "", cityName(k)), h("span", "", puzzle!.cities[k][3]));
  el.tip.hidden = false;
  // Above the dot, kept inside the map
  const w = el.tip.offsetWidth;
  el.tip.style.left = `${Math.min(Math.max(4, x - w / 2), view.width - w - 4)}px`;
  el.tip.style.top = `${Math.max(4, y - el.tip.offsetHeight - 12)}px`;
}

// ------------------------------------------------------------------ the page

function renderChips(): void {
  const p = puzzle!;
  el.chips.replaceChildren(...Array.from({ length: p.guesses }, (_, n) => {
    const b = h("span", "chip fx", h("span", "chip-n", String(n + 1)));
    const g = guesses[n];
    if (g !== undefined) {
      const band = bandOf(p, g);
      b.dataset.band = String(band);
      b.style.setProperty("--band", bandColor(band));
      b.append(h("span", "chip-pts", band < 0 ? "✓" : bandWord(band)));
      b.title = `${cityName(g)}: ${bandLabel(p, band, units)}`;
    } else if (n === guesses.length && !isDone()) {
      b.setAttribute("aria-current", "step");
    }
    return h("li", "", b);
  }));
  el.hudScore.textContent = isDone() ? `${solved() ? guesses.length : "X"}/${p.guesses}`
    : `${guesses.length + 1}/${p.guesses}`;
}

function renderBoard(): void {
  const p = puzzle!;
  const answer = getter(p, p.answer);
  const wrong = guesses.filter((g) => g !== p.answer);
  const head = h("tr", "", h("th", "sid-label", ""), h("th", "sid-mystery fx", isDone() ? cityName(p.answer) : "Mystery"),
    ...wrong.map((g) => {
      const n = guesses.indexOf(g) + 1;
      const th = h("th", "sid-guess-col", h("span", "sid-num fx", String(n)));
      th.style.setProperty("--band", bandColor(bandOf(p, g)));
      th.title = cityName(g);
      th.append(h("span", "sid-col-name", p.cities[g][1]));
      return th;
    }));
  const body: HTMLTableRowElement[] = [];
  for (const card of p.cards.slice(0, cardsShown())) {
    const title = h("th", "sid-card fx", CARD_TITLES[card.id] ?? card.id);
    title.colSpan = 2 + wrong.length;
    body.push(h("tr", "sid-card-row", title));
    for (const row of ROWS[card.id] ?? []) {
      const cells = wrong.map((g) => {
        const get = getter(p, g);
        const td = h("td", "sid-val", row.text(get, units) ?? "—");
        const way = compare(row, get, answer);
        if (way) {
          td.dataset.way = way;
          td.append(h("span", "sid-way", way === "up" ? "▲" : way === "down" ? "▼" : "="));
          td.title = way === "same" ? "The same as the mystery station"
            : `The mystery station's is ${way === "up" ? "higher" : "lower"}`;
        }
        return td;
      });
      body.push(h("tr", "", h("th", "sid-label", row.label), h("td", "sid-val sid-mystery fx", row.text(answer, units) ?? "—"),
        ...cells));
    }
  }
  el.board.replaceChildren(h("thead", "", head), h("tbody", "", ...body));
  el.clockNote.hidden = !p.cards.slice(0, cardsShown()).some((c) => c.id === "clock");
}

function renderGuesses(): void {
  const p = puzzle!;
  el.guesses.replaceChildren(...guesses.map((g, n) => {
    const band = bandOf(p, g);
    const li = h("li", "sid-guess",
      h("span", "sid-num fx", String(n + 1)),
      h("span", "sid-guess-name", h("b", "", cityName(g)), h("small", "", p.cities[g][3])),
      h("span", "sid-band fx", bandLabel(p, band, units)));
    li.style.setProperty("--band", bandColor(band));
    return li;
  }));
}

function renderBar(): void {
  const done = isDone();
  el.bar.hidden = done;
  if (done) return;
  const k = selected;
  const already = k !== null && guesses.includes(k);
  const hint = coarse() ? "Tap a dot to choose it. Tap where dots crowd together to zoom in."
    : "Point at a dot to see its city; click to choose it.";
  el.chosen.replaceChildren(...(k === null ? [hint]
    : [h("b", "", cityName(k)), " ", h("small", "", puzzle!.cities[k][3]), ...(already ? [h("em", "", " Already guessed")] : [])]));
  el.guess.disabled = k === null || already;
  el.guess.textContent = k === null || already ? "Guess ▶" : `Guess ${puzzle!.cities[k][1]} ▶`;
}

function renderSummary(): void {
  const p = puzzle!;
  const done = isDone();
  el.summary.hidden = !done;
  el.game.dataset.state = done ? "done" : "playing";
  if (!done) return;
  el.kicker.textContent = solved() ? `Found in ${guesses.length}` : "The station was";
  el.answer.textContent = cityName(p.answer);
  el.answerStation.textContent = p.cities[p.answer][3];
  el.squares.textContent = guesses.map((g) => bandSquare(bandOf(p, g))).join("");
  el.rating.textContent = verdict(solved() ? guesses.length : null);
  el.rating.className = `stamp fx stamp-${solved() ? Math.max(0, 3 - Math.floor((guesses.length - 1) / 2)) : 0}`;
}

function render(): void {
  renderChips();
  renderBoard();
  renderGuesses();
  renderBar();
  renderSummary();
  drawMap();
}

function choose(k: number | null): void {
  if (!puzzle || isDone()) return;
  selected = k;
  el.search.value = k === null ? "" : label(k);
  renderBar();
  drawMap();
}

function guess(): void {
  const p = puzzle;
  if (!p || selected === null || isDone() || guesses.includes(selected)) return;
  guesses.push(selected);
  selected = null;
  el.search.value = "";
  showTip(null);
  if (zoom) setZoom(null);
  const done = isDone();
  const ids = guesses.map((g) => p.cities[g][0]);
  saved.save(p.date, done ? { guesses: ids, score: solved() ? guesses.length : 0, max: p.guesses } : { guesses: ids });
  render();
  if (done) {
    tally(el.summary);
    el.summary.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    el.board.closest(".sid-clues")!.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

async function share(): Promise<void> {
  if (!puzzle) return;
  const text = shareText(puzzle, guesses, `${location.origin}${location.pathname}`);
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
  const base = productBase(import.meta.env.VITE_DATA_BASE, "games/station", siteRoot);
  const asked = new URLSearchParams(location.search).get("date");
  const day = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : null;
  try {
    const res = await fetch(new URL(day ? `${day}.json` : "latest.json", base), { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const p = (await res.json()) as SPuzzle;
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
  el.howtoCities.replaceChildren(h("b", "fx", String(p.cities.length)), " cities");
  el.leftout.textContent = p.spot.length
    ? `Today's clues leave out ${listOf(p.spot.map((f) => FAMILY_WORDS[f] ?? f))}: they're in Wx Marks the Spot.`
    : "";
  const options = p.cities.map((_, k) => {
    labels.set(label(k).toLowerCase(), k);
    const o = document.createElement("option");
    o.value = label(k);
    return o;
  });
  el.cityList.replaceChildren(...options);
  const ids = new Map(p.cities.map((c, k) => [c[0], k]));
  const before = saved.load()[p.date]?.guesses ?? [];
  guesses = before.map((id) => ids.get(id)).filter((k): k is number => k !== undefined).slice(0, p.guesses);
  // A day finished before its score was saved: save it now, for the landing page
  if (isDone() && saved.load()[p.date]?.score === undefined) {
    saved.save(p.date, { guesses: before, score: solved() ? guesses.length : 0, max: p.guesses });
  }
  render();
}

el.canvas.addEventListener("pointermove", (ev) => {
  if (!view || ev.pointerType === "touch") return;
  const rect = el.canvas.getBoundingClientRect();
  const k = nearest(ev.clientX - rect.left, ev.clientY - rect.top, 12);
  if (k === hovered) return;
  hovered = k;
  showTip(k);
  el.canvas.style.cursor = k === null ? "default" : "pointer";
  drawMap();
});
el.canvas.addEventListener("pointerleave", () => {
  hovered = null;
  showTip(selected);
  if (view) drawMap();
});
el.canvas.addEventListener("click", (ev) => {
  if (!view) return;
  const rect = el.canvas.getBoundingClientRect();
  // A finger needs more room than a mouse
  const reach = coarse() ? 24 : 14;
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  if (coarse() && !zoom && view.xy.filter((pt) => pt && (pt[0] - x) ** 2 + (pt[1] - y) ** 2 <= reach * reach).length > 1) {
    const ll = view.proj.invert?.([x, y]);
    if (ll) {
      showTip(null);
      setZoom(ll as [number, number]);
      return;
    }
  }
  const k = nearest(x, y, reach);
  if (k === null) return;
  choose(k);
  showTip(k);
});
el.unzoom.addEventListener("click", () => {
  setZoom(null);
  showTip(selected);
});
el.search.addEventListener("input", () => {
  const k = labels.get(el.search.value.trim().toLowerCase());
  if (k !== undefined) {
    choose(k);
    showTip(k);
  }
});
el.search.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" || !puzzle) return;
  const q = el.search.value.trim().toLowerCase();
  // A whole name, or the only city that starts with what's typed
  let k = labels.get(q);
  if (k === undefined && q) {
    const hits = [...labels].filter(([name]) => name.startsWith(q));
    if (hits.length === 1) k = hits[0][1];
  }
  if (k === undefined) return;
  if (k === selected) guess();
  else {
    choose(k);
    showTip(k);
  }
});
el.guess.addEventListener("click", guess);
el.share.addEventListener("click", () => void share());
let wrapWidth = 0;
new ResizeObserver(([e]) => {
  const w = Math.round(e.contentRect.width);
  if (!puzzle || w === wrapWidth) return;
  wrapWidth = w;
  drawMap();
  showTip(hovered ?? selected);
}).observe(el.wrap);
void start();
