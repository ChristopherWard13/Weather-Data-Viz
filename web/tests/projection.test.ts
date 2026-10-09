import { describe, expect, it } from "vitest";
import { buildLookup, domainAspect, fitProjection, gridX, nearestGridPoint } from "../src/projection";
import type { Grid } from "../src/types";

const G: Grid = {
  nx: 481, ny: 221, lon0: -170, lat0: 70, dlon: 0.25, dlat: -0.25,
  row_order: "north_to_south", col_order: "west_to_east",
  lat_min: 15, lat_max: 70, lon_min: -170, lon_max: -50,
};

describe("projection + lookup", () => {
  const W = 600;
  const H = Math.round(W / domainAspect(G));
  const proj = fitProjection(G, W, H, 10);
  const lut = buildLookup(proj, G, W, H);

  it("fits the domain inside the canvas", () => {
    for (const ll of [[-170, 70], [-50, 70], [-170, 15], [-50, 15], [-110, 15], [-110, 70]] as [number, number][]) {
      const [x, y] = proj(ll)!;
      expect(x).toBeGreaterThanOrEqual(9);
      expect(x).toBeLessThanOrEqual(W - 9);
      expect(y).toBeGreaterThanOrEqual(9);
      expect(y).toBeLessThanOrEqual(H - 9);
    }
  });

  it("samples the grid point under each pixel", () => {
    // Known places land on the expected grid cell
    for (const [lon, lat] of [[-100, 45], [-155.5, 19.75], [-60.25, 66], [-122.4, 37.8]]) {
      const [x, y] = proj([lon, lat])!;
      const k = Math.floor(y) * W + Math.floor(x);
      const idx = lut.index[k];
      expect(idx).toBeGreaterThanOrEqual(0);
      const i = (idx % G.nx) + lut.fx[k];
      const j = Math.floor(idx / G.nx) + lut.fy[k];
      // Within one pixel of the expected fractional grid position
      const [plon, plat] = proj.invert!([Math.floor(x) + 0.5, Math.floor(y) + 0.5])!;
      expect(i).toBeCloseTo((plon - G.lon0) / G.dlon, 3);
      expect(j).toBeCloseTo((plat - G.lat0) / G.dlat, 3);
      expect(Math.abs(i - (lon - G.lon0) / G.dlon)).toBeLessThan(2);
      expect(Math.abs(j - (lat - G.lat0) / G.dlat)).toBeLessThan(2);
    }
  });

  it("marks pixels outside the domain", () => {
    expect(lut.index[0]).toBe(-1); // top-left corner of a conic fan is empty
    const [x, y] = proj([-30, 40])!; // Atlantic, east of the domain
    if (x >= 0 && x < W && y >= 0 && y < H) expect(lut.index[Math.floor(y) * W + Math.floor(x)]).toBe(-1);
  });
});

describe("grid helpers", () => {
  it("handles longitude wrap", () => {
    expect(gridX(190, -170, 0.25)).toBeCloseTo(0);
    expect(gridX(-50, -170, 0.25)).toBeCloseTo(480);
  });
  it("finds the nearest grid point", () => {
    expect(nearestGridPoint(G, -100.1, 45.1)).toEqual({ i: 280, j: 100, lon: -100, lat: 45 });
    expect(nearestGridPoint(G, -40, 45)).toBeNull();
  });
});
