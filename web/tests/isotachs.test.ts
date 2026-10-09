import { describe, expect, it } from "vitest";
import { isotachLines, smoothForContours, splitAtFrame } from "../src/isotachs";
import type { Grid } from "../src/types";

function grid(nx: number, ny: number): Grid {
  return {
    nx, ny, lon0: -170, lat0: 70, dlon: 0.25, dlat: -0.25,
    row_order: "north_to_south", col_order: "west_to_east",
    lat_min: 70 - (ny - 1) * 0.25, lat_max: 70, lon_min: -170, lon_max: -170 + (nx - 1) * 0.25,
  };
}

describe("isotachLines", () => {
  it("places a crossing at the right longitude", () => {
    // Speed increases 10 kt per column; the 25 kt isotach lies halfway between
    // columns 2 and 3, i.e. at lon0 + 2.5 * dlon.
    const g = grid(8, 6);
    const frame = new Uint8Array(g.nx * g.ny);
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) frame[j * g.nx + i] = i * 10;
    const lines = isotachLines(frame, g, [25]);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.closed).toBe(false); // the ring's frame segments are removed
      for (const [lon] of l.coords) expect(lon).toBeCloseTo(-170 + 2.5 * 0.25, 6);
    }
  });

  it("places a crossing at the right latitude (row 0 is north)", () => {
    const g = grid(6, 8);
    const frame = new Uint8Array(g.nx * g.ny);
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) frame[j * g.nx + i] = 100 + j * 10;
    // 135 kt between rows 3 (130) and 4 (140): lat = 70 - 3.5 * 0.25
    for (const l of isotachLines(frame, g, [135])) {
      for (const [, lat] of l.coords) expect(lat).toBeCloseTo(70 - 3.5 * 0.25, 6);
    }
  });

  it("keeps an interior closed contour closed and centered", () => {
    const g = grid(9, 9);
    const frame = new Uint8Array(81);
    frame[4 * 9 + 4] = 200; // single peak at the center grid point
    const lines = isotachLines(frame, g, [100]);
    expect(lines).toHaveLength(1);
    expect(lines[0].closed).toBe(true);
    const lons = lines[0].coords.map((c) => c[0]);
    const lats = lines[0].coords.map((c) => c[1]);
    const mid = (a: number[]) => (Math.min(...a) + Math.max(...a)) / 2;
    expect(mid(lons)).toBeCloseTo(-170 + 4 * 0.25, 6);
    expect(mid(lats)).toBeCloseTo(70 - 4 * 0.25, 6);
  });
});

describe("splitAtFrame", () => {
  it("drops vertices on the outer frame", () => {
    const ring: [number, number][] = [[0, 1], [1, 1], [2, 2], [1, 3], [0, 3], [0, 1]];
    const parts = splitAtFrame(ring, 5, 5);
    expect(parts).toEqual([{ points: [[1, 1], [2, 2], [1, 3]], closed: false }]);
  });
});

describe("smoothForContours", () => {
  it("preserves a constant field and a linear ramp", () => {
    const nx = 5, ny = 4;
    const flat = new Uint8Array(nx * ny).fill(120);
    expect([...smoothForContours(flat, nx, ny)].every((v) => v === 120)).toBe(true);
    const ramp = Uint8Array.from({ length: nx * ny }, (_, k) => (k % nx) * 10);
    const s = smoothForContours(ramp, nx, ny);
    for (let j = 0; j < ny; j++) for (let i = 1; i < nx - 1; i++) expect(s[j * nx + i]).toBeCloseTo(i * 10);
  });
  it("conserves the field's total away from edges", () => {
    const nx = 7, ny = 7;
    const f = new Uint8Array(nx * ny);
    f[3 * nx + 3] = 160;
    const s = smoothForContours(f, nx, ny);
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(160);
    expect(s[3 * nx + 3]).toBeCloseTo(40); // peak weight 0.5 * 0.5
  });
});
