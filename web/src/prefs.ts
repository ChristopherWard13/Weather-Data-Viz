// Display preferences that belong to the viewer, not to a link: time zone,
// units, loop speed, the scrubber's zoom and map labels. Kept in localStorage.
import { detectZone, zoneById, type Zone } from "./time";
import { DEFAULT_UNITS, type Units } from "./units";

export interface DisplayPrefs {
  zone: Zone["id"];
  units: Units;
  /** Loop speed, frames a second. */
  fps: number;
  /** The scrubber shows Days 1–7 instead of every model's whole range. */
  zoom: boolean;
  /** Cities and state abbreviations on the map (Q7). */
  labels: boolean;
}

export const FPS_OPTIONS = [1, 2, 3, 4, 6, 8];
export const DEFAULT_FPS = 2;

const KEY = "rtr:display";

/** Stored prefs, each falling back to its default; a first visit takes the browser's zone when it's a listed one. */
export function parsePrefs(raw: string | null, browserZone: string | undefined, now = new Date()): DisplayPrefs {
  let p: Partial<DisplayPrefs> = {};
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (v && typeof v === "object") p = v as Partial<DisplayPrefs>;
  } catch {
    // A damaged entry is replaced on the next save
  }
  const units: Partial<Units> = p.units && typeof p.units === "object" ? p.units : {};
  return {
    zone: zoneById(p.zone)?.id ?? detectZone(browserZone, now).id,
    units: {
      speed: units.speed === "mph" || units.speed === "kt" ? units.speed : DEFAULT_UNITS.speed,
      temp: units.temp === "C" || units.temp === "F" ? units.temp : DEFAULT_UNITS.temp,
    },
    fps: FPS_OPTIONS.includes(p.fps as number) ? (p.fps as number) : DEFAULT_FPS,
    zoom: p.zoom === true,
    labels: p.labels !== false,
  };
}

export function loadPrefs(): DisplayPrefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // Storage blocked (private mode): defaults
  }
  return parsePrefs(raw, Intl.DateTimeFormat().resolvedOptions().timeZone);
}

export function savePrefs(p: DisplayPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Storage blocked: the choice lasts for this page only
  }
}
