// Wx Marks the Spot (build plan G1): the page at /play/spot/. One puzzle a
// day from the data bucket (games/spot/latest.json, or ?date=YYYY-MM-DD);
// pins and scores stay in this browser (rtr:game:spot).
import "../styles.css";
import "./games.css";
import { geoPath, type GeoProjection } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryObject } from "topojson-specification";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import basemap from "../assets/basemap-50m.topo.json";
import { drawBasemap } from "../basemap";
import { renderColorbar, type ColorbarSpec } from "../colorbar";
import { loadManifest, productBase } from "../manifest";
import {
  buildLut, DEWPT_F, PRECIP_DRY, QPF_TOTAL_BINS, QPF_TOTAL_COLORS, redBlue, rgbaOf, stopsColor, TEMP_F, WIND_KT,
  type ColorFn,
} from "../palettes";
import { parsePrefs } from "../prefs";
import { baseProjection, boxBounds, buildLookup, centralMeridian, domainOutline, type Lookup } from "../projection";
import { shadeBinned, shadeScalar } from "../raster";
import type { Grid } from "../types";
import { speedQ, tempQ, ticksIn, type Units } from "../units";
import {
  checkPuzzle, dayLine, decodeMap, formatKm, formatValue, gameUnits, lowWins, prompt, scoreRound, shareText, square,
  type Area, type Guess, type Kind, type Puzzle, type Round, type RoundScore,
} from "./score";

const KEY = "rtr:game:spot";
const KEEP_DAYS = 60;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  game: $("game"), number: $("number"), date: $("date"), chips: $<HTMLOListElement>("chips"),
  round: $("round"), count: $("round-count"), prompt: $("prompt"), detail: $("detail"), wrap: $("map-wrap"),
  canvas: $<HTMLCanvasElement>("map"), foot: $("foot"), result: $("result"), lock: $<HTMLButtonElement>("lock"),
  next: $<HTMLButtonElement>("next"), key: $("key"), keyBar: $("key-bar"), legend: $("legend"),
  summary: $("summary"), total: $("total"), squares: $("squares"), summaryRounds: $<HTMLOListElement>("summary-rounds"),
  share: $<HTMLButtonElement>("share"), shareNote: $("share-note"), banner: $("banner"),
};

/** An element with text (never HTML: station names come from IEM). */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}

// ------------------------------------------------------------------ colours

interface Shade {
  color: ColorFn;
  /** How the map's values are shaded, and the key under it. */
  lut?: ReturnType<typeof buildLut>;
  bins?: { edges: number[]; colors: [number, number, number, number][] };
  colorbar: (lo: number, hi: number, units: Units) => ColorbarSpec;
}

const tempColor = stopsColor(TEMP_F);
const dewColor = stopsColor(DEWPT_F);
const windColor = stopsColor(WIND_KT);
const CHANGE_LIMIT = 20;
const changeColor = redBlue(CHANGE_LIMIT);
const binColor = (v: number) => {
  let b = -1;
  for (let k = 0; k < QPF_TOTAL_BINS.length; k++) if (v >= QPF_TOTAL_BINS[k]) b = k;
  return b < 0 ? PRECIP_DRY : QPF_TOTAL_COLORS[b];
};

function continuous(color: ColorFn, unitsQ: (u: Units) => ReturnType<typeof tempQ>, every: number, suffix = "") {
  return (lo: number, hi: number, units: Units): ColorbarSpec => {
    const t = ticksIn(unitsQ(units), lo, hi, every);
    return { kind: "continuous", color, min: lo, max: hi, ticks: t.ticks, extend: "none", format: (v) => `${t.format(v)}${suffix}` };
  };
}

const TEMP: Shade = { color: tempColor, lut: buildLut(tempColor, -40, 120), colorbar: continuous(tempColor, (u) => tempQ(u, "F"), 10, "°") };
const SHADES: Record<Kind, Shade> = {
  hottest: TEMP,
  coldest: TEMP,
  muggiest: { color: dewColor, lut: buildLut(dewColor, -20, 80), colorbar: continuous(dewColor, (u) => tempQ(u, "F"), 10, "°") },
  gust: { color: windColor, lut: buildLut(windColor, 0, 80), colorbar: continuous(windColor, (u) => speedQ(u), 10) },
  wettest: {
    color: binColor,
    bins: { edges: QPF_TOTAL_BINS, colors: QPF_TOTAL_COLORS.map(rgbaOf) },
    colorbar: () => ({ kind: "bins", bins: QPF_TOTAL_BINS, colors: QPF_TOTAL_COLORS, label: "Inches" }),
  },
  warmup: {
    color: changeColor, lut: buildLut(changeColor, -CHANGE_LIMIT, CHANGE_LIMIT),
    colorbar: (_lo, _hi, u) => ({ kind: "diverging", color: changeColor, limit: CHANGE_LIMIT, scale: tempQ(u, "F").scale }),
  },
  cooldown: {
    color: changeColor, lut: buildLut(changeColor, -CHANGE_LIMIT, CHANGE_LIMIT),
    colorbar: (_lo, _hi, u) => ({ kind: "diverging", color: changeColor, limit: CHANGE_LIMIT, scale: tempQ(u, "F").scale }),
  },
};

