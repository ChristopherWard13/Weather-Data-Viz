import { describe, expect, it } from "vitest";
import {
  dayLabel, daysFrom, detectZone, fmtDay, fmtLocal, fmtValid, startOfDay, zoneById, zoneOffset,
} from "../src/time";
import { axisOf, clip, coverage, dayTicks, daysWindow, snap } from "../src/timeaxis";
import { parsePrefs } from "../src/prefs";
import { speedQ, tempQ, ticksIn } from "../src/units";
import { chipRun } from "../src/freshness";
import { divergingTicks } from "../src/colorbar";
import { trendLimits } from "../src/views/util";

const at = (iso: string) => new Date(`${iso}Z`);
const ET = zoneById("ET")!, PT = zoneById("PT")!, HT = zoneById("HT")!, UTC = zoneById("UTC")!;

describe("time zones", () => {
  it("shows a valid time in the zone, then in Z", () => {
    // Thu 15 Oct 00Z is Wednesday evening in the US
    expect(fmtValid(at("2026-10-15T00:00"), ET)).toBe("Wed 14 Oct 8 PM ET · Thu 00Z");
    expect(fmtLocal(at("2026-10-15T00:00"), PT)).toBe("Wed 14 Oct 5 PM PT");
    expect(fmtLocal(at("2026-10-15T12:00"), HT)).toBe("Thu 15 Oct 2 AM HT");
    expect(fmtLocal(at("2026-10-15T16:00"), ET)).toBe("Thu 15 Oct 12 PM ET");
    expect(fmtValid(at("2026-10-15T00:00"), UTC)).toBe("Thu 15 Oct 00Z");
  });

  it("follows daylight saving", () => {
    expect(zoneOffset(at("2026-07-01T12:00"), ET.iana)).toBe(-240);
    expect(zoneOffset(at("2026-12-01T12:00"), ET.iana)).toBe(-300);
    expect(fmtLocal(at("2026-12-01T00:00"), ET)).toBe("Mon 30 Nov 7 PM ET");
  });

  it("takes the browser's zone only when it keeps one of the listed zones' clocks", () => {
    const now = at("2026-10-12T12:00");
    expect(detectZone("America/New_York", now).id).toBe("ET");
    expect(detectZone("America/Detroit", now).id).toBe("ET");
    expect(detectZone("America/Boise", now).id).toBe("MT");
    expect(detectZone("Pacific/Honolulu", now).id).toBe("HT");
    // Arizona keeps MST all year: no listed zone matches, so UTC rather than a wrong half the year
    expect(detectZone("America/Phoenix", now).id).toBe("UTC");
    expect(detectZone("Europe/London", now).id).toBe("UTC");
    expect(detectZone("Not/AZone", now).id).toBe("UTC");
    expect(detectZone(undefined, now).id).toBe("UTC");
  });

  it("counts days in the zone's calendar: today is Day 1", () => {
    const now = at("2026-10-13T02:00"); // Mon 12 Oct 10 PM ET
    expect(daysFrom(now, at("2026-10-13T03:59"), ET)).toBe(0);
    expect(dayLabel(now, at("2026-10-13T04:00"), ET)).toBe("Day 2"); // midnight Tuesday ET
    expect(dayLabel(now, at("2026-10-13T04:00"), UTC)).toBe("Day 1");
    expect(dayLabel(now, at("2026-10-12T05:00"), ET)).toBe("Day 1"); // 1 AM Monday
    expect(dayLabel(now, at("2026-10-12T00:00"), ET)).toBe(""); // Sunday evening: before today
  });

  it("finds midnight, also on a DST change day", () => {
    expect(startOfDay(at("2026-10-15T00:00"), ET)).toEqual(at("2026-10-14T04:00"));
    // 1 Nov 2026: clocks fall back at 2 AM, so midnight was still EDT
    expect(startOfDay(at("2026-11-01T20:00"), ET)).toEqual(at("2026-11-01T04:00"));
    expect(startOfDay(at("2026-11-02T20:00"), ET)).toEqual(at("2026-11-02T05:00"));
    expect(fmtDay(at("2026-10-14T04:00"), ET)).toBe("Wed 14");
  });

  it("finds midnight when clocks spring forward", () => {
    // 8 Mar 2026: 2 AM EST becomes 3 AM EDT; midnight was still EST
    expect(startOfDay(at("2026-03-08T20:00"), ET)).toEqual(at("2026-03-08T05:00"));
    expect(startOfDay(at("2026-03-09T20:00"), ET)).toEqual(at("2026-03-09T04:00"));
  });
});

