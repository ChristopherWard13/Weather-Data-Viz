import { describe, expect, it } from "vitest";
import { pairFor } from "../src/alignment";
import { VIEWS, viewById } from "../src/views";
import type { Mode, ViewInputs } from "../src/views/types";
import type { Bands, Grid } from "../src/types";

const G: Grid = {
  nx: 40, ny: 30, lon0: -120, lat0: 50, dlon: 0.25, dlat: -0.25,
  row_order: "north_to_south", col_order: "west_to_east",
  lat_min: 42.75, lat_max: 50, lon_min: -120, lon_max: -110.25,
};
const N = G.nx * G.ny;

/** Smooth synthetic fields: a jet, a warm south, a low, a precip blob. */
function bands(shift = 0): Record<string, Bands> {
  const f = (fn: (i: number, j: number) => number) => {
    const a = new Float32Array(N);
    for (let j = 0; j < G.ny; j++) for (let i = 0; i < G.nx; i++) a[j * G.nx + i] = fn(i, j);
    return a;
  };
  return {
    wspd250: { speed: f((_, j) => 140 - Math.abs(j - 15) * 8 + shift) },
    wdir250: { dir: f(() => 270) },
    t2m: { temp: f((_, j) => 20 + j * 1.5 + shift) },
    d2m: { dewpt: f((_, j) => 10 + j) },
    wspd10: { speed: f((i) => i + shift) },
    wdir10: { dir: f(() => 180) },
    gust: { gust: f((i) => i * 1.5) },
    mslp: { mslp: f((i, j) => 1012 - 20 * Math.exp(-((i - 20) ** 2 + (j - 15) ** 2) / 30)) },
    precip: { qpf: f((i, j) => Math.max(0, 1 - ((i - 20) ** 2 + (j - 15) ** 2) / 60) + shift * 0.01), ptype: f((_, j) => (j < 15 ? 2 : 1)) },
  };
}

function inputs(viewId: string, mode: Mode, variable = "", old = true): ViewInputs {
  const view = viewById(viewId);
  const memo = new Map<string, unknown>();
  return {
    grid: G,
    mode,
    variable: variable || view.variables?.[0].id || "",
    overlays: new Set(view.overlays.map((o) => o.id)),
    isotachs: [100, 120],
    limitMode: "fixed",
    pair: pairFor(new Date("2026-10-08T18:00:00Z"), 24, 48),
    cur: bands(),
    old: old && mode === "trend" ? bands(5) : {},
    memo: <T,>(k: string, make: () => T) => (memo.has(k) ? (memo.get(k) as T) : (memo.set(k, make()), memo.get(k) as T)),
  };
}

describe("views", () => {
  for (const view of VIEWS) {
    for (const mode of view.modes) {
      for (const variable of view.variables?.map((v) => v.id) ?? [""]) {
        it(`${view.id} ${mode} ${variable}: builds a full scene`, () => {
          const scene = view.scene(inputs(view.id, mode, variable));
          expect(scene.raster).not.toBeNull();
          expect(scene.layers.length).toBeGreaterThan(0);
          expect(scene.caption.length).toBeGreaterThan(5);
          const rows = scene.readout(15 * G.nx + 20);
          expect(rows.length).toBeGreaterThanOrEqual(2);
          for (const r of rows) expect(r.value).not.toMatch(/NaN|undefined/);
          if (mode === "trend") {
            expect(scene.colorbar.kind).toBe("diverging");
            expect(rows.some((r) => r.label === "Δ")).toBe(true);
          }
        });
      }
    }
  }

  it("trend Δ is current minus older", () => {
    const scene = viewById("jet").scene(inputs("jet", "trend"));
    const delta = scene.readout(0).find((r) => r.label === "Δ")!;
    expect(delta.value).toBe("−5 kt"); // older run is 5 kt faster everywhere
    expect(delta.cls).toBe("neg");
  });

  it("keeps current-run overlays when the older run is missing", () => {
    const scene = viewById("jet").scene(inputs("jet", "trend", "", false));
    expect(scene.raster).toBeNull();
    expect(scene.colorbar.kind).toBe("disabled");
    expect(scene.layers.some((l) => l.kind === "contours")).toBe(true);
  });

  it("titles follow the spec for the jet trend and name each product", () => {
    const t = { model: "GFS", init: "2026-10-08 18Z", older: "2026-10-06 18Z", valid: "2026-10-09 18Z", fhr: "F024" };
    expect(viewById("jet").title("trend", "", t)).toBe(
      "GFS 250 mb |V| trend: init 2026-10-08 18Z vs 2026-10-06 18Z | valid 2026-10-09 18Z | F024",
    );
    expect(viewById("t2m").title("fcst", "dewpt", t)).toContain("2 m dew point (°F)");
    expect(viewById("wind10").title("fcst", "gust", t)).toContain("10 m wind gust (kt)");
    expect(viewById("precip").title("fcst", "", t)).toContain("6 h ending 2026-10-09 18Z");
  });

  it("loads only the fields each view needs", () => {
    const jet = viewById("jet");
    expect(jet.fields("trend", "", new Set())).toEqual({ primary: "wspd250", current: ["wspd250"], older: ["wspd250"] });
    expect(jet.fields("fcst", "", new Set(["arrows"])).current).toContain("wdir250");
    const wind = viewById("wind10").fields("trend", "gust", new Set(["barbs"]));
    expect(wind).toEqual({ primary: "gust", current: ["wspd10", "gust", "wdir10"], older: ["gust"] });
    expect(viewById("precip").fields("fcst", "", new Set()).current).toEqual(["precip"]);
  });

  it("finds the synthetic low as an L center", () => {
    const scene = viewById("precip").scene({ ...inputs("precip", "fcst"), grid: G });
    const markers = scene.layers.find((l) => l.kind === "markers");
    expect(markers && markers.kind === "markers" && markers.items.map((m) => m.kind)).toEqual(["L"]);
  });
});