// ------------------------------------------------------------------ the map

const topo = basemap as unknown as Topology<Record<"statePolys", GeometryObject>>;
const statePolys = (feature(topo, topo.objects.statePolys) as unknown as FeatureCollection<Polygon | MultiPolygon>)
  .features as Feature<Polygon | MultiPolygon>[];

interface View {
  proj: GeoProjection;
  width: number;
  height: number;
}

function fit(area: Area, width: number, height: number): GeoProjection {
  const outline = { type: "MultiPoint" as const, coordinates: domainOutline(boxBounds(area), 0.5) };
  return baseProjection(centralMeridian(area)).fitExtent([[8, 8], [width - 8, height - 8]], outline);
}

/** The canvas's size: as wide as the page, as tall as the area's shape needs, leaving room for the buttons below. */
function sizeFor(area: Area): { width: number; height: number } {
  const width = Math.max(280, el.wrap.clientWidth);
  const p = fit(area, 1000, 1000);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const pt of domainOutline(boxBounds(area), 0.5)) {
    const [x, y] = p(pt as [number, number])!;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const aspect = (x1 - x0) / (y1 - y0);
  const height = Math.round(Math.min(width / aspect, Math.max(220, window.innerHeight - 300), width * 1.1));
  return { width, height: Math.max(220, height) };
}

/** Pixel lookups into a map's grid, by canvas size (every round shares the area). */
const lookups = new Map<string, Lookup>();
const decoded = new WeakMap<object, Float32Array>();

/**
 * The round's map, shaded at CSS-pixel resolution (the field is smooth) and
 * scaled to the canvas, over the Lower 48 only: the guessable area, without
 * the grid's curved edge out at sea.
 */
function shadeMap(ctx: CanvasRenderingContext2D, proj: GeoProjection, round: Round, width: number, height: number): void {
  const map = round.map!;
  const g = map.grid;
  const grid = { ...g, id: "game", lat_min: g.lat0 + g.dlat * (g.ny - 1), lat_max: g.lat0, lon_min: g.lon0,
    lon_max: g.lon0 + g.dlon * (g.nx - 1), row_order: "north_to_south", col_order: "west_to_east" } as Grid;
  const key = `${width}x${height}`;
  let lookup = lookups.get(key);
  if (!lookup) {
    lookup = buildLookup(proj, grid, width, height);
    lookups.set(key, lookup);
  }
  let values = decoded.get(map);
  if (!values) {
    values = decodeMap(map);
    decoded.set(map, values);
  }
  const image = new ImageData(width, height);
  const shade = SHADES[round.kind];
  if (shade.bins) shadeBinned(image.data, lookup, values, g.nx, shade.bins.edges, shade.bins.colors, [0, 0, 0, 0]);
  else shadeScalar(image.data, lookup, values, g.nx, shade.lut!);
  const off = document.createElement("canvas");
  off.width = width;
  off.height = height;
  off.getContext("2d")!.putImageData(image, 0, 0);
  ctx.save();
  const path = geoPath(proj, ctx);
  ctx.beginPath();
  for (const f of statePolys) path(f);
  ctx.clip();
  ctx.globalAlpha = 0.85;
  ctx.drawImage(off, 0, 0, width, height);
  ctx.restore();
}

function draw(round: Round, guess: Guess | null, score: RoundScore | null): View {
  const p = puzzle!;
  const { width, height } = sizeFor(p.area);
  const dpr = window.devicePixelRatio || 1;
  const c = el.canvas;
  c.width = Math.round(width * dpr);
  c.height = Math.round(height * dpr);
  c.style.width = `${width}px`;
  c.style.height = `${height}px`;
  const ctx = c.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const proj = fit(p.area, width, height);
  const path = geoPath(proj, ctx);

  ctx.fillStyle = "#e4e9f0";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  for (const f of statePolys) {
    ctx.beginPath();
    path(f);
    ctx.fill();
  }
  if (score && round.map) shadeMap(ctx, proj, round, width, height);
  drawBasemap(ctx, proj);

  if (score) drawReveal(ctx, proj, round, guess, score, width);
  else if (guess) drawPin(ctx, proj, guess);
  return { proj, width, height };
}

