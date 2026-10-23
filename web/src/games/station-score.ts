// Station ID: the puzzle's shape, how its clues read, the distance bands and
// the share text. The puzzle is written by the pipeline (`wxtrend game
// station`, games/station.py), which documents the rules; this file only reads it.
import type { Units } from "../units";
import type { Area } from "./score";

/** [id, city, state, the station's name as the NWS writes it, lat, lon] */
export type CityRow = [string, string, string, string, number, number];

export interface Card {
  /** "clock", a measured family ("dew", "wind"…), "month", "normals" or "records". */
  id: string;
  items: string[];
}

export interface SPuzzle {
  v: 1;
  game: "station";
  date: string;
  number: number;
  made: string;
  credit: { text: string; url: string };
  area: Area;
  guesses: number;
  /** Band edges in miles, nearest first (200, 500, 1,000: four bands). */
  bands: number[];
  /** The families today's Wx Marks the Spot shows, which the clues leave out. */
  spot: string[];
  cities: CityRow[];
  answer: number;
  /** One a guess, in order. */
  cards: Card[];
  /** Each item's value at every city, in the cities' order (null: not in its report). */
  values: Record<string, (number | null)[]>;
}

export function checkPuzzle(p: SPuzzle): void {
  if (p.v !== 1 || p.game !== "station") throw new Error(`unsupported puzzle ${p.game} v${p.v}`);
  if (!p.cities?.length || !p.cards?.length || !(p.answer >= 0 && p.answer < p.cities.length)) {
    throw new Error("the puzzle is incomplete");
  }
  for (const c of p.cards) {
    for (const i of c.items) {
      if (p.values[i]?.length !== p.cities.length) throw new Error(`clue ${i} is malformed`);
    }
  }
}

// ------------------------------------------------------------------ distance

export function distanceMi(a: CityRow, b: CityRow): number {
  const rad = Math.PI / 180;
  const dp = (b[4] - a[4]) * rad;
  const dl = (b[5] - a[5]) * rad;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(a[4] * rad) * Math.cos(b[4] * rad) * Math.sin(dl / 2) ** 2;
  return (2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)))) / 1.609344;
}

/** A guess's band: 0 near, then outward; the answer itself is -1. */
export function bandOf(p: SPuzzle, guess: number): number {
  if (guess === p.answer) return -1;
  const mi = distanceMi(p.cities[guess], p.cities[p.answer]);
  return p.bands.filter((e) => mi >= e).length;
}

const KM_PER_MI = 1.609344;

/** A band in words: "Under 300 mi", "300–800 mi", "Over 800 mi" (km for Celsius players). */
export function bandLabel(p: SPuzzle, band: number, units: Units): string {
  const km = units.temp === "C";
  const d = (mi: number) => (km ? Math.round((mi * KM_PER_MI) / 10) * 10 : mi).toLocaleString("en-US");
  const unit = km ? "km" : "mi";
  if (band < 0) return "Found it";
  if (band === 0) return `Under ${d(p.bands[0])} ${unit}`;
  if (band >= p.bands.length) return `Over ${d(p.bands[p.bands.length - 1])} ${unit}`;
  return `${d(p.bands[band - 1])}–${d(p.bands[band])} ${unit}`;
}

const BAND_WORDS = ["Near", "Mid", "Far", "Way off"];
const BAND_SQUARES = ["🟨", "🟧", "🟥", "⬛"];

/** The band's word, for the guess chips: nearest first. */
export function bandWord(band: number): string {
  return band < 0 ? "Found" : BAND_WORDS[Math.min(band, BAND_WORDS.length - 1)];
}

/** One square a guess: the band, or green for the answer. */
export function bandSquare(band: number): string {
  return band < 0 ? "🟩" : BAND_SQUARES[Math.min(band, BAND_SQUARES.length - 1)];
}

// ------------------------------------------------------------------ clues

/** A clue's line: its label, its text at a city, and a number to compare cities by (if it has one). */
export interface Row {
  label: string;
  text: (get: Getter, units: Units) => string | null;
  num?: (get: Getter) => number | null;
}

type Getter = (item: string) => number | null;

const tempOf = (f: number, units: Units) => (units.temp === "C" ? `${Math.round(((f - 32) * 5) / 9)} °C` : `${Math.round(f)} °F`);
const speedOf = (mph: number, units: Units) =>
  units.speed === "kt" ? `${Math.round(mph / 1.150779)} kt` : `${Math.round(mph)} mph`;
const inchesOf = (v: number) => (v > 0 && v < 0.005 ? "Trace" : `${v.toFixed(2)} in`);

