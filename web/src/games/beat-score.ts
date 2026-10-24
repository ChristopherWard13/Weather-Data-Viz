// Beat the Models (build plan G4): the puzzle's files, the verdict and the share text, without the page.

export interface BCity {
  id: string;
  city: string;
  state: string;
  station: string;
  lat: number;
  lon: number;
  elev: number;
  tz: string;
  region: string;
}

export interface Rules {
  points: number;
  per_degree: number;
  bust: number;
}

/** A day's puzzle (games/beat/<date>.json): published the morning before, open until the city's midnight. */
export interface BPuzzle {
  v: number;
  game: string;
  date: string;
  number: number;
  made: string;
  credit: { text: string; url: string };
  city: BCity;
  lock: string;
  day: [string, string];
  map: string;
  models: { id: string; name: string }[];
  context: { date: string; high: number | null; normal: number | null }[];
  rules: Rules;
}

/** A model's call: its high (°F, at the airport's elevation), rounded; its run; its ground (m); lead (h). */
export interface BCall {
  id: string;
  name: string;
  run: string;
  high: number;
  call: number;
  ground: number;
  lead: number;
}

/** The models' calls at the lock (<date>.models.json), and the verdict (<date>.result.json). */
export interface BModels {
  v: number;
  game: string;
  date: string;
  number: number;
  city: BCity;
  lock: string;
  models: BCall[];
}

export interface BResult extends BModels {
  high: number | null;
  void: boolean;
}

/** Points when the puzzle doesn't say (they're in every puzzle). */
export const RULES: Rules = { points: 100, per_degree: 20, bust: 5 };

export function checkPuzzle(p: BPuzzle): void {
  if (p.v !== 1 || p.game !== "beat") throw new Error(`unsupported puzzle ${p.game} v${p.v}`);
  if (!p.city?.id || !p.lock || !/^\d{4}-\d{2}-\d{2}$/.test(p.date) || !p.models?.length) {
    throw new Error("the puzzle is incomplete");
  }
}

export function checkModels(m: BModels): void {
  if (m.v !== 1 || m.game !== "beat" || !m.city?.id || !Array.isArray(m.models)) throw new Error("malformed models' calls");
}

/** The points for a call: the most for an exact one, less for each °F off, none from a bust. */
export function pointsFor(call: number, high: number, rules: Rules = RULES): number {
  return Math.max(0, rules.points - rules.per_degree * Math.abs(call - high));
}

export interface Row {
  who: string; // "You", or the model's name
  id: string; // "you", or the model's id
  call: number;
  miss: number; // call minus the high
  run: string | null;
}

export interface Verdict {
  high: number;
  call: number | null;
  miss: number | null;
  points: number | null;
  bust: boolean;
  beat: number; // models whose miss was bigger than yours
  tied: number;
  of: number;
  rows: Row[]; // you and every model, closest first (you first among equals)
  marks: ("beat" | "tie" | "lost")[]; // per model, in the file's order
}

export function verdictOf(result: BResult, call: number | null, rules: Rules = RULES): Verdict {
  if (result.high === null) throw new Error("a void day has no verdict");
  const high = result.high;
  const miss = call === null ? null : call - high;
  const models = result.models.map((m) => ({ who: m.name, id: m.id, call: m.call, miss: m.call - high, run: m.run }));
  const marks = models.map((m) => (miss === null ? "lost" : Math.abs(miss) < Math.abs(m.miss) ? "beat"
    : Math.abs(miss) === Math.abs(m.miss) ? "tie" : "lost") as Verdict["marks"][number]);
  const rows: Row[] = [...(call === null ? [] : [{ who: "You", id: "you", call, miss: miss!, run: null }]), ...models];
  rows.sort((a, b) => Math.abs(a.miss) - Math.abs(b.miss) || Number(b.id === "you") - Number(a.id === "you"));
  return {
    high, call, miss,
    points: call === null ? null : pointsFor(call, high, rules),
    bust: miss !== null && Math.abs(miss) >= rules.bust,
    beat: marks.filter((m) => m === "beat").length,
    tied: marks.filter((m) => m === "tie").length,
    of: models.length,
    rows, marks,
  };
}