function drawReveal(ctx: CanvasRenderingContext2D, proj: GeoProjection, round: Round, guess: Guess | null,
                    score: RoundScore, width: number): void {
  const st = puzzle!.stations;
  const shade = SHADES[round.kind];
  const sign = lowWins(round.kind) ? -1 : 1;
  // About 1,400 dots: smaller on a phone, or they hide the map
  const radius = Math.max(1.5, Math.min(3.4, width / 370));
  // Every station that counted, mildest first so the extremes sit on top; dry stations aren't drawn
  const order = round.i.map((_, k) => k)
    .filter((k) => round.kind !== "wettest" || round.v[k] >= QPF_TOTAL_BINS[0])
    .sort((a, b) => sign * (round.v[a] - round.v[b]));
  for (const k of order) {
    const [, , , lat, lon] = st[round.i[k]];
    const xy = proj([lon, lat]);
    if (!xy) continue;
    ctx.beginPath();
    ctx.arc(xy[0], xy[1], radius, 0, 2 * Math.PI);
    ctx.fillStyle = shade.color(round.v[k]);
    ctx.fill();
    ctx.lineWidth = radius / 4;
    ctx.strokeStyle = "rgba(15, 23, 42, 0.6)";
    ctx.stroke();
  }
  // The station that set the pin's value points: a ring
  if (score.near) {
    const [, , , lat, lon] = st[score.near.station];
    const xy = proj([lon, lat]);
    if (xy) {
      ctx.beginPath();
      ctx.arc(xy[0], xy[1], 7.5, 0, 2 * Math.PI);
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#0f172a";
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
  }
  if (guess) {
    const [, , , lat, lon] = st[score.top];
    const a = proj(guess), b = proj([lon, lat]);
    if (a && b) {
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#0f172a";
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      ctx.restore();
    }
  }
  for (const s of round.top) {
    const [, , , lat, lon] = st[s];
    const xy = proj([lon, lat]);
    if (xy) drawStar(ctx, xy[0], xy[1]);
  }
  if (guess) drawPin(ctx, proj, guess);
}

/** The top spot: a white star on a dark disc. */
function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 11, 0, 2 * Math.PI);
  ctx.fillStyle = "#0f172a";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const r = k % 2 ? 3.2 : 7.2;
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
  }
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();
}

/** A map pin whose point is at the guess. */
function drawPin(ctx: CanvasRenderingContext2D, proj: GeoProjection, guess: Guess): void {
  const xy = proj(guess);
  if (!xy) return;
  const [x, y] = xy;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(x - 3, y - 9, x - 10, y - 13, x - 10, y - 21);
  ctx.arc(x, y - 21, 10, Math.PI, 0);
  ctx.bezierCurveTo(x + 10, y - 13, x + 3, y - 9, x, y);
  ctx.closePath();
  ctx.fillStyle = "#b2182b";
  ctx.shadowColor = "rgba(15, 23, 42, 0.35)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y - 21, 3.5, 0, 2 * Math.PI);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();
}

// ------------------------------------------------------------------ saved pins

type Saved = Record<string, { guesses: (Guess | null)[] }>;

function loadSaved(): Saved {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Saved) : {};
  } catch {
    return {};
  }
}

function save(date: string, guesses: (Guess | null)[]): void {
  const all = loadSaved();
  all[date] = { guesses };
  const days = Object.keys(all).sort().slice(-KEEP_DAYS);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(days.map((d) => [d, all[d]]))));
  } catch {
    // Storage blocked (private mode): the game still plays, it just won't be remembered
  }
}

/** The viewer's units from the site's display settings, if they've ever saved any. */
function viewerUnits(): Units {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem("rtr:display");
  } catch {
    raw = null;
  }
  return gameUnits(raw ? parsePrefs(raw, undefined).units : null);
}

// ------------------------------------------------------------------ the model maps' runs

const siteRoot = new URL("../../", document.baseURI).toString();

/** The GFS runs the model maps still have (they keep 48 hours), loaded at the first reveal. */
let gfsRuns: Promise<Set<string>> | null = null;