/** Minutes after local standard midnight: "3:29 pm". */
export function clockOf(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  const ap = h < 12 ? "am" : "pm";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ap}`;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const compassOf = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** NWS average sky cover, 0 (clear) to 1 (overcast). */
export function skyOf(v: number): string {
  const word = v < 0.15 ? "Clear" : v < 0.4 ? "Mostly clear" : v < 0.65 ? "Partly cloudy" : v < 0.9 ? "Mostly cloudy" : "Cloudy";
  return `${word} (${v.toFixed(1)})`;
}

function departOf(d: number | null, units: Units): string {
  if (d === null) return "";
  const v = Math.round(units.temp === "C" ? (d * 5) / 9 : d);
  if (v === 0) return ", normal";
  return `, ${Math.abs(v)}° ${v > 0 ? "above" : "below"}`;
}

const one = (item: string, show: (v: number, units: Units) => string) =>
  (get: Getter, units: Units) => {
    const v = get(item);
    return v === null ? null : show(v, units);
  };
const val = (item: string) => (get: Getter) => get(item);

function withYear(item: string) {
  return (get: Getter, units: Units) => {
    const v = get(item), y = get(`${item}_year`);
    return v === null ? null : y === null ? tempOf(v, units) : `${tempOf(v, units)} in ${y}`;
  };
}

/** Each card's lines. */
export const ROWS: Record<string, Row[]> = {
  clock: [
    { label: "High at", text: one("high_time", clockOf), num: val("high_time") },
    { label: "Low at", text: one("low_time", clockOf), num: val("low_time") },
    { label: "Sky", text: one("sky", skyOf), num: val("sky") },
  ],
  high: [{
    label: "High", num: val("high"),
    text: (get, u) => (get("high") === null ? null : `${tempOf(get("high")!, u)}${departOf(get("high_depart"), u)}`),
  }],
  low: [{
    label: "Low", num: val("low"),
    text: (get, u) => (get("low") === null ? null : `${tempOf(get("low")!, u)}${departOf(get("low_depart"), u)}`),
  }],
  rain: [{ label: "Rain", text: one("rain", inchesOf), num: val("rain") }],
  gust: [{
    label: "Peak gust", num: val("gust"),
    text: (get, u) => {
      const g = get("gust"), d = get("gust_dir");
      return g === null ? null : `${speedOf(g, u)}${d === null ? "" : ` from the ${compassOf(d)}`}`;
    },
  }],
  dew: [
    { label: "Highest dew point", text: one("dew_max", tempOf), num: val("dew_max") },
    { label: "Lowest dew point", text: one("dew_min", tempOf), num: val("dew_min") },
  ],
  wind: [{ label: "Average wind", text: one("wind", speedOf), num: val("wind") }],
  humid: [{ label: "Lowest humidity", text: one("humid", (v) => `${Math.round(v)}%`), num: val("humid") }],
  month: [
    { label: "Rain this month", text: one("rain_month", inchesOf), num: val("rain_month") },
    { label: "Normal by now", text: one("rain_month_normal", inchesOf), num: val("rain_month_normal") },
  ],
  normals: [
    { label: "Normal high", text: one("normal_high", tempOf), num: val("normal_high") },
    { label: "Normal low", text: one("normal_low", tempOf), num: val("normal_low") },
    { label: "Rain since Jan 1", text: one("rain_year", inchesOf), num: val("rain_year") },
    { label: "Normal by now", text: one("rain_year_normal", inchesOf), num: val("rain_year_normal") },
  ],
};
ROWS.record = [
  { label: "Record high", text: withYear("record_high"), num: val("record_high") },
  { label: "Record low", text: withYear("record_low"), num: val("record_low") },
];
ROWS.elevation = [{
  label: "Elevation", num: val("elev"),
  text: one("elev", (m, u) => (u.temp === "C" ? `${Math.round(m).toLocaleString("en-US")} m`
    : `${Math.round(m / 0.3048).toLocaleString("en-US")} ft`)),
}];
/** The usual last card; when the records fill a gap earlier, the elevation is last on its own. */
ROWS.records = [...ROWS.record, ...ROWS.elevation];

export const CARD_TITLES: Record<string, string> = {
  clock: "The day's clock", high: "The high", low: "The low", rain: "Rain", gust: "Gusts", dew: "Dew point",
  wind: "Wind", humid: "Humidity", month: "This month", normals: "Normals",
  records: "Records and height", record: "Records", elevation: "Height",
};

/** A city's values, by item. */
export function getter(p: SPuzzle, city: number): Getter {
  return (item) => p.values[item]?.[city] ?? null;
}

/**
 * Which way the mystery city's number lies from a guess's: "up" (higher),
 * "down", "same" (within a hair), or null when either is missing.
 */
export function compare(row: Row, guess: Getter, answer: Getter): "up" | "down" | "same" | null {
  if (!row.num) return null;
  const g = row.num(guess), a = row.num(answer);
  if (g === null || a === null) return null;
  const close = Math.max(Math.abs(a), 1) * 1e-6;
  return Math.abs(a - g) <= close ? "same" : a > g ? "up" : "down";
}

/** The families in plain words, for "Today's clues leave out …". */
export const FAMILY_WORDS: Record<string, string> = {
  high: "the high", low: "the low", gust: "gusts", rain: "rain", dew: "dew point", wind: "average wind",
  humid: "humidity", change: "the day-to-day change",
};

export function listOf(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

// ------------------------------------------------------------------ result

/** The spoiler-free result: "Station ID #3: 4/6" and a square a guess. */
export function shareText(p: SPuzzle, guesses: number[], url: string): string {
  const solved = guesses.includes(p.answer);
  return [
    `Station ID #${p.number}: ${solved ? guesses.length : "X"}/${p.guesses}`,
    guesses.map((g) => bandSquare(bandOf(p, g))).join(""),
    url,
  ].join("\n");
}

/** The stamp when the game ends. */
export function verdict(solvedIn: number | null): string {
  if (solvedIn === null) return "Out of guesses";
  return ["Unreal!", "Brilliant!", "Great!", "Nice!", "Got it!", "Phew!"][Math.min(solvedIn, 6) - 1];
}
