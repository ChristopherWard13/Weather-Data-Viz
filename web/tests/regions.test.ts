import { describe, expect, it } from "vitest";
import { config, gridCovers, regionById } from "../src/config";
import { regionAt } from "../src/basemap";
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
    const states = config.regions.flatMap((r) => r.states);
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
