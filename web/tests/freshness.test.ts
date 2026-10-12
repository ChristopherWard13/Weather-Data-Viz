import { describe, expect, it } from "vitest";
import { chipRun, LATE_GRACE_MIN, nextDue } from "../src/freshness";

const ecmwf = { name: "ECMWF", cycleHours: 12, latencyMinutes: 456 };
const at = (iso: string) => new Date(`${iso}Z`);
const plus = (t: Date, min: number) => new Date(t.getTime() + min * 60_000);

describe("nextDue", () => {
  it("is the next cycle's init plus the posting latency", () => {
    expect(nextDue("2026101200", ecmwf)).toEqual(at("2026-10-12T19:36"));
    expect(nextDue("2026101212", ecmwf)).toEqual(at("2026-10-13T07:36"));
  });
});

describe("chipRun", () => {
  it("shows the hour for today's run and the day for an older one", () => {
    expect(chipRun("2026101200", ecmwf, at("2026-10-12T16:00")).label).toBe("00Z");
    // The review's case: Sunday's 12Z still showing on Monday afternoon
    expect(chipRun("2026101112", ecmwf, at("2026-10-12T16:40")).label).toBe("Sun 12Z");
  });
  it("is late once the next run is the grace period past due", () => {
    const due = at("2026-10-12T19:36");
    expect(chipRun("2026101200", ecmwf, plus(due, LATE_GRACE_MIN - 1)).late).toBe(false);
    const r = chipRun("2026101200", ecmwf, plus(due, LATE_GRACE_MIN));
    expect(r.late).toBe(true);
    expect(r.title).toBe("ECMWF: latest run 2026-10-12 00Z. Late: the 2026-10-12 12Z run was due by 2026-10-12 19:36 UTC and hasn't arrived yet.");
  });
  it("calls the review's 28-hour-old ECMWF late", () => {
    const r = chipRun("2026101112", ecmwf, at("2026-10-12T16:40"));
    expect(r.late).toBe(true);
    expect(r.title).toContain("the 2026-10-12 00Z run was due by 2026-10-12 07:36 UTC");
  });
});
