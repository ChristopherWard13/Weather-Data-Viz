import { describe, expect, it } from "vitest";
import { barbCounts, screenBearing } from "../src/barbs";
import { fitProjection } from "../src/projection";
import type { Grid } from "../src/types";

const G: Grid = {
  nx: 481, ny: 221, lon0: -170, lat0: 70, dlon: 0.25, dlat: -0.25,
  row_order: "north_to_south", col_order: "west_to_east",
  lat_min: 15, lat_max: 70, lon_min: -170, lon_max: -50,
};

describe("barbCounts", () => {
  it.each([
    [0, { pennants: 0, barbs: 0, half: 0, calm: true }],
    [2, { pennants: 0, barbs: 0, half: 0, calm: true }],
    [5, { pennants: 0, barbs: 0, half: 1, calm: false }],
    [15, { pennants: 0, barbs: 1, half: 1, calm: false }],
    [47, { pennants: 0, barbs: 4, half: 1, calm: false }],
    [48, { pennants: 1, barbs: 0, half: 0, calm: false }], // rounds to 50
    [65, { pennants: 1, barbs: 1, half: 1, calm: false }],
    [150, { pennants: 3, barbs: 0, half: 0, calm: false }],
  ])("%d kt", (kt, expected) => {
    expect(barbCounts(kt)).toEqual(expected);
  });
});

describe("screenBearing", () => {
  const proj = fitProjection(G, 800, 500);
  it("points up for north and right for east on the central meridian", () => {
    const [nx, ny] = screenBearing(proj, -110, 45, 0);
    expect(nx).toBeCloseTo(0, 3);
    expect(ny).toBeCloseTo(-1, 3);
    const [ex, ey] = screenBearing(proj, -110, 45, 90);
    expect(ex).toBeCloseTo(1, 2);
    expect(Math.abs(ey)).toBeLessThan(0.05);
  });
  it("tilts north toward the pole away from the central meridian", () => {
    const [wx] = screenBearing(proj, -160, 45, 0); // west of center: north leans right
    const [ex] = screenBearing(proj, -60, 45, 0); // east of center: north leans left
    expect(wx).toBeGreaterThan(0.3);
    expect(ex).toBeLessThan(-0.3);
  });
});
