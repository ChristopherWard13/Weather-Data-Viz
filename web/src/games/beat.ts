// Beat the Models (build plan G4): the page at /play/beat/. Three days from the
// data bucket's games/beat/: the newest puzzle (latest.json), open for a call
// until the city's midnight; the day before, locked, with the models' calls
// once they're in (<date>.models.json); and the verdict (<date>.result.json).
// A verdict that came late, for a day this browser called, shows too.
// Calls stay in this browser (rtr:game:beat).
import "../styles.css";
import "./games.css";
import "./beat.css";
import { productBase } from "../manifest";
import {
  checkModels, checkPuzzle, countdown, dayName, easternTime, lockWords, mapsQuery, nextRun, pageDays, parseCall, RULES,
  runName, shareText, signed, stampOf, verdictOf, type BCall, type BCity, type BModels, type BPuzzle, type BResult,
} from "./beat-score";
import { h, savedDays, siteRoot } from "./gamemap";
import { countUp, tally } from "./tally";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  game: $("game"), number: $("number"), date: $("date"), hudCall: $("hud-call"), days: $("days"), banner: $("banner"),
  announce: $("announce"),
};

/** A day's call and when it was made; with its points (or that it was void) once its verdict has been shown. */
interface Saved {
  call: number;
  at: string;
  score?: number;
  max?: number;
  void?: boolean;
}
const saved = savedDays<Saved>("rtr:game:beat");

/** One day the page shows: whichever of its files are out. */
interface Day {
  date: string;
  puzzle: BPuzzle | null;
  models: BModels | null;
  result: BResult | null;
}

let days: Day[] = [];
/** What's typed in the open call's box, kept across renders. */
let draft = "";
/** The day open for a call when the page last rendered. */
let openDate: string | null = null;
/** Verdicts shown since the page loaded: an older one stays until the page is left. */
const shownVerdicts = new Set<string>();
/** How far back a late verdict for a day this browser called can be: VOID_AFTER_DAYS in beat.py. */
const LATE_DAYS = 2;

const base = productBase(import.meta.env.VITE_DATA_BASE, "games/beat", siteRoot);