function mapsHave(run: string): Promise<boolean> {
  gfsRuns ??= loadManifest(productBase(import.meta.env.VITE_DATA_BASE, "gfs", siteRoot))
    .then((m) => new Set(m.runs.map((r) => r.id)))
    .catch(() => new Set<string>());
  return gfsRuns.then((runs) => runs.has(run));
}

function mapsUrl(link: Record<string, string>): string {
  const q = new URLSearchParams({ r: "us", mode: "fcst", ...link });
  return `${siteRoot}?${q.toString().replace(/%2C/g, ",")}`;
}

// ------------------------------------------------------------------ the game

let puzzle: Puzzle | null = null;
let guesses: (Guess | null)[] = [];
let current = 0; // the round being played (rounds.length once all are done)
let shown = 0; // the round on screen
let pending: Guess | null = null;
let summaryOpen = false;
let view: View | null = null;
const units = viewerUnits();

const scores = (): (RoundScore | null)[] =>
  puzzle!.rounds.map((r, k) => (guesses[k] ? scoreRound(r, puzzle!.stations, guesses[k]!, puzzle!.scoring) : null));

function stationLabel(s: number): string {
  const [, name, state] = puzzle!.stations[s];
  return `${name}, ${state}`;
}

/** "Phoenix/Sky Harbor, AZ" or "Laguna AAF, AZ and Phoenix/Sky Harbor, AZ". */
function topLabel(r: Round): (Node | string)[] {
  const out: (Node | string)[] = [];
  r.top.forEach((s, k) => {
    if (k) out.push(k === r.top.length - 1 ? " and " : ", ");
    out.push(h("strong", "", stationLabel(s)));
  });
  return out;
}

function render(): void {
  const p = puzzle!;
  const all = scores();
  const done = current >= p.rounds.length;
  el.game.dataset.state = done ? "done" : "playing";

  el.chips.replaceChildren(...p.rounds.map((r, k) => {
    const b = h("button", "chip");
    b.type = "button";
    b.disabled = k > current;
    if (k === shown) b.setAttribute("aria-current", "step");
    const s = all[k];
    if (s) b.append(h("span", "chip-sq", square(s.points)), h("span", "", String(s.points)));
    else b.append(h("span", "", String(k + 1)));
    b.title = `Round ${k + 1}: ${prompt(r, units).label}`;
    b.setAttribute("aria-label", s ? `Round ${k + 1}, ${s.points} points` : `Round ${k + 1}`);
    b.addEventListener("click", () => {
      shown = k;
      pending = null;
      render();
    });
    return h("li", "", b);
  }));

  const k = Math.min(shown, p.rounds.length - 1);
  const r = p.rounds[k];
  const score = all[k];
  const guess = guesses[k] ?? (k === current ? pending : null);
  const ask = prompt(r, units);
  el.count.textContent = `Round ${k + 1} of ${p.rounds.length} · ${ask.label}`;
  el.prompt.textContent = ask.question;
  el.detail.textContent = ask.detail;
  view = draw(r, guess, score);

  el.lock.hidden = !!score;
  el.lock.disabled = !pending;
  el.next.hidden = !score || k !== current - 1 || (done && summaryOpen);
  el.next.textContent = done ? "See my score" : "Next round";
  el.key.hidden = !score;
  if (score) {
    renderResult(r, score);
    renderKey(r);
  } else {
    el.result.replaceChildren(h("p", "round-hint",
      pending ? "Move it by clicking again, or lock it in." : "Click or tap the map to drop your pin."));
  }

  el.summary.hidden = !summaryOpen;
  if (summaryOpen) renderSummary(all as RoundScore[]);
}

function renderResult(r: Round, s: RoundScore): void {
  const p = puzzle!;
  const best = formatValue(r, r.best, units);
  const answer = r.top.length > 1
    ? h("p", "round-answer", ...topLabel(r), ` tied for the top: ${best}.`)
    : h("p", "round-answer", ...topLabel(r), ` had it: ${best}.`);
  const ask = prompt(r, units);
  let weather: string;
  if (!s.near) weather = `No station within ${p.scoring.reach_km} km of your pin`;
  else {
    const there = `${stationLabel(s.near.station)}, ${formatValue(r, s.near.value, units)}`;
    if (s.near.value === r.best) weather = `${there}: the top`;
    else if (r.kind === "wettest" && s.near.value === 0) weather = `${stationLabel(s.near.station)}: dry`;
    else if (s.near.beat < 0.5) weather = `${there}: not ${ask.than} most stations`;
    else weather = `${there}: ${ask.than} ${Math.floor(s.near.beat * 100)}% of stations`;
  }
  const line = (label: string, what: string, points: number, of: number) =>
    h("li", "", h("span", "rs-label", label), h("span", "rs-what", what), h("span", "rs-pts", `${points} / ${of}`));
  el.result.replaceChildren(
    answer,
    h("ul", "round-score",
      line("The weather at your pin", weather, s.valuePoints, p.scoring.value),
      line("Distance to the top spot", formatKm(s.km), s.distancePoints, p.scoring.distance)),
    h("p", "round-total", h("strong", "", `${s.points} points`)),
  );
}