/** The verdict's stamp: a bust, a perfect call, or how many models you beat. */
export function stampOf(v: Verdict): { text: string; tier: 0 | 1 | 2 | 3 } {
  if (v.miss === null) return { text: "No call", tier: 0 };
  if (v.bust) return { text: "Bust!", tier: 0 };
  if (v.miss === 0) return { text: "Spot on!", tier: 3 };
  // A day without the models' calls: just the miss
  if (v.of === 0) return { text: `Off by ${Math.abs(v.miss)}`, tier: Math.abs(v.miss) >= 3 ? 1 : 2 };
  if (v.beat === v.of) return { text: "Beat them all!", tier: 3 };
  const share = (v.beat + v.tied / 2) / Math.max(1, v.of);
  return { text: `Beat ${v.beat} of ${v.of}`, tier: share >= 0.5 ? 2 : 1 };
}

const SQUARES = { beat: "🟩", tie: "🟨", lost: "🟥" } as const;

export function shareText(result: BResult, v: Verdict, url: string): string {
  const c = result.city;
  const off = v.miss === 0 ? "spot on" : `off by ${Math.abs(v.miss!)}`;
  return [
    `Beat the Models #${result.number} · ${c.city}, ${c.state}`,
    `My call ${v.call}°F · it hit ${v.high}°F (${off})${v.bust ? " · BUST" : ""}`,
    ...(v.of ? [`Beat ${v.beat} of ${v.of} models ${v.marks.map((m) => SQUARES[m]).join("")}`] : []),
    url,
  ].join("\n");
}

/** "+2" or "−3" or "0": a miss, signed. */
export const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");

/** The days the page looks at, newest first: the newest puzzle's and the ones before it. */
export function pageDays(newest: string, count = 3): string[] {
  const [y, m, d] = newest.split("-").map(Number);
  return Array.from({ length: count }, (_, k) => new Date(Date.UTC(y, m - 1, d - k)).toISOString().slice(0, 10));
}

/** games.yml's next run (10:30Z), when the next city is posted. */
export function nextRun(now: Date): string {
  const t = new Date(now);
  t.setUTCHours(10, 30, 0, 0);
  if (t <= now) t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString();
}

/** "Sat, Oct 25" for a puzzle's day. */
export function dayName(iso: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

/** "2 a.m. Eastern" or "midnight Eastern": a time in Eastern time, the games' clock. */
export function easternTime(iso: string): string {
  const t = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })
    .formatToParts(t);
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const minute = parts.find((p) => p.type === "minute")!.value;
  const pm = parts.find((p) => p.type === "dayPeriod")!.value.toUpperCase() === "PM";
  if (minute === "00" && hour === 12) return `${pm ? "noon" : "midnight"} Eastern`;
  return `${hour}${minute === "00" ? "" : `:${minute}`} ${pm ? "p.m." : "a.m."} Eastern`;
}

/** "7 h 12 min", "38 min", or "under a minute" until a time. */
export function countdown(to: string, now: Date): string {
  const min = Math.floor((new Date(to).getTime() - now.getTime()) / 60_000);
  if (min < 1) return "under a minute";
  const h = Math.floor(min / 60);
  return h ? `${h} h ${min % 60} min` : `${min} min`;
}

/** The call's lock in words: "midnight in Denver (2 a.m. Eastern)". */
export function lockWords(p: Pick<BPuzzle, "lock" | "city">): string {
  const eastern = p.city.tz === "America/New_York" || p.city.tz === "America/Detroit" || p.city.tz.startsWith("America/Indiana");
  return `midnight in ${p.city.city}${eastern ? "" : ` (${easternTime(p.lock)})`}`;
}

/** A model's run as "Fri 18Z". */
export function runName(run: string): string {
  const d = new Date(Date.UTC(+run.slice(0, 4), +run.slice(4, 6) - 1, +run.slice(6, 8)));
  return `${d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })} ${run.slice(8, 10)}Z`;
}

/** The model maps at the city's region, on the day's afternoon. */
export function mapsQuery(p: Pick<BPuzzle, "city" | "map">): string {
  const q = new URLSearchParams({ m: "gfs", r: p.city.region, v: "t2m", var: "temp", t: p.map, mode: "fcst" });
  return q.toString();
}

/** A call typed in: a whole °F from −60 to 140, or null. */
export function parseCall(raw: string): number | null {
  const s = raw.trim().replace(/\s*°\s*F?$/i, "").replace("−", "-");
  if (!/^-?\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= -60 && n <= 140 ? n : null;
}
