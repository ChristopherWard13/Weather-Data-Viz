import { describe, expect, it } from "vitest";
import {
  biasLine, checkPuzzle, forecastLine, formatValue, rating, roundValues, shareText, whenLine,
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

  it("says when the round is, Eastern and Pacific", () => {
    expect(whenLine(round())).toBe("5 p.m. Eastern, 2 p.m. Pacific");
    expect(whenLine(round({ field: "rain", valid: "2026-10-22T06:00Z", from: "2026-10-21T06:00Z" })))
      .toBe("the 24 hours from 2 a.m. Wednesday to 2 a.m. Thursday, Eastern");
    expect(whenLine(round({ valid: "2026-12-21T12:00Z" }))).toBe("7 a.m. Eastern, 4 a.m. Pacific");
  });

  it("describes the forecast and how it was off", () => {
    expect(forecastLine(round())).toBe("GFS's forecast from its Saturday 12Z run, about 4½ days ahead");
    expect(forecastLine(round({ model: { id: "gfs", name: "GFS", run: "2026101800", lead: 96 } })))
      .toBe("GFS's forecast from its Sunday 00Z run, about 4 days ahead");
    expect(biasLine(round(), F)).toBe("On average it ran 3.7 °F too warm.");
    expect(biasLine(round({ miss: { score: 1, rms: 4, bias: -3.6 } }), C)).toBe("On average it ran 2.0 °C too cold.");
    expect(biasLine(round({ field: "rain", miss: { score: 1, rms: 0.2, bias: -0.005 } }), F)).toMatch(/close/);
    expect(biasLine(round({ field: "gust", miss: { score: 1, rms: 5, bias: 4 } }), F)).toBe("On average it ran 4.6 mph too gusty.");
  });

  it("shares a spoiler-free result", () => {
    const p = puzzle([round(), round(), round()]);
    expect(shareText(p, [true, false, true], "https://runtorunwx.com/play/measured/"))
      .toBe("Modeled or Measured #1: 2/3\n🟩🟥🟩\nhttps://runtorunwx.com/play/measured/");
    expect(rating(5, 5)).toMatch(/Perfect/);
    expect(rating(1, 5)).toMatch(/fooled/);
  });
});
