const HOUR = 3600_000;

/** "2026100818" -> Date (UTC). */
export function parseRunId(id: string): Date {
  if (!/^\d{10}$/.test(id)) throw new Error(`bad run id ${id}`);
  return new Date(
    Date.UTC(+id.slice(0, 4), +id.slice(4, 6) - 1, +id.slice(6, 8), +id.slice(8, 10)),
  );
}

export function runId(t: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}`;
}

export function addHours(t: Date, h: number): Date {
  return new Date(t.getTime() + h * HOUR);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-10-08 18Z" */
export function fmtTime(t: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}Z`;
}

/** "2026-10-09 05:12 UTC" */
export function fmtStamp(t: Date): string {
  return `${t.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "Tue 13 Oct 18Z" */
export function fmtShort(t: Date): string {
  const mon = t.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${DAYS[t.getUTCDay()]} ${String(t.getUTCDate()).padStart(2, "0")} ${mon} ${String(t.getUTCHours()).padStart(2, "0")}Z`;
}

export function fhrLabel(f: number): string {
  return `F${String(f).padStart(3, "0")}`;
}

// ------------------------------------------------------------------ zones

/** A time zone the site shows valid times in. US zones use their generic name (ET), not EST/EDT. */
export interface Zone {
  id: "ET" | "CT" | "MT" | "PT" | "AKT" | "HT" | "UTC";
  label: string;
  iana: string;
}

export const ZONES: Zone[] = [
  { id: "ET", label: "Eastern", iana: "America/New_York" },
  { id: "CT", label: "Central", iana: "America/Chicago" },
  { id: "MT", label: "Mountain", iana: "America/Denver" },
  { id: "PT", label: "Pacific", iana: "America/Los_Angeles" },
  { id: "AKT", label: "Alaska", iana: "America/Anchorage" },
  { id: "HT", label: "Hawaii", iana: "Pacific/Honolulu" },
  { id: "UTC", label: "UTC", iana: "UTC" },
];

export const UTC_ZONE = ZONES[ZONES.length - 1];

export function zoneById(id: string | null | undefined): Zone | undefined {
  return ZONES.find((z) => z.id === id);
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const partFormats = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock date and time of `t` in an IANA zone. */
export function zoneParts(t: Date, iana: string): Parts {
  let f = partFormats.get(iana);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: iana, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    });
    partFormats.set(iana, f);
  }
  const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
  return {
    year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute,
    weekday: DAYS.indexOf(p.weekday),
  };
}

/** Minutes the zone is ahead of UTC at `t` (ET in summer: -240). */
export function zoneOffset(t: Date, iana: string): number {
  const p = zoneParts(t, iana);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(t.getTime() / 60_000) * 60_000) / 60_000);
}

/**
 * The listed zone the browser is in, or UTC. A browser zone counts as a listed
 * one when its offsets in January and July match (Detroit is ET); Arizona's
 * year-round MST matches none, so it gets UTC rather than a wrong half the year.
 */
export function detectZone(browserIana: string | undefined, now = new Date()): Zone {
  if (!browserIana) return UTC_ZONE;
  const y = now.getUTCFullYear();
  const probes = [new Date(Date.UTC(y, 0, 15, 12)), new Date(Date.UTC(y, 6, 15, 12))];
  try {
    const want = probes.map((t) => zoneOffset(t, browserIana));
    return ZONES.find((z) => probes.every((t, i) => zoneOffset(t, z.iana) === want[i])) ?? UTC_ZONE;
  } catch {
    return UTC_ZONE; // an unknown zone name
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Wed 14 Oct 8 PM ET"; in UTC "Thu 15 Oct 00Z". */
export function fmtLocal(t: Date, zone: Zone): string {
  if (zone.id === "UTC") return fmtShort(t);
  const p = zoneParts(t, zone.iana);
  const h12 = p.hour % 12 || 12;
  const mm = p.minute ? `:${String(p.minute).padStart(2, "0")}` : "";
  return `${DAYS[p.weekday]} ${String(p.day).padStart(2, "0")} ${MONTHS[p.month - 1]} ${h12}${mm} ${p.hour < 12 ? "AM" : "PM"} ${zone.id}`;
}

/** "Thu 00Z" */
export function fmtZ(t: Date): string {
  return `${DAYS[t.getUTCDay()]} ${String(t.getUTCHours()).padStart(2, "0")}Z`;
}

/** A valid time: "Wed 14 Oct 8 PM ET · Thu 00Z", or "Thu 15 Oct 00Z" in UTC. */
export function fmtValid(t: Date, zone: Zone): string {
  if (zone.id === "UTC") return fmtShort(t);
  return `${fmtLocal(t, zone)} · ${fmtZ(t)}`;
}

/** Midnight starting the zone's calendar day that contains `t`. */
export function startOfDay(t: Date, zone: Zone): Date {
  const p = zoneParts(t, zone.iana);
  const wall = Date.UTC(p.year, p.month - 1, p.day);
  // The offset at midnight can differ from the offset at `t` on a DST change day
  let guess = wall - zoneOffset(t, zone.iana) * 60_000;
  guess = wall - zoneOffset(new Date(guess), zone.iana) * 60_000;
  return new Date(guess);
}

/** Calendar days from `now`'s day to `t`'s in the zone: 0 today, 1 tomorrow. */
export function daysFrom(now: Date, t: Date, zone: Zone): number {
  const a = zoneParts(now, zone.iana), b = zoneParts(t, zone.iana);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / (24 * HOUR));
}

/** "Day 3": today is Day 1, in the zone's calendar. Empty before today. */
export function dayLabel(now: Date, t: Date, zone: Zone): string {
  const n = daysFrom(now, t, zone) + 1;
  return n >= 1 ? `Day ${n}` : "";
}

/** "Tue 13" for a day tick. */
export function fmtDay(t: Date, zone: Zone): string {
  const p = zoneParts(t, zone.iana);
  return `${DAYS[p.weekday]} ${String(p.day).padStart(2, "0")}`;
}