function renderKey(r: Round): void {
  const shade = SHADES[r.kind];
  if (r.map) {
    const values = decoded.get(r.map) ?? decodeMap(r.map);
    let lo = Infinity, hi = -Infinity;
    for (const v of [...values, ...r.v]) {
      if (v === v) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    renderColorbar(el.keyBar, shade.colorbar(Math.floor(lo / 10) * 10, Math.ceil(hi / 10) * 10, units));
  } else {
    el.keyBar.replaceChildren();
  }
  const dots = r.kind === "wettest" ? "Dots: what each station measured (dry ones left off)." : "Dots: what each station measured.";
  const parts: (Node | string)[] = [
    r.map ? `Shading: ${r.map.label}. ` : "",
    `${dots} Star: the top spot. Ring: the station nearest your pin, which sets your points for the weather.`,
  ];
  el.legend.replaceChildren(...parts);
  if (r.map) {
    const link = r.map.link;
    void mapsHave(link.run).then((ok) => {
      if (!ok || puzzle?.rounds[Math.min(shown, puzzle.rounds.length - 1)] !== r) return;
      const a = h("a", "map-link", "Open this day in the model maps");
      a.href = mapsUrl(link);
      el.legend.append(" ", a);
    });
  }
}

function renderSummary(all: RoundScore[]): void {
  const p = puzzle!;
  const points = all.map((s) => s.points);
  const total = points.reduce((a, b) => a + b, 0);
  const max = (p.scoring.value + p.scoring.distance) * p.rounds.length;
  el.total.textContent = `${total.toLocaleString("en-US")} of ${max.toLocaleString("en-US")} points`;
  el.squares.textContent = points.map(square).join(" ");
  el.summaryRounds.replaceChildren(...p.rounds.map((r, k) => h("li", "",
    h("span", "sr-q", prompt(r, units).label),
    h("span", "sr-a", r.top.map(stationLabel).join(" and "), `, ${formatValue(r, r.best, units)}`),
    h("span", "sr-p", `${formatKm(all[k].km)} · `, h("strong", "", String(all[k].points))),
  )));
}

/** Keep the result and the round's buttons in view below the map. */
function showFoot(): void {
  el.foot.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function place(ev: MouseEvent): void {
  if (!puzzle || !view || shown !== current || current >= puzzle.rounds.length) return;
  const rect = el.canvas.getBoundingClientRect();
  const ll = view.proj.invert?.([ev.clientX - rect.left, ev.clientY - rect.top]);
  if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return;
  pending = [Math.round(ll[0] * 1000) / 1000, Math.round(ll[1] * 1000) / 1000];
  render();
  showFoot();
}

function lock(): void {
  if (!puzzle || !pending || shown !== current) return;
  guesses[current] = pending;
  pending = null;
  current += 1;
  save(puzzle.date, guesses);
  render();
  el.next.focus({ preventScroll: true });
  showFoot();
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
  const text = shareText(puzzle, (scores() as RoundScore[]).map((s) => s.points), url);
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
  // The page sits two levels below the site, whose data root is data/ beside it in dev
  const base = productBase(import.meta.env.VITE_DATA_BASE, "games/spot", siteRoot);
  const asked = new URLSearchParams(location.search).get("date");
  const day = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : null;
  try {
    const res = await fetch(new URL(day ? `${day}.json` : "latest.json", base), { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const p = (await res.json()) as Puzzle;
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
  const saved = loadSaved()[p.date]?.guesses ?? [];
  guesses = p.rounds.map((_, k) => saved[k] ?? null);
  current = guesses.findIndex((g) => !g);
  if (current < 0) current = p.rounds.length;
  shown = Math.min(current, p.rounds.length - 1);
  summaryOpen = current >= p.rounds.length;
  render();
}

el.canvas.addEventListener("click", place);
el.lock.addEventListener("click", lock);
el.next.addEventListener("click", next);
el.share.addEventListener("click", () => void share());
new ResizeObserver(() => puzzle && render()).observe(el.wrap);
void start();
