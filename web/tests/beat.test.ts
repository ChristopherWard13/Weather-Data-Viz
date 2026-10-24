import { describe, expect, it } from "vitest";
import {
  checkPuzzle, countdown, dayName, easternTime, lockWords, mapsQuery, nextRun, pageDays, parseCall, pointsFor, runName,
  shareText, signed, stampOf, verdictOf, type BCall, type BCity, type BResult,
} from "../src/games/beat-score";

const city: BCity = {
  id: "KDEN", city: "Denver", state: "CO", station: "DENVER INTNL ARPT", lat: 39.85, lon: -104.66, elev: 1640,
  tz: "America/Denver", region: "southwest",
};
const call = (id: string, name: string, c: number): BCall => ({ id, name, run: "2026102700", high: c, call: c, ground: 1650, lead: 22 });
const result = (high: number | null, calls = [70, 72, 75, 66, 73]): BResult => ({
  v: 1, game: "beat", date: "2026-10-27", number: 4, city, lock: "2026-10-27T06:00:00Z", high, void: high === null,
  models: calls.map((c, k) => call(["gfs", "gefs", "ecmwf", "icon", "gdps"][k], ["GFS", "GEFS mean", "ECMWF", "ICON", "GEM"][k], c)),
});

describe("Beat the Models", () => {
  it("scores a call: the most for an exact one, 20 less a degree, none from a bust", () => {
    expect([0, 1, -2, 4, 5, 9].map((d) => pointsFor(70 + d, 70))).toEqual([100, 80, 60, 20, 0, 0]);
  });

  it("ranks you among the models, ties counted apart", () => {
    // High 73: GFS −3, GEFS −1, ECMWF +2, ICON −7, GEM 0; you called 71 (−2)
    const v = verdictOf(result(73), 71);
    expect([v.miss, v.points, v.bust, v.beat, v.tied, v.of]).toEqual([-2, 60, false, 2, 1, 5]);
    expect(v.marks).toEqual(["beat", "lost", "tie", "beat", "lost"]);
    expect(v.rows.map((r) => r.id)).toEqual(["gdps", "gefs", "you", "ecmwf", "gfs", "icon"]);
    expect(stampOf(v)).toEqual({ text: "Beat 2 of 5", tier: 2 });
  });

  it("stamps a bust, a perfect call and a clean sweep", () => {
    expect(stampOf(verdictOf(result(73), 78)).text).toBe("Bust!");
    expect(stampOf(verdictOf(result(73), 68)).text).toBe("Bust!");
    expect(stampOf(verdictOf(result(73), 73)).text).toBe("Spot on!");
    expect(stampOf(verdictOf(result(80, [70, 72, 75, 66, 73]), 77)).text).toBe("Beat them all!");
    expect(stampOf(verdictOf(result(73), 69))).toEqual({ text: "Beat 1 of 5", tier: 1 });
  });

  it("says only the miss on a day without the models' calls", () => {
    const r = result(73, []);
    const v = verdictOf(r, 71);
    expect([v.beat, v.of]).toEqual([0, 0]);
    expect(stampOf(v)).toEqual({ text: "Off by 2", tier: 2 });
    expect(stampOf(verdictOf(r, 79)).text).toBe("Bust!");
    expect(shareText(r, v, "u").split("\n")).toEqual(["Beat the Models #4 · Denver, CO", "My call 71°F · it hit 73°F (off by 2)", "u"]);
  });

  it("still shows the models when you didn't call, and refuses a void day", () => {
    const v = verdictOf(result(73), null);
    expect([v.call, v.points, v.beat]).toEqual([null, null, 0]);
    expect(v.rows).toHaveLength(5);
    expect(stampOf(v).text).toBe("No call");
    expect(() => verdictOf(result(null), 70)).toThrow();
  });

  it("shares the city, the call, the high and a square a model", () => {
    const r = result(73);
    expect(shareText(r, verdictOf(r, 71), "https://runtorunwx.com/play/beat/")).toBe([
      "Beat the Models #4 · Denver, CO",
      "My call 71°F · it hit 73°F (off by 2)",
      "Beat 2 of 5 models 🟩🟥🟨🟩🟥",
      "https://runtorunwx.com/play/beat/",
    ].join("\n"));
    expect(shareText(r, verdictOf(r, 79), "u").split("\n")[1]).toBe("My call 79°F · it hit 73°F (off by 6) · BUST");
    expect(shareText(r, verdictOf(r, 73), "u").split("\n")[1]).toBe("My call 73°F · it hit 73°F (spot on)");
  });

  it("reads a call typed in", () => {
    expect(["71", " 71 ", "71°", "71 °F", "-5", "−5", "105"].map(parseCall)).toEqual([71, 71, 71, 71, -5, -5, 105]);
    expect(["", "7.5", "abc", "1000", "-61", "141"].map(parseCall)).toEqual([null, null, null, null, null, null]);
  });

  it("names days, runs, times and the lock", () => {
    expect(pageDays("2026-11-01")).toEqual(["2026-11-01", "2026-10-31", "2026-10-30"]);
    expect(pageDays("2026-11-01", 5).slice(3)).toEqual(["2026-10-29", "2026-10-28"]);
    // The next 10:30Z run, in Eastern time: 6:30 a.m. in summer time, 5:30 a.m. from Nov 1
    expect(nextRun(new Date("2026-10-27T07:00:00Z"))).toBe("2026-10-27T10:30:00.000Z");
    expect(nextRun(new Date("2026-10-27T10:30:00Z"))).toBe("2026-10-28T10:30:00.000Z");
    expect(easternTime(nextRun(new Date("2026-11-03T02:00:00Z")))).toBe("5:30 a.m. Eastern");
    expect(dayName("2026-10-27")).toBe("Tue, Oct 27");
    expect(runName("2026102618")).toBe("Mon 18Z");
    expect(easternTime("2026-10-27T06:00:00Z")).toBe("2 a.m. Eastern");
    expect(easternTime("2026-10-27T04:00:00Z")).toBe("midnight Eastern");
    expect(easternTime("2026-10-27T10:30:00Z")).toBe("6:30 a.m. Eastern");
    expect(lockWords({ lock: "2026-10-27T06:00:00Z", city })).toBe("midnight in Denver (2 a.m. Eastern)");
    expect(lockWords({ lock: "2026-10-27T04:00:00Z", city: { ...city, city: "Atlanta", tz: "America/New_York" } }))
      .toBe("midnight in Atlanta");
    expect(countdown("2026-10-27T06:00:00Z", new Date("2026-10-26T22:47:30Z"))).toBe("7 h 12 min");
    expect(countdown("2026-10-27T06:00:00Z", new Date("2026-10-27T05:22:00Z"))).toBe("38 min");
    expect(countdown("2026-10-27T06:00:00Z", new Date("2026-10-27T05:59:40Z"))).toBe("under a minute");
    expect(signed(2)).toBe("+2");
    expect(signed(-3)).toBe("−3");
  });

  it("links the model maps at the city's region on the day's afternoon", () => {
    expect(mapsQuery({ city, map: "2026102800" })).toBe("m=gfs&r=southwest&v=t2m&var=temp&t=2026102800&mode=fcst");
  });

  it("checks a puzzle", () => {
    const p = {
      v: 1, game: "beat", date: "2026-10-27", number: 1, made: "", credit: { text: "", url: "" }, city, lock: "x",
      day: ["", ""], map: "", models: [{ id: "gfs", name: "GFS" }], context: [], rules: { points: 100, per_degree: 20, bust: 5 },
    } as Parameters<typeof checkPuzzle>[0];
    expect(() => checkPuzzle(p)).not.toThrow();
    expect(() => checkPuzzle({ ...p, v: 2 })).toThrow();
    expect(() => checkPuzzle({ ...p, models: [] })).toThrow();
  });
});