describe("one time axis", () => {
  const gfs = coverage(at("2026-10-12T06:00"), { min: 0, max: 384 });
  const ecmwf = coverage(at("2026-10-12T00:00"), { min: 0, max: 360 });
  const axis = axisOf([gfs, ecmwf], 6);

  it("spans from the earliest init to the longest range", () => {
    expect(axis.start).toEqual(at("2026-10-12T00:00"));
    expect(axis.end).toEqual(at("2026-10-28T06:00"));
  });

  it("snaps and clips to its positions", () => {
    expect(snap(axis, at("2026-10-13T04:00"), 1)).toEqual(at("2026-10-13T06:00"));
    expect(snap(axis, at("2026-10-13T04:00"), -1)).toEqual(at("2026-10-13T00:00"));
    expect(snap(axis, at("2026-10-13T06:00"), -1)).toEqual(at("2026-10-13T06:00"));
    expect(clip(axis, { start: at("2026-10-01T00:00"), end: at("2026-10-12T03:00") })).toEqual({ start: axis.start, end: axis.start });
    expect(clip(axis, { start: at("2026-10-29T00:00"), end: at("2026-10-30T00:00") })).toBeNull();
  });

  it("puts Days 1–7 between midnights in the zone, on the axis", () => {
    const now = at("2026-10-12T14:00"); // Mon 10 AM ET
    // Midnight Monday ET is 04Z, snapped up to 06Z; seven midnights on is Mon 19 Oct 04Z, snapped down to 00Z
    expect(daysWindow(axis, now, ET, 7)).toEqual({ start: at("2026-10-12T06:00"), end: at("2026-10-19T00:00") });
    expect(daysWindow(axis, now, UTC, 7)).toEqual({ start: at("2026-10-12T00:00"), end: at("2026-10-19T00:00") });
  });

  it("keeps Days 1–7 and day ticks on midnights across a DST change", () => {
    const fall = axisOf([coverage(at("2026-10-30T00:00"), { min: 0, max: 384 })], 6);
    // Fri 30 Oct ET: midnight is 04Z; seven midnights on (Fri 6 Nov) is 05Z, after the fall back
    expect(daysWindow(fall, at("2026-10-30T14:00"), ET, 7)).toEqual({ start: at("2026-10-30T06:00"), end: at("2026-11-06T00:00") });
    const ticks = dayTicks({ start: at("2026-10-31T00:00"), end: at("2026-11-03T00:00") }, ET);
    expect(ticks).toEqual([at("2026-10-31T04:00"), at("2026-11-01T04:00"), at("2026-11-02T05:00")]);
    const spring = dayTicks({ start: at("2026-03-07T00:00"), end: at("2026-03-10T00:00") }, ET);
    expect(spring).toEqual([at("2026-03-07T05:00"), at("2026-03-08T05:00"), at("2026-03-09T04:00")]);
  });

  it("ticks each midnight in the zone", () => {
    const ticks = dayTicks({ start: at("2026-10-12T00:00"), end: at("2026-10-15T00:00") }, ET);
    expect(ticks).toEqual([at("2026-10-12T04:00"), at("2026-10-13T04:00"), at("2026-10-14T04:00")]);
    expect(dayTicks({ start: at("2026-10-12T00:00"), end: at("2026-10-13T00:00") }, UTC)).toHaveLength(2);
  });
});

