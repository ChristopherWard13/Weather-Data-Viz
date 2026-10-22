import { describe, expect, it } from "vitest";
import {
  checkPuzzle, dayLine, decodeMap, extremeness, formatKm, formatValue, gameUnits, haversineKm, prompt, scoreRound,
  shareText, square, type Puzzle, type Round, type Scoring, type StationRow,
} from "../src/games/score";

const stations: StationRow[] = [
  ["PHP", "Philip", "SD", 44.05, -101.6],
  ["PIR", "Pierre", "SD", 44.38, -100.29],
  ["RAP", "Rapid City", "SD", 44.05, -103.05],
  ["BIS", "Bismarck", "ND", 46.77, -100.75],
  ["LNK", "Lincoln", "NE", 40.85, -96.76],
];

const scoring: Scoring = { value: 600, distance: 400, full_km: 25, scale_km: 250, reach_km: 150 };

const round: Round = {
  kind: "hottest", title: "Hottest high", unit: "°F", decimals: 0,
  best: 81, floor: 79, top: [0], i: [0, 1, 2, 3, 4], v: [81, 80, 79, 70, 75],
};

const puzzle: Puzzle = {
  v: 2, game: "spot", date: "2026-10-20", number: 20, made: "2026-10-21T10:30:00Z",
  credit: { text: "x", url: "y" }, area: { id: "us", label: "Mainland US", lat: [23, 51], lon: [-126, -66] },
  scoring, stations, rounds: [round],
};

const at = (s: number): [number, number] => [stations[s][4], stations[s][3]];
const distancePoints = (km: number) => Math.round(400 * Math.exp(-(km - 25) / 250));

describe("Wx Marks the Spot scoring", () => {
  it("measures great-circle distance", () => {
    expect(haversineKm(0, 0, 0, 1)).toBeCloseTo(111.19, 1);
    expect(haversineKm(44.05, -101.6, 44.05, -101.6)).toBe(0);
  });

  it("gives everything for a pin on the top spot", () => {
    expect(scoreRound(round, stations, at(0), scoring)).toMatchObject({
      points: 1000, valuePoints: 600, distancePoints: 400, top: 0, km: 0, near: { station: 0, value: 81, beat: 1 },
    });
  });

  it("scores the weather at the nearest station and the distance to the top spot", () => {
    // Pierre, 80 °F: a degree short, halfway from the median (79) to the top
    const s = scoreRound(round, stations, at(1), scoring);
    expect(s.near).toMatchObject({ station: 1, value: 80, beat: 0.75 });
    expect(s.valuePoints).toBe(300);
    expect(s.km).toBeCloseTo(haversineKm(44.38, -100.29, 44.05, -101.6), 6);
    expect(s.distancePoints).toBe(distancePoints(s.km));
    expect(s.points).toBe(s.valuePoints + s.distancePoints);
  });

  it("gives no weather points below the median, or with no station near the pin", () => {
    expect(scoreRound(round, stations, at(4), scoring).valuePoints).toBe(0); // Lincoln, 75 °F
    const sea = scoreRound(round, stations, [-125, 30], scoring);
    expect(sea.near).toBeNull();
    expect(sea.valuePoints).toBe(0);
  });

  it("is kinder of rank and closeness to the top", () => {
    const r: Round = { ...round, best: 100, floor: 50, v: [100, 99, 60, 55, 50, 50, 50, 50, 50], i: [0, 1, 2, 3, 4, 0, 0, 0, 0] };
    // 99: closeness, 49 of the 50 degrees from the median to the top
    expect(extremeness(r, 99).share).toBeCloseTo(0.98);
    // 60 beat 6 of the 8 others: rank ((0.75 - 0.5) / 0.5)² = 0.25, more than closeness (10 of 50 = 0.2)
    expect(extremeness(r, 60)).toEqual({ share: 0.25, beat: 0.75 });
    // 50, tied with four others: beat 2 of 8 (ties count half)
    expect(extremeness(r, 50)).toEqual({ share: 0, beat: 0.25 });
  });

  it("counts every station tied for the top as the top spot", () => {
    const tied: Round = { ...round, top: [0, 2], v: [81, 80, 81, 70, 75] };
    expect(scoreRound(tied, stations, at(2), scoring)).toMatchObject({ top: 2, km: 0, points: 1000 });
  });

  it("knows the lowest value wins the cold rounds", () => {
    const cold: Round = { ...round, kind: "coldest", best: 20, floor: 30, v: [20, 25, 30, 40, 35] };
    expect(scoreRound(cold, stations, at(0), scoring).valuePoints).toBe(600);
    expect(scoreRound(cold, stations, at(1), scoring).valuePoints).toBe(300); // 25: halfway from 30 to 20
    expect(scoreRound(cold, stations, at(3), scoring).valuePoints).toBe(0);
  });
});

