import { describe, expect, it } from "vitest";
import { config, gridCovers, growBox, MIN_STATE_BOX, regionById, regionDepth } from "../src/config";
import { regionAt, stateAt } from "../src/basemap";
import { centralMeridian, fitProjection } from "../src/projection";
import { extreme } from "../src/views/util";
import type { Grid } from "../src/types";

describe("regions", () => {
  it("open on North America, the na025 grid", () => {
    expect(config.regions[0]).toMatchObject({ id: "na", parent: null, box: { lat: [15, 70], lon: [-170, -50] } });
    expect(regionById("northeast")).toMatchObject({ parent: "us", box: { lat: [37, 48], lon: [-83, -66] } });
    expect(regionById("hawaii")).toMatchObject({ parent: "na", hit: "box" });
    expect(regionById("us")!.parent).toBe("na");
  });

  it("give each state to exactly one hit area", () => {
    const states = config.regions.filter((r) => !r.state).flatMap((r) => r.states);
    expect(states).toHaveLength(50); // the 48, DC and Hawaii
    expect(new Set(states).size).toBe(states.length);
    expect(regionById("us")!.states).toEqual([]); // reached through its sub-regions
  });

  it("are covered by the global grid", () => {
    for (const r of config.regions) expect(gridCovers("na025", r.box), r.id).toBe(true);
    expect(gridCovers("na025", { lat: [10, 20], lon: [-100, -90] })).toBe(false);
  });

  it("find the region under a point from the merged state polygons", () => {
    expect(regionAt(-73.76, 42.65)).toBe("northeast"); // Albany
    expect(regionAt(-77.04, 38.9)).toBe("northeast"); // Washington, DC
    expect(regionAt(-87.6, 41.9)).toBe("midwest"); // Chicago
    expect(regionAt(-97.7, 30.3)).toBe("splains"); // Austin
    expect(regionAt(-104.99, 39.74)).toBe("southwest"); // Denver
    expect(regionAt(-122.3, 47.6)).toBe("northwest"); // Seattle
    expect(regionAt(-100.8, 46.8)).toBe("nplains"); // Bismarck
    expect(regionAt(-84.4, 33.75)).toBe("southeast"); // Atlanta
    expect(regionAt(-155.5, 19.6)).toBe("hawaii"); // Mauna Loa
    expect(regionAt(-157.0, 21.6)).toBe("hawaii"); // between islands: Hawaii's target is its box
    expect(regionAt(-79.4, 43.7)).toBeNull(); // Toronto
    expect(regionAt(-99.1, 19.4)).toBeNull(); // Mexico City
    expect(regionAt(-149.9, 61.2)).toBeNull(); // Anchorage: Alaska has no region
    expect(regionAt(-70, 35)).toBeNull(); // the Atlantic
  });
});

