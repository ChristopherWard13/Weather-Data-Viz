import { describe, expect, it } from "vitest";
import { DEFAULT_UNITS } from "../src/units";
import {
  bandLabel, bandOf, bandWord, checkPuzzle, clockOf, compare, compassOf, getter, ROWS, shareText, skyOf, type SPuzzle,
} from "../src/games/station-score";

const F = { ...DEFAULT_UNITS, speed: "mph" as const };
const C = { temp: "C" as const, speed: "kt" as const };

function puzzle(): SPuzzle {
  return {
    v: 1, game: "station", date: "2026-10-22", number: 1, made: "2026-10-23T10:30:00Z",
    credit: { text: "", url: "" }, area: { id: "us", label: "", lat: [23, 51], lon: [-126, -66] },
    guesses: 6, bands: [200, 500, 1000], spot: [],
    cities: [
      ["KAVL", "Asheville", "NC", "ASHEVILLE MUNICIPAL", 35.432, -82.537],
      ["KATL", "Atlanta", "GA", "ATLANTA INTL ARPT", 33.63, -84.44],
      ["KMEM", "Memphis", "TN", "MEMPHIS INTL ARPT", 35.06, -89.99],
      ["KSEA", "Seattle", "WA", "SEATTLE-TACOMA INTL", 47.44, -122.31],
    ],
    answer: 0,
    cards: [{ id: "gust", items: ["gust", "gust_dir"] }, { id: "high", items: ["high", "high_depart"] }],
    values: { gust: [35, 20, null, 40], gust_dir: [225, null, null, 0], high: [74, 80, 70, 60], high_depart: [11, 0, -3, null] },
  };
}

describe("Station ID", () => {
  it("bands each guess by its distance from the answer", () => {
    const p = puzzle();
    // Atlanta is about 165 mi from Asheville, Memphis about 410, Seattle about 2,100
    expect([0, 1, 2, 3].map((k) => bandOf(p, k))).toEqual([-1, 0, 1, 3]);
    expect([0, 1, 2, 3].map((b) => bandLabel(p, b, F))).toEqual(["Under 200 mi", "200–500 mi", "500–1,000 mi", "Over 1,000 mi"]);
    expect(bandLabel(p, 1, C)).toBe("320–800 km");
    expect([-1, 0, 1, 2, 3].map(bandWord)).toEqual(["Found", "Near", "Mid", "Far", "Way off"]);
  });

  it("words the clues in the viewer's units", () => {
    const p = puzzle();
    const [gust] = ROWS.gust, [high] = ROWS.high;
    expect(gust.text(getter(p, 0), F)).toBe("35 mph from the SW");
    expect(gust.text(getter(p, 1), C)).toBe("17 kt");
    expect(gust.text(getter(p, 2), F)).toBeNull();
    expect(high.text(getter(p, 0), F)).toBe("74 °F, 11° above");
    expect(high.text(getter(p, 1), F)).toBe("80 °F, normal");
    expect(high.text(getter(p, 2), C)).toBe("21 °C, 2° below");
    expect(high.text(getter(p, 3), F)).toBe("60 °F");
    expect(clockOf(0)).toBe("12:00 am");
    expect(clockOf(12 * 60 + 5)).toBe("12:05 pm");
    expect(clockOf(23 * 60 + 58)).toBe("11:58 pm");
    expect(compassOf(350)).toBe("N");
    expect(skyOf(0.9)).toBe("Cloudy (0.9)");
    expect(ROWS.rain[0].text(() => 0.001, F)).toBe("Trace");
    expect(ROWS.records[2].text(() => 661, F)).toBe("2,169 ft");
    // The records can fill a gap earlier, leaving the elevation last on its own
    expect(ROWS.record.map((r) => r.label)).toEqual(["Record high", "Record low"]);
    expect(ROWS.elevation.map((r) => r.label)).toEqual(["Elevation"]);
    expect(ROWS.change).toBeUndefined();
  });

  it("says which way the mystery station's number lies from a guess's", () => {
    const p = puzzle();
    const [high] = ROWS.high, answer = getter(p, 0);
    expect(compare(high, getter(p, 1), answer)).toBe("down");
    expect(compare(high, getter(p, 2), answer)).toBe("up");
    expect(compare(high, answer, answer)).toBe("same");
    expect(compare(ROWS.gust[0], getter(p, 2), answer)).toBeNull();
  });

  it("shares a square a guess and the count", () => {
    const p = puzzle();
    expect(shareText(p, [3, 2, 1, 0], "https://x/")).toBe("Station ID #1: 4/6\n⬛🟧🟨🟩\nhttps://x/");
    expect(shareText(p, [3, 3, 3, 3, 3, 3], "u").split("\n")[0]).toBe("Station ID #1: X/6");
  });

  it("rejects a puzzle it can't read", () => {
    const p = puzzle();
    expect(() => checkPuzzle(p)).not.toThrow();
    expect(() => checkPuzzle({ ...p, answer: 9 })).toThrow("incomplete");
    expect(() => checkPuzzle({ ...p, values: { ...p.values, gust: [1] } })).toThrow("gust");
  });
});
