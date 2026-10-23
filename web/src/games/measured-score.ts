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

/** A time on the clock: "8 AM", "5:30 PM". */
function clock(d: Date, zone: string): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone }).replace(":00", "");
}

const weekday = (d: Date, zone: string) => d.toLocaleDateString("en-US", { weekday: "short", timeZone: zone });

/**
 * When the round is, shown big with its caption: "8 AM ET" and "5 AM PT", or
 * rain's "24 hours" and "2 AM Wed – 2 AM Thu ET".
 */
export function timeReadout(r: MRound): { value: string; caption: string } {
  const t = parseZ(r.valid);
  if (r.from) {
    const f = parseZ(r.from);
    const et = "America/New_York";
    return { value: "24 hours", caption: `${clock(f, et)} ${weekday(f, et)} – ${clock(t, et)} ${weekday(t, et)} ET` };
  }
  return { value: `${clock(t, "America/New_York")} ET`, caption: `${clock(t, "America/Los_Angeles")} PT` };
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

/** The forecast's run: "Sat 12Z". */
export function runLabel(r: MRound): string {
  const run = r.model.run;
  const t = new Date(Date.UTC(+run.slice(0, 4), +run.slice(4, 6) - 1, +run.slice(6, 8), +run.slice(8, 10)));
  return `${t.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })} ${run.slice(8, 10)}Z`;
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

/** How the forecast was off on average: "+3.7 °F" and "too warm", or "≈ 0" and "about right". */
export function bias(r: MRound, units: Units): { value: string; word: string } {
  const b = r.miss.bias;
  if (Math.abs(b) < SMALL[r.field]) return { value: "≈ 0", word: "about right" };
  return { value: `${b > 0 ? "+" : "−"}${formatDiff(r.field, b, units)}`, word: OFF[r.field][b > 0 ? 0 : 1] };
}

/** Why the average alone doesn't give the forecast away, when its map was moved: fine print under the tiles. */
export function shiftNote(r: MRound, units: Units): string | null {
  const moved = r.shift ?? 0;
  if (Math.abs(moved) < SMALL[r.field]) return null;
  return `The forecast map was moved ${formatDiff(r.field, moved, units)} ${MOVED[r.field][moved > 0 ? 0 : 1]} ` +
    "to match the measured average, so the average alone wouldn't give it away.";
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

/** The stamp on the day's score. */
export function rating(right: number, of: number): string {
  if (right === of) return "Perfect!";
  if (right >= of - 1) return "Sharp eyes!";
  if (right >= of / 2) return "Not bad";
  return "Fooled you!";
}

/** The stamp on a round. */
export const verdict = (right: boolean) => (right ? "Correct!" : "Wrong!");
