// Modeled or Measured (build plan G2): the puzzle's shape, wording, units and
// the share text. The puzzle is written by the pipeline (`wxtrend game
// measured`, games/measured.py), which documents the rules; this file only reads it.
import type { Units } from "../units";
import { decodeMap, type Area, type MapGrid } from "./score";

export type MKind = "morning" | "afternoon" | "dewpoint" | "gust" | "rain" | "morningdew";
export type MField = "t2m" | "d2m" | "gust" | "rain";

export interface MRound {
  kind: MKind;
  title: string;
  field: MField;
  /** The stored unit: °F, kt or in. */
  unit: string;
  decimals: number;
  /** The valid time (rain: the end of its 24 hours, which began at `from`), "YYYY-MM-DDTHH:MMZ". */
  valid: string;
  from?: string;
  /** value = byte * scale + offset; `nodata` bytes are missing. */
  scale: number;
  offset: number;
  nodata: number;
  /** Two maps on the puzzle's grid, one byte a point, base64. */
  maps: [string, string];
  /** Which of the two is the measured one. */
  answer: 0 | 1;
  /** What the measured map is: "Measured: NOAA's URMA, …". */
  measured: string;
  /** The forecast: its model, its run (YYYYMMDDHH) and how many hours ahead it was made. */
  model: { id: string; name: string; run: string; lead: number };
  /** How far off the forecast was where both maps show: RMS over the measured spread, RMS and mean, in `unit`. */
  miss: { score: number; rms: number; bias: number };
  /** How far the forecast map was moved to share the measured map's mean over land (0 for rain). */
  shift?: number;
  /** The blur on each map, in grid cells (sigma). */
  blur?: { model: number; measured: number };
}

export interface MPuzzle {
  v: 1;
  game: "measured";
  date: string;
  number: number;
  made: string;
  credit: { text: string; url: string }[];
  area: Area;
  grid: MapGrid;
  rounds: MRound[];
}

/** A round's pick: the map the player called measured. */
export type Pick = 0 | 1;

export function checkPuzzle(p: MPuzzle): void {
  if (p.v !== 1 || p.game !== "measured") throw new Error(`unsupported puzzle ${p.game} v${p.v}`);
  if (!p.rounds?.length || !p.grid || !p.area) throw new Error("the puzzle is incomplete");
  const n = p.grid.nx * p.grid.ny;
  for (const r of p.rounds) {
    if (r.maps?.length !== 2 || (r.answer !== 0 && r.answer !== 1) || r.maps.some((m) => (atob(m).length !== n))) {
      throw new Error(`round ${r.kind} is malformed`);
    }
  }
}

/** One of a round's maps, NaN where it's blank. */
export function roundValues(r: MRound, k: 0 | 1): Float32Array {
  return decodeMap({ data: r.maps[k], scale: r.scale, offset: r.offset, nodata: r.nodata } as Parameters<typeof decodeMap>[0]);
}

/** A stored value as the viewer reads it: "81 °F", "47 mph", "0.42 in". */
export function formatValue(field: MField, v: number, units: Units): string {
  if (field === "rain") return `${v.toFixed(2)} in`;
  if (field === "gust") return units.speed === "mph" ? `${Math.round(v * 1.150779)} mph` : `${Math.round(v)} kt`;
  return units.temp === "C" ? `${Math.round(((v - 32) * 5) / 9)} °C` : `${Math.round(v)} °F`;
}

/** A difference of stored values in the viewer's units, without a sign: "3.7 °F", "4 mph". */
export function formatDiff(field: MField, d: number, units: Units): string {
  const a = Math.abs(d);
  if (field === "rain") return `${a.toFixed(2)} in`;
  if (field === "gust") return units.speed === "mph" ? `${(a * 1.150779).toFixed(1)} mph` : `${a.toFixed(1)} kt`;
  return units.temp === "C" ? `${((a * 5) / 9).toFixed(1)} °C` : `${a.toFixed(1)} °F`;
}

const parseZ = (s: string) => new Date(s.replace(/Z$/, ":00Z"));