describe("units", () => {
  it("converts to the shown unit and back", () => {
    const mph = speedQ({ speed: "mph", temp: "F" });
    expect(mph.from(40)).toBeCloseTo(46.03, 2);
    expect(mph.to(mph.from(40))).toBeCloseTo(40, 9);
    const c = tempQ({ speed: "kt", temp: "C" }, "F");
    expect(c.from(32)).toBe(0);
    expect(c.scale).toBeCloseTo(5 / 9, 9);
    expect(tempQ({ speed: "kt", temp: "F" }, "C").from(-40)).toBe(-40);
  });

  it("puts colorbar ticks on round shown values", () => {
    const { ticks, format } = ticksIn(speedQ({ speed: "mph", temp: "F" }), 0, 80, 10);
    expect(ticks.map(format)).toEqual(["0", "10", "20", "30", "40", "50", "60", "70", "80", "90"]);
    expect(ticks[1]).toBeCloseTo(8.69, 2); // 10 mph, in stored knots
  });
});

describe("trend colorbars in the shown unit", () => {
  const labels = (viewId: string, q: Parameters<typeof trendLimits>[1], limit?: number) => {
    const l = trendLimits(viewId, q);
    return divergingTicks(limit ?? l.fixed, q!.scale).labels.join(" ");
  };
  it("labels round values, never rounded 2.5 steps", () => {
    // 850 mb in °F: ±8 °C becomes ±15 °F, ticked every 5
    expect(labels("t850", tempQ({ speed: "kt", temp: "F" }, "C"))).toBe("−15 −10 −5 0 +5 +10 +15");
    // 2 m in °C: the fixed ±20 °F becomes ±10 °C
    expect(labels("t2m", tempQ({ speed: "kt", temp: "C" }, "F"))).toBe("−10 −8 −6 −4 −2 0 +2 +4 +6 +8 +10");
    // Auto in °C can land on ±7.5: labels keep their decimal
    expect(labels("t2m", tempQ({ speed: "kt", temp: "C" }, "F"), 13.5)).toBe("−7.5 −5.0 −2.5 0.0 +2.5 +5.0 +7.5");
    // The °F auto limit of 15 (as before M2) ticks every 5 too
    expect(divergingTicks(15).labels.join(" ")).toBe("−15 −10 −5 0 +5 +10 +15");
    expect(labels("wind10", speedQ({ speed: "mph", temp: "F" }))).toBe("−25 −20 −15 −10 −5 0 +5 +10 +15 +20 +25");
  });
});

describe("display prefs", () => {
  it("survives a stored value that isn't an object", () => {
    for (const raw of ["null", "3", '"ET"', "[]", '{"units":null}']) {
      expect(parsePrefs(raw, "America/Chicago")).toEqual({ zone: "CT", units: { speed: "kt", temp: "F" }, fps: 2, zoom: false });
    }
  });

  it("keeps valid choices and defaults the rest", () => {
    expect(parsePrefs(JSON.stringify({ zone: "PT", units: { speed: "mph", temp: "C" }, fps: 6, zoom: true }), "UTC"))
      .toEqual({ zone: "PT", units: { speed: "mph", temp: "C" }, fps: 6, zoom: true });
    expect(parsePrefs("{nonsense", "America/Chicago")).toEqual({ zone: "CT", units: { speed: "kt", temp: "F" }, fps: 2, zoom: false });
    expect(parsePrefs(JSON.stringify({ zone: "XX", units: { speed: "furlongs" }, fps: 100 }), "Asia/Tokyo"))
      .toEqual({ zone: "UTC", units: { speed: "kt", temp: "F" }, fps: 2, zoom: false });
  });
});

describe("chips in the viewer's zone", () => {
  const gfs = { name: "GFS", cycleHours: 6, latencyMinutes: 331 };
  it("call a run today's by the zone's calendar, keeping its UTC name", () => {
    // Sun 11 Oct 18Z run, seen at 9 PM Sunday in New York (01Z Monday)
    const now = at("2026-10-12T01:00");
    expect(chipRun("2026101118", gfs, now, ET).label).toBe("18Z");
    expect(chipRun("2026101118", gfs, now).label).toBe("Sun 18Z");
  });
});
