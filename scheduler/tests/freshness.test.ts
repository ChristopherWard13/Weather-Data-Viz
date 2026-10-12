import { describe, expect, it } from "vitest";
import {
  ALERT_AFTER_MIN, BACKOFF_MIN, DISPATCH_MARGIN_MIN, nextDue, nextRun, reconcileIssues, shouldDispatch, statusOf,
  type ProductInfo,
} from "../src/freshness";

const ecmwf: ProductInfo = { id: "ecmwf", name: "ECMWF", workflow: "ecmwf.yml", cycleHours: 12, latencyMinutes: 456 };
const gfs: ProductInfo = { id: "gfs", name: "GFS", workflow: "gfs.yml", cycleHours: 6, latencyMinutes: 331 };
const at = (iso: string) => new Date(`${iso}Z`);
const plus = (t: Date, min: number) => new Date(t.getTime() + min * 60_000);

describe("nextDue", () => {
  it("is the next cycle's init plus the posting latency", () => {
    // ECMWF 00Z shown: the 12Z run is posted by 19:36Z
    expect(nextRun("2026101200", ecmwf)).toBe("2026101212");
    expect(nextDue("2026101200", ecmwf)).toEqual(at("2026-10-12T19:36"));
    // GFS 18Z shown: the 00Z run (next day) is posted by 05:31Z
    expect(nextRun("2026101218", gfs)).toBe("2026101300");
    expect(nextDue("2026101218", gfs)).toEqual(at("2026-10-13T05:31"));
  });
});

describe("statusOf", () => {
  const due = at("2026-10-12T19:36");
  it("is fresh until the margin after the next cycle is due", () => {
    expect(statusOf(ecmwf, "2026101200", plus(due, DISPATCH_MARGIN_MIN - 1)).behind).toBe(false);
    const s = statusOf(ecmwf, "2026101200", plus(due, DISPATCH_MARGIN_MIN));
    expect(s).toMatchObject({ next: "2026101212", due, behind: true, overdue: false });
  });
  it("is overdue once the next cycle is hours late", () => {
    expect(statusOf(ecmwf, "2026101200", plus(due, ALERT_AFTER_MIN - 1)).overdue).toBe(false);
    expect(statusOf(ecmwf, "2026101200", plus(due, ALERT_AFTER_MIN)).overdue).toBe(true);
  });
  it("treats a product with no runs as behind but not overdue", () => {
    expect(statusOf(gfs, null, due)).toMatchObject({ latest: null, behind: true, overdue: false });
  });
});

describe("shouldDispatch", () => {
  const now = at("2026-10-12T20:00");
  const behind = statusOf(ecmwf, "2026101200", now);
  it("dispatches a behind product with no recent run", () => {
    expect(shouldDispatch(behind, null, now)).toBe(true);
    expect(shouldDispatch(behind, { status: "completed", createdAt: plus(now, -BACKOFF_MIN) }, now)).toBe(true);
  });
  it("waits while a run is active or one started within the back-off", () => {
    for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) {
      expect(shouldDispatch(behind, { status, createdAt: plus(now, -120) }, now)).toBe(false);
    }
    expect(shouldDispatch(behind, { status: "completed", createdAt: plus(now, -BACKOFF_MIN + 1) }, now)).toBe(false);
  });
  it("never dispatches a fresh product", () => {
    expect(shouldDispatch(statusOf(ecmwf, "2026101212", now), null, now)).toBe(false);
  });
});

describe("reconcileIssues", () => {
  const now = at("2026-10-13T02:00");
  const late = statusOf(ecmwf, "2026101200", now); // 12Z due 19:36Z: overdue
  const fresh = statusOf(gfs, "2026101218", now); // 00Z due 05:31Z: fresh
  it("opens one issue per overdue product", () => {
    expect(reconcileIssues([late, fresh], []).open.map((s) => s.product.id)).toEqual(["ecmwf"]);
    expect(reconcileIssues([late, fresh], [{ number: 7, product: "ecmwf" }]).open).toEqual([]);
  });
  it("closes the issue of a product that caught up", () => {
    expect(reconcileIssues([late, fresh], [{ number: 8, product: "gfs" }]).close).toEqual([{ number: 8, product: "gfs" }]);
    expect(reconcileIssues([late, fresh], [{ number: 7, product: "ecmwf" }]).close).toEqual([]);
  });
  it("leaves the issue of a product whose manifest couldn't be read", () => {
    expect(reconcileIssues([late], [{ number: 8, product: "gfs" }]).close).toEqual([]);
  });
});
