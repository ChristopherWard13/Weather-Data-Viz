import { describe, expect, it } from "vitest";
import {
  bias, checkPuzzle, formatValue, rating, roundValues, runLabel, shareText, shiftNote, timeReadout, verdict,
  type MPuzzle, type MRound,
} from "../src/games/measured-score";

const F = { speed: "mph", temp: "F" } as const;
const C = { speed: "kt", temp: "C" } as const;
const grid = { lat0: 40, lon0: -100, dlat: -1, dlon: 1, ny: 1, nx: 3 };
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

function round(over: Partial<MRound> = {}): MRound {
  return {
    kind: "afternoon", title: "Afternoon temperature", field: "t2m", unit: "°F", decimals: 0,
    valid: "2026-10-21T21:00Z", scale: 1, offset: -60, nodata: 255,
    maps: [b64([120, 121, 255]), b64([125, 126, 255])], answer: 1,
    measured: "Measured: NOAA's URMA", model: { id: "gfs", name: "GFS", run: "2026101712", lead: 105 },
    miss: { score: 0.5, rms: 4, bias: 3.7 }, ...over,
  };
}

const puzzle = (rounds: MRound[]): MPuzzle => ({
  v: 1, game: "measured", date: "2026-10-21", number: 1, made: "2026-10-22T10:30:00Z", credit: [],
  area: { id: "us", label: "Mainland US", lat: [23, 51], lon: [-126, -66] }, grid, rounds,
});

describe("Modeled or Measured", () => {
  it("decodes a round's maps, blank where nodata", () => {
    const v = roundValues(round(), 0);
    expect(Array.from(v.slice(0, 2))).toEqual([60, 61]);
    expect(Number.isNaN(v[2])).toBe(true);
  });

  it("rejects malformed puzzles", () => {
    expect(() => checkPuzzle(puzzle([round()]))).not.toThrow();
    expect(() => checkPuzzle(puzzle([]))).toThrow(/incomplete/);
    expect(() => checkPuzzle(puzzle([round({ maps: [b64([1, 2]), b64([1, 2, 3])] })]))).toThrow(/malformed/);
    expect(() => checkPuzzle({ ...puzzle([round()]), v: 2 } as unknown as MPuzzle)).toThrow(/unsupported/);
  });

  it("formats values in the viewer's units", () => {
    expect(formatValue("t2m", 68, F)).toBe("68 °F");
    expect(formatValue("t2m", 68, C)).toBe("20 °C");
    expect(formatValue("gust", 40, F)).toBe("46 mph");
    expect(formatValue("gust", 40, C)).toBe("40 kt");
    expect(formatValue("rain", 0.425, F)).toBe("0.42 in");
  });

  it("shows when the round is, big in Eastern with Pacific beside it", () => {
    expect(timeReadout(round())).toEqual({ value: "5 PM ET", caption: "2 PM PT" });
    expect(timeReadout(round({ field: "rain", valid: "2026-10-22T06:00Z", from: "2026-10-21T06:00Z" })))
      .toEqual({ value: "24 hours", caption: "2 AM Wed – 2 AM Thu ET" });
    expect(timeReadout(round({ valid: "2026-12-21T12:00Z" }))).toEqual({ value: "7 AM ET", caption: "4 AM PT" });
  });

  it("labels the forecast's run, and how it was off", () => {
    expect(runLabel(round())).toBe("Sat 12Z");
    expect(runLabel(round({ model: { id: "gfs", name: "GFS", run: "2026101800", lead: 96 } }))).toBe("Sun 00Z");
    expect(bias(round(), F)).toEqual({ value: "+3.7 °F", word: "too warm" });
    expect(bias(round({ miss: { score: 1, rms: 4, bias: -3.6 } }), C)).toEqual({ value: "−2.0 °C", word: "too cold" });
    expect(bias(round({ field: "rain", miss: { score: 1, rms: 0.2, bias: -0.005 } }), F)).toEqual({ value: "≈ 0", word: "about right" });
    expect(bias(round({ field: "gust", miss: { score: 1, rms: 5, bias: 4 } }), F)).toEqual({ value: "+4.6 mph", word: "too gusty" });
    // A moved map says how far, and which way, in the fine print
    expect(shiftNote(round({ shift: 3.7 }), F)).toBe(
      "The forecast map was moved 3.7 °F cooler to match the measured average, so the average alone wouldn't give it away.");
    expect(shiftNote(round({ field: "d2m", shift: -3.6 }), F)).toMatch(/^The forecast map was moved 3.6 °F more humid /);
    expect(shiftNote(round({ field: "rain", shift: 0 }), F)).toBeNull();
  });

  it("shares a spoiler-free result", () => {
    const p = puzzle([round(), round(), round()]);
    expect(shareText(p, [true, false, true], "https://runtorunwx.com/play/measured/"))
      .toBe("Modeled or Measured #1: 2/3\n🟩🟥🟩\nhttps://runtorunwx.com/play/measured/");
    expect([5, 4, 3, 1].map((n) => rating(n, 5))).toEqual(["Perfect!", "Sharp eyes!", "Not bad", "Fooled you!"]);
    expect([true, false].map(verdict)).toEqual(["Correct!", "Wrong!"]);
  });
});
