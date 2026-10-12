/** What the scheduler knows about a product (generated from config/ by scripts/products.mjs). */
export interface ProductInfo {
  id: string;
  name: string;
  /** The workflow file that updates it, e.g. "gfs.yml". */
  workflow: string;
  cycleHours: number;
  /** Measured minutes after init by which a whole run is posted at the source. */
  latencyMinutes: number;
}

/** Start the workflow this long after a cycle is due, so the last files have landed. */
export const DISPATCH_MARGIN_MIN = 5;
/** Don't start a product's workflow again within this long of its last run. */
export const BACKOFF_MIN = 30;
/** Open an issue once a product's next cycle is this late. */
export const ALERT_AFTER_MIN = 180;

const MINUTE = 60_000;

/** "2026101212" -> Date (UTC). */
export function parseRunId(id: string): Date {
  if (!/^\d{10}$/.test(id)) throw new Error(`bad run id ${id}`);
  return new Date(Date.UTC(+id.slice(0, 4), +id.slice(4, 6) - 1, +id.slice(6, 8), +id.slice(8, 10)));
}

/** Date -> "2026101212". */
export function runId(t: Date): string {
  return t.toISOString().replace(/\D/g, "").slice(0, 10);
}

/** The cycle after `latest`. */
export function nextRun(latest: string, p: ProductInfo): string {
  return runId(new Date(parseRunId(latest).getTime() + p.cycleHours * 60 * MINUTE));
}

/**
 * When the cycle after `latest` should be posted at the source: its init plus
 * the product's latency. The site's late-run chips use the same rule
 * (web/src/freshness.ts).
 */
export function nextDue(latest: string, p: ProductInfo): Date {
  return new Date(parseRunId(nextRun(latest, p)).getTime() + p.latencyMinutes * MINUTE);
}

export interface Status {
  product: ProductInfo;
  /** The manifest's latest run, or null if the product has none yet. */
  latest: string | null;
  /** The cycle after `latest`, and when it was due at the source; null with no latest run. */
  next: string | null;
  due: Date | null;
  /** The next cycle is due and the manifest doesn't have it: start the workflow. */
  behind: boolean;
  /** Behind for long enough to open an issue. */
  overdue: boolean;
}

/** Where a product stands at `now`. A product with no runs yet is behind but not overdue. */
export function statusOf(p: ProductInfo, latest: string | null, now: Date): Status {
  if (!latest) return { product: p, latest, next: null, due: null, behind: true, overdue: false };
  const due = nextDue(latest, p);
  const late = now.getTime() - due.getTime();
  return {
    product: p, latest, next: nextRun(latest, p), due,
    behind: late >= DISPATCH_MARGIN_MIN * MINUTE,
    overdue: late >= ALERT_AFTER_MIN * MINUTE,
  };
}

/** The workflow's most recent run, whatever started it. */
export interface LastRun {
  status: string;
  createdAt: Date;
}

const ACTIVE = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

/** Start a behind product's workflow unless a run is active or one started within the back-off. */
export function shouldDispatch(s: Status, last: LastRun | null, now: Date): boolean {
  if (!s.behind) return false;
  if (!last) return true;
  if (ACTIVE.has(last.status)) return false;
  return now.getTime() - last.createdAt.getTime() >= BACKOFF_MIN * MINUTE;
}

/** An open stale-data issue the scheduler opened, by the product named in its marker. */
export interface StaleIssue {
  number: number;
  product: string;
}

/**
 * Issues to open (overdue products without one) and to close (products that
 * caught up). `statuses` holds only the products whose manifest was read, so an
 * unreadable manifest leaves its issue alone.
 */
export function reconcileIssues(statuses: Status[], open: StaleIssue[]): { open: Status[]; close: StaleIssue[] } {
  const byId = new Map(statuses.map((s) => [s.product.id, s]));
  return {
    open: statuses.filter((s) => s.overdue && !open.some((i) => i.product === s.product.id)),
    close: open.filter((i) => byId.has(i.product) && !byId.get(i.product)!.behind),
  };
}