describe("states", () => {
  it("are zoom targets under their region, except DC and Hawaii", () => {
    const states = config.regions.filter((r) => r.state);
    expect(states).toHaveLength(48);
    expect(regionById("ny")).toMatchObject({ label: "New York", parent: "northeast", states: ["NY"], state: { code: "NY" } });
    expect(regionById("tx")!.parent).toBe("splains");
    expect(regionById("dc")).toBeUndefined();
    expect(regionById("hi")).toBeUndefined();
    for (const r of states) {
      expect(regionDepth(r), r.id).toBe(3);
      expect(regionById(r.parent)!.states, r.id).toContain(r.state!.code);
    }
    expect(regionDepth(regionById("na")!)).toBe(0);
    expect(regionDepth(regionById("us")!)).toBe(1);
    expect(regionDepth(regionById("northeast")!)).toBe(2);
  });

  it("show at least the minimum box, centered on the state", () => {
    const ri = regionById("ri")!.box; // Rhode Island: about 1° across
    expect(ri.lon[1] - ri.lon[0]).toBeCloseTo(MIN_STATE_BOX.lon, 6);
    expect(ri.lat[1] - ri.lat[0]).toBeCloseTo(MIN_STATE_BOX.lat, 6);
    expect((ri.lon[0] + ri.lon[1]) / 2).toBeCloseTo(-71.5, 0);
    const tx = regionById("tx")!.box; // Texas is bigger than the minimum both ways
    expect(tx.lon[1] - tx.lon[0]).toBeGreaterThan(12);
    expect(growBox({ lat: [40, 50], lon: [-100, -99] }, { lat: 4, lon: 3 })).toEqual({ lat: [40, 50], lon: [-101, -98] });
  });

  it("are found under a point from their own polygons", () => {
    expect(stateAt(-73.76, 42.65)).toBe("ny"); // Albany
    expect(stateAt(-71.41, 41.82)).toBe("ri"); // Providence
    expect(stateAt(-87.6, 41.9)).toBe("il"); // Chicago
    expect(stateAt(-97.7, 30.3)).toBe("tx"); // Austin
    expect(stateAt(-77.04, 38.9)).toBeNull(); // Washington, DC: not a target
    expect(stateAt(-79.4, 43.7)).toBeNull(); // Toronto
    expect(stateAt(-70, 35)).toBeNull(); // the Atlantic
  });
});

describe("projection centered on the region (Q15)", () => {
  const G: Grid = {
    id: "na025", nx: 481, ny: 221, lon0: -170, lat0: 70, dlon: 0.25, dlat: -0.25,
    row_order: "north_to_south", col_order: "west_to_east", lat_min: 15, lat_max: 70, lon_min: -170, lon_max: -50,
  };

  it("uses the region's middle meridian, and the domain's without one", () => {
    expect(centralMeridian(null)).toBe(config.projection.centralMeridian);
    expect(centralMeridian(regionById("us")!.box)).toBe(-96);
  });

  it("draws the region's middle meridian straight up the canvas", () => {
    const proj = fitProjection(G, 900, 500, 10, regionById("northeast")!.box);
    const [x1] = proj([-74.5, 38])!, [x2] = proj([-74.5, 47])!;
    expect(Math.abs(x1 - x2)).toBeLessThan(0.01);
  });
});

describe("stats in a focused region", () => {
  // 1° grid, 50N..20N x 130W..60W; the global max is at the western edge
  const G: Grid = {
    id: "t", nx: 71, ny: 31, lon0: -130, lat0: 50, dlon: 1, dlat: -1,
    row_order: "north_to_south", col_order: "west_to_east", lat_min: 20, lat_max: 50, lon_min: -130, lon_max: -60,
  };
  const v = new Float32Array(G.nx * G.ny).map((_, k) => 100 - (k % G.nx));

  it("look only inside the region's box", () => {
    expect(extreme(v, { grid: G }, 1)).toMatchObject({ v: 100, lon: -130 });
    const ne = extreme(v, { grid: G, focus: regionById("northeast")!.box }, 1);
    expect(ne).toMatchObject({ v: 53, lon: -83 });
    expect(ne.lat).toBeGreaterThanOrEqual(37);
    expect(ne.lat).toBeLessThanOrEqual(48);
    expect(extreme(v, { grid: G, focus: regionById("northeast")!.box }, -1)).toMatchObject({ v: 36, lon: -66 });
  });

  it("can be limited to some points, still inside the box (the review's Colorado snow in a Northeast zoom)", () => {
    // Only points west of 100W pass: none of them are in the Northeast
    const west = (k: number) => k % G.nx < 30;
    expect(extreme(v, { grid: G }, 1, west)).toMatchObject({ v: 100, lon: -130 });
    expect(extreme(v, { grid: G, focus: regionById("northeast")!.box }, 1, west).v).toBe(-Infinity);
    const odd = extreme(v, { grid: G, focus: regionById("northeast")!.box }, 1, (k) => (k % G.nx) % 2 === 0);
    expect(odd).toMatchObject({ v: 52, lon: -82 });
  });
});
