// Wx Marks the Spot: the puzzle's shape, scoring, wording and the share text.
// The puzzle is written by the pipeline (`wxtrend game spot`, games/spot.py),
// which documents the rules; this file only reads it.
import { DEFAULT_UNITS, type Units } from "../units";

export interface Area {
  id: string;
  label: string;
  lat: [number, number];
  lon: [number, number];
}

export type Kind = "hottest" | "coldest" | "gust" | "wettest" | "muggiest" | "warmup" | "cooldown";

/** A 0.5° grid, rows north to south (dlat < 0), as the site's display grids. */
export interface MapGrid {
  lat0: number;
  lon0: number;
  dlat: number;
  dlon: number;
  ny: number;
  nx: number;
}

/** The day as GFS analysed it, shaded under the reveal (games/maps.py). */
export interface RoundMap {
  label: string;
  grid: MapGrid;
  /** value = byte * scale + offset; `nodata` bytes are missing. */
  scale: number;
  offset: number;
  nodata: number;
  /** One byte a point, base64. */
  data: string;
  /** The model maps' URL parameters for the same thing (m, v, var, run, t, acc). */
  link: Record<string, string>;
}

export interface Round {
  kind: Kind;
  /** The pipeline's plain name ("Hottest high"); the page words its own prompts. */
  title: string;
  /** The stored unit: °F, kt or in. */
  unit: string;
  decimals: number;
  /** The top value, and the median: value points start above it. */
  best: number;
  floor: number;
  /** Station indexes of the top spot: every station tied at `best`. */
  top: number[];
  /** Station indexes and their values, every station that counted. */
  i: number[];
  v: number[];
  map?: RoundMap;
}

export interface Scoring {
  /** Points for how extreme the weather was at the station nearest the pin… */
  value: number;
  /** …and for how close the pin is to the top spot: full within full_km, then exp(-(d - full_km) / scale_km). */
  distance: number;
  full_km: number;
  scale_km: number;
  /** No counted station this close to the pin: no value points. */
  reach_km: number;
}

/** [id, name, state, lat, lon] */
export type StationRow = [string, string, string, number, number];

export interface Puzzle {
  v: 2;
  game: "spot";
  date: string;
  number: number;
  made: string;
  credit: { text: string; url: string };
  area: Area;
  scoring: Scoring;
  stations: StationRow[];
  rounds: Round[];
}

/** A pin: [lon, lat]. */
export type Guess = [number, number];

export function checkPuzzle(p: Puzzle): void {
  if (p.v !== 2 || p.game !== "spot") throw new Error(`unsupported puzzle ${p.game} v${p.v}`);
  if (!p.rounds.length || !p.scoring || !p.area) throw new Error("the puzzle is incomplete");
  for (const r of p.rounds) {
    if (r.i.length !== r.v.length || !r.top.length || r.top.some((s) => valueAt(r, s) !== r.best)) {
      throw new Error(`round ${r.kind} is malformed`);
    }
  }
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dp = (lat2 - lat1) * rad;
  const dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The lowest value wins these rounds. */
export const lowWins = (kind: Kind) => kind === "coldest" || kind === "cooldown";

export interface NearStation {
  station: number;
  km: number;
  value: number;
  /** The share of the other stations it beat (ties count half), 0 to 1. */
  beat: number;
}

export interface RoundScore {
  points: number;
  /** Points for the weather at the station nearest the pin, which is `near` (null: none within reach). */
  valuePoints: number;
  near: NearStation | null;
  /** Points for the distance to the top spot: `top`, the nearest station tied for it, `km` away. */
  distancePoints: number;
  top: number;
  km: number;
}

/**
 * How extreme a value is, 0 to 1: its rank among the round's stations (above
 * the middle, squared) or how far it is from the median toward the top,
 * whichever is kinder. The rank rewards being in the right area on a day
 * with one standout; the distance rewards a value just short of the top
 * when a heat wave covers half the country.
 */
export function extremeness(round: Round, value: number): { share: number; beat: number } {
  const sign = lowWins(round.kind) ? -1 : 1;
  const n = round.v.length;
  let less = 0, same = 0;
  for (const x of round.v) {
    if (sign * x < sign * value) less++;
    else if (x === value) same++;
  }
  const beat = n > 1 ? Math.max(0, less + (same - 1) / 2) / (n - 1) : 1;
  if (value === round.best) return { share: 1, beat: 1 };
  const byRank = Math.max(0, (beat - 0.5) / 0.5) ** 2;
  const span = sign * (round.best - round.floor);
  const byGap = span > 0 ? Math.min(1, Math.max(0, (sign * (value - round.floor)) / span)) : 0;
  return { share: Math.max(byRank, byGap), beat };
}

export function scoreRound(round: Round, stations: StationRow[], guess: Guess, scoring: Scoring): RoundScore {
  const [lon, lat] = guess;
  let top = round.top[0], km = Infinity;
  for (const s of round.top) {
    const d = haversineKm(lat, lon, stations[s][3], stations[s][4]);
    if (d < km) [top, km] = [s, d];
  }
  const f = km <= scoring.full_km ? 1 : Math.exp(-(km - scoring.full_km) / scoring.scale_km);
  const distancePoints = Math.round(scoring.distance * f);

  let k = -1, nearKm = Infinity;
  round.i.forEach((s, j) => {
    const d = haversineKm(lat, lon, stations[s][3], stations[s][4]);
    if (d < nearKm) [k, nearKm] = [j, d];
  });
  let near: NearStation | null = null;
  let valuePoints = 0;
  if (k >= 0 && nearKm <= scoring.reach_km) {
    const { share, beat } = extremeness(round, round.v[k]);
    near = { station: round.i[k], km: nearKm, value: round.v[k], beat };
    valuePoints = Math.round(scoring.value * share);
  }
  return { points: valuePoints + distancePoints, valuePoints, near, distancePoints, top, km };
}

/** The value of a round's station, or undefined if it didn't count. */
export function valueAt(round: Round, station: number): number | undefined {
  const k = round.i.indexOf(station);
  return k < 0 ? undefined : round.v[k];
}

/** A day-to-day change, not a temperature: converted without an offset. */
const isChange = (kind: Kind) => kind === "warmup" || kind === "cooldown";

/**
 * Units for the game: the viewer's site units when they've chosen some,
 * otherwise mph (the site's default is knots, for model watchers; the games
 * are for everyone).
 */
export function gameUnits(stored: Units | null): Units {
  return stored ?? { ...DEFAULT_UNITS, speed: "mph" };
}

/** A stored value as the viewer reads it: "81 °F", "47 mph", "0.42 in", "+18 °F" (changes carry a sign unless `bare`). */
export function formatValue(round: Pick<Round, "kind" | "unit" | "decimals">, v: number, units: Units, bare = false): string {
  let value = v;
  let unit = round.unit;
  let decimals = round.decimals;
  if (round.unit === "°F" && units.temp === "C") {
    value = isChange(round.kind) ? (v * 5) / 9 : ((v - 32) * 5) / 9;
    unit = "°C";
  } else if (round.unit === "kt" && units.speed === "mph") {
    value = v * 1.150779;
    unit = "mph";
  }
  if (round.unit === "°F" || round.unit === "kt") decimals = 0;
  const text = Math.abs(value).toFixed(decimals);
  const zero = Number(text) === 0;
  const sign = bare || zero ? "" : isChange(round.kind) ? (value > 0 ? "+" : "−") : value < 0 ? "−" : "";
  return `${sign}${text} ${unit}`;
}

export function formatKm(km: number): string {
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString("en-US")} km`;
}

/** One square a round, by points. */
export function square(points: number): string {
  if (points >= 900) return "🟩";
  if (points >= 600) return "🟨";
  if (points >= 300) return "🟧";
  return "🟥";
}

/** The spoiler-free result to share. */
export function shareText(p: Puzzle, points: number[], url: string): string {
  const total = points.reduce((a, b) => a + b, 0);
  const max = (p.scoring.value + p.scoring.distance) * p.rounds.length;
  return [
    `Wx Marks the Spot #${p.number}: ${total.toLocaleString("en-US")}/${max.toLocaleString("en-US")}`,
    points.map(square).join(""),
    url,
  ].join("\n");
}

