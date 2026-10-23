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

export type Kind =
  | "hottest" | "coldest" | "gust" | "wettest" | "muggiest" | "warmup" | "cooldown"
  // From puzzle v3: the families drawn each day (games/draft.py)
  | "coolhigh" | "lowdew" | "windiest" | "lowhumid";

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
  /** The stored unit: °F, kt, in or %. */
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
  /** It replaced a dry day's rain round (v3; in v2 the highest dew point always did). */
  swapped?: boolean;
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
  v: 2 | 3;
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
  if ((p.v !== 2 && p.v !== 3) || p.game !== "spot") throw new Error(`unsupported puzzle ${p.game} v${p.v}`);
  if (!p.rounds.length || !p.scoring || !p.area) throw new Error("the puzzle is incomplete");
  for (const r of p.rounds) {
    // v2's dry-day round is always the highest dew point
    if (p.v === 2 && r.kind === "muggiest") r.swapped = true;
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
export const lowWins = (kind: Kind) =>
  kind === "coldest" || kind === "cooldown" || kind === "coolhigh" || kind === "lowdew" || kind === "lowhumid";

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
  return unit === "%" ? `${sign}${text}%` : `${sign}${text} ${unit}`;
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

/** A round's tier, the same cut-offs as its square: 3 best, 0 worst. */
export function tier(points: number): 0 | 1 | 2 | 3 {
  return points >= 900 ? 3 : points >= 600 ? 2 : points >= 300 ? 1 : 0;
}

/** The stamp on a round's result. */
export function rating(points: number, max: number): string {
  if (points >= max) return "Perfect!";
  return ["Missed it", "Not bad", "Great!", "Awesome!"][tier(points)];
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
  /** The answer's value, shown big: "93 °F", "+17 °F". */
  value: string;
  /** What the value is: "Highest high". */
  caption: string;
  /** The round's fine print, when it has any. */
  rule?: string;
}

/** What a round asks, in the viewer's units. */
export function prompt(round: Round, units: Units): Prompt {
  const p = ask(round, formatValue(round, round.best, units));
  return round.swapped ? { ...p, rule: [DRY, p.rule].filter(Boolean).join(" ") } : p;
}

const DRY = "No station reached 0.10 in of rain.";

function ask(round: Round, value: string): Prompt {
  switch (round.kind) {
    case "hottest":
      return { label: "Hot spot", value, caption: "Highest high" };
    case "coldest":
      return { label: "Cold spot", value, caption: "Lowest low" };
    case "gust":
      return { label: "Windiest", value, caption: "Strongest gust" };
    case "wettest":
      return { label: "Wettest", value, caption: "Most rain", rule: "Midnight to midnight. Melted snow counts." };
    case "muggiest":
      return { label: "Muggiest", value, caption: "Highest dew point" };
    case "warmup":
      return { label: "Warm-up", value, caption: "Biggest rise in the high", rule: "Against the day before." };
    case "cooldown":
      return { label: "Cool-down", value, caption: "Biggest drop in the high", rule: "Against the day before." };
    case "coolhigh":
      return { label: "Cool spot", value, caption: "Coolest high" };
    case "lowdew":
      return { label: "Dry air", value, caption: "Lowest dew point" };
    case "windiest":
      return { label: "Breeziest", value, caption: "Highest average wind", rule: "Averaged over the day." };
    case "lowhumid":
      return { label: "Driest", value, caption: "Lowest humidity" };
  }
}

/** The puzzle's day: "Yesterday · Tue, Oct 20" when it was yesterday where the player is. */
export function dayLine(iso: string, now = new Date()): string {
  const [y, m, d] = iso.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const isYesterday = yesterday.getFullYear() === y && yesterday.getMonth() === m - 1 && yesterday.getDate() === d;
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" };
  return isYesterday
    ? `Yesterday · ${day.toLocaleDateString("en-US", opts)}`
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