async function getJson<T>(name: string): Promise<T | null> {
  try {
    const res = await fetch(new URL(name, base), { cache: "no-cache" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

const cityOf = (d: Day): BCity => (d.result ?? d.models ?? d.puzzle)!.city;
const lockOf = (d: Day): string => (d.result ?? d.models ?? d.puzzle)!.lock;
const numberOf = (d: Day): number => (d.result ?? d.models ?? d.puzzle)!.number;
const isOpen = (d: Day, now = new Date()) => !d.result && now < new Date(lockOf(d));

/** The day's call, if it was made before the lock. */
function callOf(d: Day): Saved | null {
  const s = saved.load()[d.date];
  return s && typeof s.call === "number" && new Date(s.at) < new Date(lockOf(d)) ? s : null;
}

/** "Sat, Oct 25", with "today" or "tomorrow" when it's the viewer's. */
function dayLabel(iso: string): string {
  const local = (k: number) => {
    const t = new Date();
    t.setDate(t.getDate() + k);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  };
  const rel = iso === local(0) ? "Today · " : iso === local(1) ? "Tomorrow · " : iso === local(-1) ? "Yesterday · " : "";
  return rel + dayName(iso);
}

function head(d: Day, kind: string, kindClass: string): HTMLElement {
  const c = cityOf(d);
  return h("div", "round-head",
    h("p", "badges", h("span", "badge badge-round fx", `#${numberOf(d)} · ${dayLabel(d.date)}`),
      h("span", `badge badge-kind fx ${kindClass}`, kind)),
    h("div", "btm-city", h("span", "btm-city-name fx", `${c.city}, ${c.state}`), h("span", "btm-station", c.station)));
}

function modelTiles(calls: BCall[]): HTMLElement {
  return h("ul", "btm-models", ...calls.map((m) =>
    h("li", "btm-model", h("span", "tile-label fx", m.name), h("span", "btm-model-call fx", `${m.call}°`),
      h("span", "btm-model-run", `${runName(m.run)} run`))));
}

// ------------------------------------------------------------------ the three kinds of day

function openCard(d: Day): HTMLElement {
  const p = d.puzzle!;
  const card = h("section", "round btm-day", head(d, "Your call", "btm-kind-open"));
  card.dataset.state = "open";
  const context = p.context.filter((r) => r.high !== null);
  const normal = [...p.context].reverse().find((r) => r.normal !== null)?.normal;
  if (context.length || normal != null) {
    card.append(h("p", "btm-context",
      ...(context.length ? [h("b", "", "Recent highs: "), context.map((r) => `${dayName(r.date, { weekday: "short" })} ${r.high}°F`).join(" · ")] : []),
      ...(normal != null ? [context.length ? " · " : "", `normal about ${normal}°F`] : [])));
  }
  const mine = callOf(d);
  const input = h("input", "btm-input fx");
  Object.assign(input, { id: "call", type: "text", inputMode: "numeric", autocomplete: "off", placeholder: "--" });
  input.setAttribute("aria-label", `Your call for the high in ${p.city.city}, °F`);
  input.value = draft || (mine ? String(mine.call) : "");
  const step = (by: number) => () => {
    const now = parseCall(input.value) ?? mine?.call ?? context.at(-1)?.high ?? normal ?? 60;
    input.value = String(now + (parseCall(input.value) === null ? 0 : by));
    draft = input.value;
    lockBtn.disabled = parseCall(input.value) === null;
  };
  const minus = h("button", "btn btn-pick btm-step fx", "−");
  const plus = h("button", "btn btn-pick btm-step fx", "+");
  minus.type = plus.type = "button";
  minus.setAttribute("aria-label", "One degree lower");
  plus.setAttribute("aria-label", "One degree higher");
  minus.addEventListener("click", step(-1));
  plus.addEventListener("click", step(1));
  const lockBtn = h("button", "btn btn-go fx", mine ? "Change call ▶" : "Lock in ▶");
  lockBtn.id = "lock";
  lockBtn.type = "button";
  lockBtn.disabled = parseCall(input.value) === null;
  input.addEventListener("input", () => {
    draft = input.value;
    lockBtn.disabled = parseCall(input.value) === null;
  });
  const submit = () => {
    const call = parseCall(input.value);
    if (call === null || !isOpen(d)) return;
    saved.save(d.date, { call, at: new Date().toISOString() });
    draft = "";
    render();
    $("call")?.focus();
    el.announce.textContent = `Locked in: ${call}°F.`;
  };
  lockBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  const label = h("label", "btm-call-label fx", `Call the high in ${p.city.city}`);
  label.htmlFor = "call";
  card.append(h("div", "btm-call", label,
    h("div", "btm-call-row", minus, h("span", "btm-input-wrap", input, h("span", "btm-unit fx", "°F")), plus, lockBtn)));
  const status = h("p", "btm-status");
  status.id = "status";
  status.textContent = statusLine(d);
  card.append(status);
  const link = h("a", "map-link fx", `See the models' maps for ${dayName(d.date, { weekday: "short" })} afternoon ▶`);
  link.href = `${siteRoot}?${mapsQuery(p).replace(/%2C/g, ",")}`;
  card.append(h("p", "btm-links", link));
  return card;
}

function statusLine(d: Day): string {
  const mine = callOf(d);
  const lock = `${lockWords(d.puzzle!)}, in ${countdown(lockOf(d), new Date())}`;
  return mine ? `Your call is ${mine.call}°F. You can change it until ${lock}.` : `Locks at ${lock}.`;
}

function lockedCard(d: Day): HTMLElement {
  const card = h("section", "round btm-day", head(d, "Locked", "btm-kind-locked"));
  card.dataset.state = "locked";
  const mine = callOf(d);
  card.append(h("p", "btm-yours", ...(mine ? [h("span", "", "Your call "), h("b", "fx", `${mine.call}°F`)]
    : ["You didn't call this one."])));
  if (d.models) {
    card.append(h("p", "btm-sub fx", "The models' calls"), modelTiles(d.models.models));
  } else {
    card.append(h("p", "btm-wait", `The models' calls come in about ${easternTime(`${d.date}T10:30:00Z`)}.`));
  }
  const next = new Date(`${d.date}T10:30:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const late = new Date() > new Date(next.getTime() + 3 * 3600e3);
  card.append(h("p", "btm-wait", late ? `${cityOf(d).city}'s climate report is late; the verdict comes once it's in.`
    : `Verdict: ${dayName(next.toISOString().slice(0, 10), { weekday: "long" })} about ${easternTime(next.toISOString())}.`));
  return card;
}

function verdictCard(d: Day): HTMLElement {
  const r = d.result!;
  const card = h("section", "round btm-day", head(d, "Verdict", "btm-kind-verdict"));
  card.dataset.state = "verdict";
  if (r.void || r.high === null) {
    card.append(h("p", "btm-wait", `No climate report came in for ${r.city.city}, so this day has no verdict.`));
    const s = callOf(d);
    if (s && !s.void) saved.save(d.date, { ...s, void: true });
    return card;
  }
  const mine = callOf(d);
  const v = verdictOf(r, mine?.call ?? null, d.puzzle?.rules ?? RULES);
  const stamp = stampOf(v);
  card.append(h("div", "btm-verdict",
    h("div", "readout", h("span", "readout-value fx", `${v.high}°`),
      h("span", "readout-caption", h("span", "readout-what fx", "It hit"), h("span", "readout-rule", "The climate report's high"))),
    h("p", `stamp fx stamp-${stamp.tier}`, stamp.text)));
  if (v.call !== null) {
    card.append(h("div", "tiles",
      h("div", "tile", h("span", "tile-label fx", "Your call"), h("span", "tile-num fx", `${v.call}°`)),
      h("div", "tile", h("span", "tile-label fx", "Off by"), h("span", "tile-num fx", String(Math.abs(v.miss!)), h("small", "", "°F"))),
      h("div", "tile tile-total", h("span", "tile-label fx", "Points"), h("span", "tile-num fx", countUp(v.points!)))));
  } else {
    card.append(h("p", "btm-yours", "You didn't call this one. Here's how the models did."));
  }
  const rows = v.rows.map((row) => {
    const tr = h("tr", row.id === "you" ? "btm-you" : "",
      h("td", "board-event", row.who), h("td", "", row.run ? `${runName(row.run)} run` : "Your call"),
      h("td", "board-num", `${row.call}°`), h("td", "board-num board-pts", signed(row.miss)));
    tr.dataset.tier = String(Math.abs(row.miss) >= (d.puzzle?.rules ?? RULES).bust ? 0 : Math.abs(row.miss) >= 3 ? 1
      : Math.abs(row.miss) >= 1 ? 2 : 3);
    return tr;
  });
  card.append(h("table", "board btm-board",
    h("thead", "", h("tr", "", h("th", "", "Who"), h("th", "", "Run"), h("th", "", "Call"), h("th", "", "Miss"))),
    h("tbody", "", ...rows)));
  if (v.call !== null) {
    const share = h("button", "btn btn-go fx", "Share result");
    share.type = "button";
    const shareNote = h("span", "share-note");
    shareNote.setAttribute("role", "status");
    share.addEventListener("click", () => void doShare(shareText(r, v, `${location.origin}${location.pathname}`), shareNote));
    card.append(h("div", "summary-actions", share, shareNote));
    const s = saved.load()[d.date]!;
    if (s.score === undefined) {
      saved.save(d.date, { ...s, score: v.points!, max: (d.puzzle?.rules ?? RULES).points });
      queueMicrotask(() => tally(card));
    }
  }
  return card;
}

async function doShare(text: string, out: HTMLElement): Promise<void> {
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ text });
      return;
    }
    await navigator.clipboard.writeText(text);
    out.textContent = "Copied. Paste it anywhere.";
  } catch (e) {
    // Closing the share sheet isn't a failure; anything else shows the text to copy by hand
    if ((e as Error).name !== "AbortError") out.textContent = text;
  }
}

// ------------------------------------------------------------------ the page

function render(): void {
  const now = new Date();
  const open = days.find((d) => isOpen(d, now));
  const top = open ?? days[0];
  el.number.textContent = `#${numberOf(top)}`;
  el.date.textContent = dayName(top.date, { weekday: "long", month: "short", day: "numeric" });
  const mine = open ? callOf(open) : null;
  el.hudCall.textContent = mine ? `${mine.call}°` : "--°";
  openDate = open?.date ?? null;
  // The newest verdict and any this browser hasn't seen, the days still waiting for one, and the open
  // call: oldest first, as the days come
  const newest = days.find((d) => d.result);
  const unseen = (d: Day) => {
    const s = callOf(d);
    return s !== null && s.score === undefined && !s.void;
  };
  const shown = days.filter((d) => (d.result ? d === newest || unseen(d) || shownVerdicts.has(d.date)
    : d.models || d.puzzle)).reverse();
  for (const d of shown) if (d.result) shownVerdicts.add(d.date);
  el.days.replaceChildren(...shown.map((d) => (d.result ? verdictCard(d) : isOpen(d, now) ? openCard(d) : lockedCard(d))));
  if (!open) {
    el.days.append(h("p", "btm-wait btm-next", `The next city is posted about ${easternTime(nextRun(now))}.`));
  }
  el.game.dataset.state = "playing";
}

function showBanner(text: string): void {
  el.banner.textContent = text;
  el.banner.hidden = false;
}

async function start(): Promise<void> {
  const latest = await getJson<BPuzzle>("latest.json");
  try {
    if (!latest) throw new Error("no latest.json");
    checkPuzzle(latest);
  } catch (e) {
    el.game.dataset.state = "error";
    showBanner("Today's city isn't posted yet. Check back soon.");
    console.warn("puzzle:", e);
    return;
  }
  const ok = <T extends BModels>(f: T | null) => {
    try {
      if (f) checkModels(f);
      return f;
    } catch {
      return null;
    }
  };
  // Each file only once it's due: the models' calls from games.yml's run on the day itself, the verdict
  // from the one the morning after (both 10:30Z); a day's puzzle when neither is there
  const now = Date.now();
  const run = (date: string, after: number) => Date.parse(`${date}T10:30:00Z`) + after * 86_400_000;
  // The newest puzzle's day and the two before it, and further back the days this browser called whose
  // verdict it hasn't shown (a report that came late)
  const kept = saved.load();
  const dates = pageDays(latest.date, 3 + LATE_DAYS).filter((date, k) =>
    k < 3 || (typeof kept[date]?.call === "number" && kept[date].score === undefined && !kept[date].void));
  days = await Promise.all(dates.map(async (date): Promise<Day> => {
    const result = now >= run(date, 1) ? ok(await getJson<BResult>(`${date}.result.json`)) : null;
    const models = !result && now >= run(date, 0) ? ok(await getJson<BModels>(`${date}.models.json`)) : null;
    const puzzle = date === latest.date ? latest : result || models ? null : await getJson<BPuzzle>(`${date}.json`);
    return { date, result, models, puzzle };
  }));
  render();
  // The countdown, and the open call locking while the page is open
  setInterval(() => {
    const open = days.find((d) => d.date === openDate);
    if (!open) return;
    if (!isOpen(open)) render();
    else document.getElementById("status")!.textContent = statusLine(open);
  }, 15_000);
}

void start();