describe("Wx Marks the Spot wording", () => {
  it("formats values in the viewer's units", () => {
    expect(formatValue(round, 81, gameUnits(null))).toBe("81 °F");
    expect(formatValue(round, 50, { speed: "kt", temp: "C" })).toBe("10 °C");
    const gust = { ...round, kind: "gust" as const, unit: "kt" };
    expect(formatValue(gust, 41, gameUnits(null))).toBe("47 mph");
    expect(formatValue(gust, 41, { speed: "kt", temp: "F" })).toBe("41 kt");
    const swing = { ...round, kind: "cooldown" as const };
    expect(formatValue(swing, -18, { speed: "kt", temp: "C" })).toBe("−10 °C");
    expect(formatValue(swing, -18, gameUnits(null), true)).toBe("18 °F");
    expect(formatValue({ ...swing, kind: "warmup" }, 18, gameUnits(null))).toBe("+18 °F");
    expect(formatValue({ ...swing, kind: "warmup" }, 0, gameUnits(null))).toBe("0 °F");
    expect(formatValue({ ...round, kind: "wettest", unit: "in", decimals: 2 }, 0.4, gameUnits(null))).toBe("0.40 in");
  });

  it("asks short questions with the answer's value", () => {
    const units = gameUnits(null);
    expect(prompt(round, units)).toMatchObject({ label: "Hot spot", question: "Where did it hit 81 °F?" });
    expect(prompt({ ...round, kind: "gust", unit: "kt", best: 41 }, units).question).toBe("Where did the wind gust to 47 mph?");
    expect(prompt({ ...round, kind: "cooldown", best: -16 }, units).question).toBe("Where was it 16 °F colder than the day before?");
    expect(prompt({ ...round, kind: "wettest", unit: "in", decimals: 2, best: 0.42 }, units).question)
      .toBe("Where did 0.42 in of rain fall?");
    expect(prompt(round, { speed: "kt", temp: "C" }).question).toBe("Where did it hit 27 °C?");
  });

  it("says yesterday only when it was", () => {
    expect(dayLine("2026-10-20", new Date(2026, 9, 21, 9))).toBe("Yesterday, Tuesday, October 20");
    expect(dayLine("2026-10-20", new Date(2026, 9, 25, 9))).toBe("Tuesday, October 20, 2026");
  });

  it("writes the share text", () => {
    expect(formatKm(4.25)).toBe("4.3 km");
    expect(formatKm(1234.4)).toBe("1,234 km");
    expect([950, 700, 400, 100].map(square).join("")).toBe("🟩🟨🟧🟥");
    expect(shareText({ ...puzzle, rounds: [round, round] }, [950, 412], "https://runtorunwx.com/play/spot/"))
      .toBe("Wx Marks the Spot #20: 1,362/2,000\n🟩🟧\nhttps://runtorunwx.com/play/spot/");
  });
});

describe("Wx Marks the Spot puzzle", () => {
  it("rejects a puzzle it can't read", () => {
    expect(() => checkPuzzle(puzzle)).not.toThrow();
    expect(() => checkPuzzle({ ...puzzle, v: 1 as 2 })).toThrow(/unsupported/);
    expect(() => checkPuzzle({ ...puzzle, rounds: [{ ...round, v: [1] }] })).toThrow(/malformed/);
    expect(() => checkPuzzle({ ...puzzle, rounds: [{ ...round, top: [1] }] })).toThrow(/malformed/);
  });

  it("decodes a map's bytes", () => {
    const data = btoa(String.fromCharCode(0, 10, 255));
    const got = decodeMap({ label: "", grid: { lat0: 0, lon0: 0, dlat: -0.5, dlon: 0.5, ny: 1, nx: 3 },
      scale: 0.5, offset: -60, nodata: 255, data, link: {} });
    expect([got[0], got[1]]).toEqual([-60, -55]);
    expect(got[2]).toBeNaN();
  });
});
