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