function clock(d: Date, zone: string): string {
  const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });
  return t.replace(":00", "").replace(" AM", " a.m.").replace(" PM", " p.m.");
}

function weekday(d: Date, zone: string): string {
  return d.toLocaleDateString("en-US", { weekday: "long", timeZone: zone });
}

/** When the round is: "5 p.m. Eastern, 2 p.m. Pacific", or rain's "the 24 hours from 2 a.m. Wednesday to 2 a.m. Thursday, Eastern". */
export function whenLine(r: MRound): string {
  const t = parseZ(r.valid);
  if (r.from) {
    const f = parseZ(r.from);
    return `the 24 hours from ${clock(f, "America/New_York")} ${weekday(f, "America/New_York")} to ` +
      `${clock(t, "America/New_York")} ${weekday(t, "America/New_York")}, Eastern`;
  }
  return `${clock(t, "America/New_York")} Eastern, ${clock(t, "America/Los_Angeles")} Pacific`;
}

/** What the maps show. */
export function fieldLine(r: MRound): string {
  switch (r.field) {
    case "t2m":
      return "Temperature";
    case "d2m":
      return "Dew point";
    case "gust":
      return "Wind gusts";
    case "rain":
      return "Rain and melted snow";
  }
}

/** The forecast's run and lead: "GFS's run from Saturday 12Z, 4½ days ahead". */
export function forecastLine(r: MRound): string {
  const run = r.model.run;
  const t = new Date(Date.UTC(+run.slice(0, 4), +run.slice(4, 6) - 1, +run.slice(6, 8), +run.slice(8, 10)));
  const day = t.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return `${r.model.name}'s forecast from its ${day} ${run.slice(8, 10)}Z run, about ${leadDays(r)} days ahead`;
}

/** The forecast's lead to the nearest half day: "4½". */
export function leadDays(r: MRound): string {
  const halves = Math.round(r.model.lead / 12);
  return `${Math.floor(halves / 2)}${halves % 2 ? "½" : ""}`;
}

const SMALL: Record<MField, number> = { t2m: 0.5, d2m: 0.5, gust: 1, rain: 0.01 };
const OFF: Record<MField, [string, string]> = {
  t2m: ["too warm", "too cold"],
  d2m: ["too humid", "too dry"],
  gust: ["too gusty", "not gusty enough"],
  rain: ["too wet", "too dry"],
};
const MOVED: Record<MField, [string, string]> = {
  t2m: ["cooler", "warmer"],
  d2m: ["drier", "more humid"],
  gust: ["calmer", "gustier"],
  rain: ["drier", "wetter"],
};

/**
 * How the forecast was off on average, and how far its map was moved to share
 * the measured average: "On average it ran 3.7 °F too warm. Its map was moved
 * 3.7 °F cooler, so the average alone wouldn't give it away."
 */
export function biasLine(r: MRound, units: Units): string {
  const b = r.miss.bias;
  const moved = r.shift ?? 0;
  const ran = Math.abs(b) < SMALL[r.field]
    ? "On average it was close: its misses were in where, not how much."
    : `On average it ran ${formatDiff(r.field, b, units)} ${OFF[r.field][b > 0 ? 0 : 1]}.`;
  if (Math.abs(moved) < SMALL[r.field]) return ran;
  return `${ran} Its map was moved ${formatDiff(r.field, moved, units)} ${MOVED[r.field][moved > 0 ? 0 : 1]}, ` +
    "so the average alone wouldn't give it away.";
}

/** One square a round. */
export const square = (right: boolean) => (right ? "🟩" : "🟥");

/** The spoiler-free result to share. */
export function shareText(p: MPuzzle, right: boolean[], url: string): string {
  return [
    `Modeled or Measured #${p.number}: ${right.filter(Boolean).length}/${p.rounds.length}`,
    right.map(square).join(""),
    url,
  ].join("\n");
}

/** A word for the day's score. */
export function rating(right: number, of: number): string {
  if (right === of) return "Perfect: you can tell the real atmosphere from a model's.";
  if (right >= of - 1) return "Sharp eyes.";
  if (right >= of / 2) return "Not bad: the models are good at looking real.";
  return "The models fooled you today.";
}