export interface Prompt {
  /** A short name for the round: "Hot spot". */
  label: string;
  /** The question, with the answer's value: "Where did it hit 93 °F?" */
  question: string;
  /** What exactly counts. */
  detail: string;
  /** How the station at a pin compares: "hotter than". */
  than: string;
}

/** What a round asks, in the viewer's units. */
export function prompt(round: Round, units: Units): Prompt {
  const v = formatValue(round, round.best, units, true);
  switch (round.kind) {
    case "hottest":
      return { label: "Hot spot", question: `Where did it hit ${v}?`, detail: "The day's highest temperature in the Lower 48.", than: "hotter than" };
    case "coldest":
      return { label: "Cold spot", question: `Where did it drop to ${v}?`, detail: "The day's lowest temperature in the Lower 48.", than: "colder than" };
    case "gust":
      return { label: "Windiest", question: `Where did the wind gust to ${v}?`, detail: "The day's strongest gust in the Lower 48.", than: "windier than" };
    case "wettest":
      return {
        label: "Wettest", question: `Where did ${v} of rain fall?`,
        detail: "The day's biggest total in the Lower 48, midnight to midnight. Melted snow counts.", than: "wetter than",
      };
    case "muggiest":
      return {
        label: "Muggiest", question: `Where did the dew point reach ${v}?`,
        detail: "Nowhere got a tenth of an inch of rain, so: the day's most humid air in the Lower 48.", than: "more humid than",
      };
    case "warmup":
      return {
        label: "Warm-up", question: `Where was it ${v} warmer than the day before?`,
        detail: "The biggest rise in the day's high in the Lower 48.", than: "warmed up more than",
      };
    case "cooldown":
      return {
        label: "Cool-down", question: `Where was it ${v} colder than the day before?`,
        detail: "The biggest drop in the day's high in the Lower 48.", than: "cooled down more than",
      };
  }
}

/** The puzzle's day: "Yesterday, Tuesday, October 20" when it was yesterday where the player is. */
export function dayLine(iso: string, now = new Date()): string {
  const [y, m, d] = iso.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const isYesterday = yesterday.getFullYear() === y && yesterday.getMonth() === m - 1 && yesterday.getDate() === d;
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" };
  return isYesterday
    ? `Yesterday, ${day.toLocaleDateString("en-US", opts)}`
    : day.toLocaleDateString("en-US", { ...opts, year: "numeric" });
}

/** A map's values, NaN where missing. */
export function decodeMap(map: RoundMap): Float32Array {
  const bytes = atob(map.data);
  const out = new Float32Array(bytes.length);
  for (let k = 0; k < bytes.length; k++) {
    const q = bytes.charCodeAt(k);
    out[k] = q === map.nodata ? NaN : q * map.scale + map.offset;
  }
  return out;
}
