import { describe, expect, it } from "vitest";
import { pairFor } from "../src/alignment";
import { availableVariables, FIELD_ITEMS, fieldItem, missingNoun, overlayFields, requiredFields, VIEWS, viewAvailable, viewById } from "../src/views";
import { windowFor } from "../src/accum";
import { config } from "../src/config";
import { QPF_TOTAL_BINS, SNOW_BINS } from "../src/palettes";
import type { Mode, ViewInputs } from "../src/views/types";
import type { Bands, Grid } from "../src/types";
import { DEFAULT_UNITS, type Units } from "../src/units";

const G: Grid = {
  id: "test",
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
    // Snowfall as liquid equivalent: the north half of the blob
    snow: { sf: f((i, j) => (j < 15 ? Math.max(0, 1 - ((i - 20) ** 2 + (j - 15) ** 2) / 60) : 0) + shift * 0.01) },
    hgt500: { hgt: f((i, j) => 5700 - j * 8 - 60 * Math.exp(-((i - 20) ** 2) / 40) + shift) },
    // edges are nodata, as the pipeline writes them
    vort500: { vort: f((i, j) => (i === 0 || j === 0 || i === G.nx - 1 || j === G.ny - 1 ? NaN : 10 + 20 * Math.exp(-((i - 20) ** 2 + (j - 15) ** 2) / 30))) },
    t850: { temp: f((_, j) => -8 + j * 0.6 + shift / 5) },
  };
}

function inputs(viewId: string, mode: Mode, variable = "", old = true, units: Units = DEFAULT_UNITS): ViewInputs {
  const view = viewById(viewId);
  const memo = new Map<string, unknown>();
  return {
    grid: G,
    mode,
    variable: variable || view.variables?.[0].id || "",
    overlays: new Set(view.overlays.map((o) => o.id)),
    isotachs: [100, 120],
    limitMode: "fixed",
    units,
    pair: pairFor(new Date("2026-10-08T18:00:00Z"), 24, 48),
    cur: bands(),
    old: old && mode === "trend" ? bands(5) : {},
    sides: { cur: "Current", old: "Older", minus: "2026-10-08 18Z minus 2026-10-06 18Z" },
    precipType: true,
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
          // 500 mb shaded by height has just the one value to read out
          expect(rows.length).toBeGreaterThanOrEqual(view.id === "h500" && variable === "hgt" && mode === "fcst" ? 1 : 2);
          for (const r of rows) expect(r.value).not.toMatch(/NaN|undefined/);
          if (mode === "trend") {
            expect(scene.colorbar.kind).toBe("diverging");
            expect(rows.some((r) => r.label === "Δ")).toBe(true);
          }
        });
      }
    }
  }

  it("precipitation from a model without type output says so", () => {
    const inp = { ...inputs("precip", "fcst"), precipType: false };
    const { qpf } = inp.cur.precip!;
    inp.cur.precip = { qpf, ptype: qpf.map((v) => (v >= 0.005 ? 5 : 0)) };
    const scene = viewById("precip").scene(inp);
    expect(scene.colorbar).toEqual({ kind: "precip", untyped: true });
    // Said once, by the legend's note, not again in the caption
    expect(scene.caption).toBe("6-h precipitation (in, liquid equivalent)");
    expect(scene.stats.map((s) => s.label)).toEqual(["Max 6-h total"]); // unspecified is never "frozen"
    expect(scene.stats[0].sub).not.toMatch(/unspecified/);
    expect(scene.readout(15 * G.nx + 20).find((r) => r.label === "Type")!.value).toBe("not available");
  });

  it("the precipitation title mentions type only when the model has it", () => {
    const t = { init: "a", older: "b", valid: "c", fhr: "F024", model: "AIGFS", units: DEFAULT_UNITS };
    expect(viewById("precip").title("fcst", "", { ...t, untyped: true })).toMatch(/^AIGFS 6-h precipitation \|/);
    expect(viewById("precip").title("fcst", "", t)).toMatch(/^AIGFS 6-h precipitation & type \|/);
  });

  it("untyped follows the model, not the data: a dry frame keeps the untyped legend", () => {
    const inp = { ...inputs("precip", "fcst"), precipType: false };
    inp.cur.precip = { qpf: new Float32Array(N), ptype: new Float32Array(N) };
    expect(viewById("precip").scene(inp).colorbar).toEqual({ kind: "precip", untyped: true });
  });

  it("precipitation with types keeps the typed legend", () => {
    const scene = viewById("precip").scene(inputs("precip", "fcst"));
    expect(scene.colorbar).toEqual({ kind: "precip", untyped: false });
    expect(scene.stats.some((s) => s.label.startsWith("Max frozen (snow)"))).toBe(true);
  });

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
    const t = { model: "GFS", init: "2026-10-08 18Z", older: "2026-10-06 18Z", valid: "2026-10-09 18Z", fhr: "F024", units: DEFAULT_UNITS };
    expect(viewById("jet").title("trend", "", t)).toBe(
      "GFS 250 mb |V| trend: init 2026-10-08 18Z vs 2026-10-06 18Z | valid 2026-10-09 18Z | F024",
    );
    expect(viewById("t2m").title("fcst", "dewpt", t)).toContain("2 m dew point (°F)");
    expect(viewById("wind10").title("fcst", "gust", t)).toContain("10 m wind gust (kt)");
    expect(viewById("precip").title("fcst", "", t)).toContain("6 h ending 2026-10-09 18Z");
    expect(viewById("h500").title("trend", "", t)).toBe(
      "GFS 500 mb height trend: init 2026-10-08 18Z vs 2026-10-06 18Z | valid 2026-10-09 18Z | F024",
    );
    // °F by default, 850 mb too; °C when chosen
    expect(viewById("t850").title("fcst", "", t)).toContain("GFS 850 mb temperature (°F)");
    expect(viewById("t850").title("fcst", "", { ...t, units: { speed: "kt", temp: "C" } })).toContain("850 mb temperature (°C)");
  });

  it("shows the viewer's units, converting from the stored ones", () => {
    const mph: Units = { speed: "mph", temp: "C" };
    // Synthetic 10 m wind is i kt at column i; column 20 is 20 kt = 23 mph
    const wind = viewById("wind10").scene(inputs("wind10", "fcst", "speed", true, mph));
    expect(wind.caption).toBe("10 m sustained wind (mph)");
    expect(wind.readout(15 * G.nx + 20)[0].value).toBe("S 23 mph");
    expect(wind.colorbar.kind === "continuous" && wind.colorbar.format!(wind.colorbar.ticks[1])).toBe("10");
    // 2 m temperature 20 + 1.5j °F: row 0 is 20 °F = -7 °C, with °F second
    const temp = viewById("t2m").scene(inputs("t2m", "fcst", "temp", true, mph));
    expect(temp.readout(0)[0].value).toBe("-7°C (20°F)");
    expect(temp.caption).toBe("2 m temperature (°C)");
    // 850 mb stored in °C: -8 °C shows as 18 °F by default
    const t850 = viewById("t850").scene(inputs("t850", "fcst"));
    expect(t850.readout(0)[0].value).toBe("18°F");
    // Trends: the fixed ±20 kt becomes a round ±25 mph; heights in dam
    const wt = viewById("wind10").scene(inputs("wind10", "trend", "speed", true, mph));
    expect(wt.caption).toContain("values beyond ±25 mph clipped");
    expect(wt.colorbar.kind === "diverging" && wt.colorbar.scale).toBeCloseTo(1.1508, 3);
    const ht = viewById("h500").scene(inputs("h500", "trend"));
    expect(ht.caption).toMatch(/^Δ 500 mb height \(dam\).*±6 dam clipped$/);
    expect(ht.readout(0).find((r) => r.label === "Δ")!.value).toMatch(/ dam$/);
  });

  it("loads only the fields each view needs", () => {
    const jet = viewById("jet");
    expect(jet.fields("trend", "", new Set())).toEqual({ primary: "wspd250", current: ["wspd250"], older: ["wspd250"] });
    expect(jet.fields("fcst", "", new Set(["arrows"])).current).toContain("wdir250");
    const wind = viewById("wind10").fields("trend", "gust", new Set(["barbs"]));
    expect(wind).toEqual({ primary: "gust", current: ["wspd10", "gust", "wdir10"], older: ["gust"] });
    expect(viewById("precip").fields("fcst", "", new Set()).current).toEqual(["precip"]);
    // 500 mb: vorticity shading with heights; the trend compares heights only
    expect(viewById("h500").fields("fcst", "", new Set(["heights"]))).toEqual({ primary: "vort500", current: ["vort500", "hgt500"], older: [] });
    expect(viewById("h500").fields("trend", "", new Set(["heights"]))).toEqual({ primary: "hgt500", current: ["hgt500"], older: ["hgt500"] });
    expect(viewById("t850").fields("trend", "", new Set())).toEqual({ primary: "t850", current: ["t850"], older: ["t850"] });
    // What each overlay adds: without 250 mb direction there are no flow arrows or barbs to offer
    expect(overlayFields(jet, "fcst", "", "arrows")).toEqual(["wdir250"]);
    expect(overlayFields(jet, "trend", "", "older")).toEqual([]);
    expect(overlayFields(viewById("wind10"), "fcst", "speed", "isobars")).toEqual(["mslp"]);
    expect(overlayFields(viewById("h500"), "fcst", "hgt", "heights")).toEqual([]);
  });

  it("offers only variables and views whose fields the product has", () => {
    const all = new Set(["wspd250", "wdir250", "t2m", "d2m", "wspd10", "wdir10", "gust", "mslp", "precip", "hgt500", "vort500", "t850"]);
    const aifs = new Set([...all].filter((f) => f !== "gust"));
    expect(availableVariables(viewById("wind10"), all).map((v) => v.id)).toEqual(["speed", "gust"]);
    expect(availableVariables(viewById("wind10"), aifs).map((v) => v.id)).toEqual(["speed"]);
    expect(VIEWS.every((v) => viewAvailable(v, aifs))).toBe(true);
    const noUpper = new Set([...all].filter((f) => !["hgt500", "vort500", "t850"].includes(f)));
    expect(VIEWS.filter((v) => !viewAvailable(v, noUpper)).map((v) => v.id)).toEqual(["h500", "t850"]);
  });

  it("vorticity's nodata edges stay out of the stats and readout", () => {
    const scene = viewById("h500").scene(inputs("h500", "fcst"));
    expect(scene.stats[0].value).toBe("30 × 10⁻⁵ s⁻¹");
    expect(scene.readout(0).find((r) => r.label === "Abs. vorticity")!.value).toBe("—");
  });

  it("finds the synthetic low as an L center", () => {
    const scene = viewById("precip").scene({ ...inputs("precip", "fcst"), grid: G });
    const markers = scene.layers.find((l) => l.kind === "markers");
    expect(markers && markers.kind === "markers" && markers.items.map((m) => m.kind)).toEqual(["L"]);
  });

  it("list every view and variable once in the Fields sidebar", () => {
    // 500 mb's and precipitation's variables are a Shading choice in Options, so each is one sidebar item
    const pairs = VIEWS.flatMap((v) => (!["h500", "precip"].includes(v.id) && v.variables ? v.variables : [{ id: "" }]).map((x) => `${v.id}:${x.id}`));
    expect(FIELD_ITEMS.map((i) => `${i.view}:${i.variable}`).sort()).toEqual(pairs.sort());
    expect(FIELD_ITEMS.map((i) => i.group)).toEqual(["Surface", "Surface", "Surface", "Surface", "Surface", "Upper air", "Upper air", "Upper air"]);
    expect(fieldItem("wind10", "gust")).toMatchObject({ label: "Gusts", fields: ["gust"], noun: "gusts", short: "gust" });
    // Shading is a choice in forecast mode (vorticity or heights); the trend always shades heights. So a
    // model with heights but no vorticity (the ECMWF ENS mean) keeps the 500 mb item.
    expect(fieldItem("h500", "").fields).toEqual(["hgt500"]);
    expect(fieldItem("jet", "").fields).toEqual(["wspd250"]);
    expect(fieldItem("t2m", "dewpt").fields).toEqual(["d2m"]);
    expect(fieldItem("wind10", "gust").fields).toEqual(["gust"]);
    expect(fieldItem("h500", "hgt").label).toBe("500 mb");
  });

  it("shade 500 mb by height when asked: heights only, labelled in dam", () => {
    const v = viewById("h500");
    expect(v.fields("fcst", "hgt", new Set(["heights"]))).toEqual({ primary: "hgt500", current: ["hgt500"], older: [] });
    const scene = v.scene(inputs("h500", "fcst", "hgt"));
    expect(scene.colorbar).toMatchObject({ kind: "continuous", min: 4800, max: 6000 });
    expect(scene.stats.map((s) => s.label)).toEqual(["Lowest height", "Highest height"]);
    expect(scene.caption).toBe("500 mb height (dam) · contours every 6 dam");
  });

  it("name the models in a compare-mode difference", () => {
    const scene = viewById("t2m").scene({ ...inputs("t2m", "trend"), sides: { cur: "GFS", old: "ECMWF", minus: "GFS 12Z minus ECMWF 00Z" } });
    expect(scene.caption).toContain("GFS 12Z minus ECMWF 00Z");
    expect(scene.readout(0).map((r) => r.label)).toEqual(["GFS T", "ECMWF T", "Δ"]);
  });

  // ---------------------------------------------------------------- Phase 3.8: snowfall and totals

  const day = (start = "2026-10-08T18:00:00Z") => windowFor("24h", new Date("2026-10-09T18:00:00Z"), new Date(start));
  const PEAK = 14 * G.nx + 20; // in the snow half of the blob

  it("shades 6-h snowfall in inches at 10:1, from its liquid equivalent", () => {
    const inp = inputs("precip", "fcst", "snow");
    const scene = viewById("precip").scene(inp);
    expect(scene.raster?.kind).toBe("binned");
    expect(scene.raster?.kind === "binned" && scene.raster.bins).toEqual(SNOW_BINS);
    expect(scene.colorbar).toMatchObject({ kind: "bins", label: "Snow 10:1" });
    expect(scene.caption).toBe("6-h snowfall (in, 10:1 snow-to-liquid)");
    const liquid = inp.cur.snow!.sf[PEAK];
    const rows = scene.readout(PEAK);
    expect(rows.map((r) => r.label)).toEqual(["6-h snowfall (10:1)", "Liquid equivalent", "Pressure"]);
    expect(rows[0].value).toBe(`${(liquid * 10).toFixed(1)} in`);
    expect(rows[1].value).toBe(`${liquid.toFixed(2)} in`);
    expect(scene.readout(25 * G.nx + 20)[0].value).toBe("none"); // the rain half
  });

  it("shades totals of all precipitation as liquid, without type", () => {
    const scene = viewById("precip").scene({ ...inputs("precip", "fcst", "all"), acc: day() });
    expect(scene.raster?.kind === "binned" && scene.raster.bins).toEqual(QPF_TOTAL_BINS);
    expect(scene.colorbar).toMatchObject({ kind: "bins", label: "Liquid" });
    expect(scene.caption).toBe("24-h precipitation (in, liquid equivalent)");
    expect(scene.stats[0].label).toBe("Max 24-h precipitation");
    expect(scene.readout(PEAK).map((r) => r.label)).toEqual(["24-h precipitation", "Pressure"]);
  });

  it("says how many hours a 24-h total covers when the window cuts it short", () => {
    const short = day("2026-10-09T00:00:00Z"); // the newest run starts 18 h before
    expect(short.hours).toBe(18);
    const scene = viewById("precip").scene({ ...inputs("precip", "fcst", "snow"), acc: short });
    expect(scene.caption).toMatch(/^18-h snowfall/);
    // At the window's start there's nothing to sum; the title keeps the period's name
    const t = { init: "a", older: "b", valid: "c", fhr: "F000", model: "GFS", units: DEFAULT_UNITS };
    expect(viewById("precip").title("fcst", "all", { ...t, acc: { period: "24h", hours: 0, from: "c" } })).toBe("GFS 24-h precipitation | init a | 24 h ending c | F000");
    expect(viewById("precip").title("fcst", "all", { ...t, acc: { period: "total", hours: 0, from: "c" } })).toBe("GFS total precipitation | init a | starting c | F000");
  });

  it("trends totals over the same window, with their own scales", () => {
    const inp = { ...inputs("precip", "trend", "snow"), acc: windowFor("total", new Date("2026-10-09T18:00:00Z"), new Date("2026-10-08T18:00:00Z")) };
    const scene = viewById("precip").scene(inp);
    expect(scene.colorbar).toMatchObject({ kind: "diverging", limit: 12 }); // snow:total in site.json
    // The older run has 0.05 in more liquid everywhere: 0.5 in less snow at 10:1
    expect(scene.readout(PEAK).find((r) => r.label === "Δ")!.value).toBe("−0.5 in");
    expect(scene.caption).toMatch(/^Δ total snowfall \(in, 10:1\)/);
    // A 6-h snow trend and a 6-h precipitation trend read their own limits
    expect(viewById("precip").scene(inputs("precip", "trend", "snow")).colorbar).toMatchObject({ limit: 4 });
    expect(viewById("precip").scene(inputs("precip", "trend", "all")).colorbar).toMatchObject({ limit: 0.5 });
  });

  it("keeps a total's deltas apart from the 6-h ones in the memo", () => {
    const inp = inputs("precip", "trend", "snow");
    const six = viewById("precip").scene(inp).readout(PEAK).find((r) => r.label === "Δ")!.value;
    const total = viewById("precip").scene({ ...inp, cur: { snow: { sf: inp.cur.snow!.sf.map((v) => v * 3) } }, acc: day() })
      .readout(PEAK).find((r) => r.label === "Δ")!.value;
    expect(six).not.toBe(total);
  });

  it("titles name the period, the ratio and the hours", () => {
    const t = { init: "Mon 18Z", older: "Sun 18Z", valid: "Tue 18Z", fhr: "F024", model: "GFS", units: DEFAULT_UNITS };
    const v = viewById("precip");
    expect(v.title("fcst", "all", t)).toBe("GFS 6-h precipitation & type | init Mon 18Z | 6 h ending Tue 18Z | F024");
    expect(v.title("fcst", "snow", t)).toBe("GFS 6-h snowfall (10:1) | init Mon 18Z | 6 h ending Tue 18Z | F024");
    expect(v.title("fcst", "snow", { ...t, acc: { period: "24h", hours: 18, from: "Tue 00Z" } })).toBe(
      "GFS 18-h snowfall (10:1) | init Mon 18Z | 18 h ending Tue 18Z | F024");
    expect(v.title("fcst", "all", { ...t, acc: { period: "total", hours: 24, from: "Mon 18Z" } })).toBe(
      "GFS total precipitation | init Mon 18Z | Mon 18Z to Tue 18Z | F024");
    expect(v.title("trend", "snow", { ...t, acc: { period: "total", hours: 24, from: "Mon 18Z" } })).toBe(
      "GFS total snowfall (10:1) trend: init Mon 18Z vs Sun 18Z | Mon 18Z to Tue 18Z | F024");
  });

  it("loads snowfall for Snow, and only models with snowfall can show it", () => {
    const v = viewById("precip");
    expect(v.fields("fcst", "snow", new Set(["isobars"]))).toEqual({ primary: "snow", current: ["snow", "mslp"], older: [] });
    expect(v.fields("trend", "snow", new Set())).toEqual({ primary: "snow", current: ["snow"], older: ["snow"] });
    expect(requiredFields("precip", "snow")).toEqual(["snow"]);
    expect(requiredFields("precip", "all")).toEqual([]);
    expect(requiredFields("h500", "vort")).toEqual(["hgt500"]); // 500 mb's shading still follows the model
    expect(missingNoun("precip", "snow")).toEqual({ noun: "snowfall", short: "snowfall" });
    expect(missingNoun("wind10", "gust")).toEqual({ noun: "gusts", short: "gust" });
    expect(v.sums).toEqual({ precip: ["qpf"], snow: ["sf"] });
  });

  it("every model with snowfall says how it's made, and no other does", () => {
    for (const p of config.products) expect(!!p.snowfall, p.id).toBe(p.fields.includes("snow"));
    expect(config.products.filter((p) => p.fields.includes("snow")).map((p) => p.id).sort())
      .toEqual(["aifs", "ecmwf", "ecmwf-ens", "gdps", "gefs", "gfs", "icon"]);
  });

  it("explains a total's window and the ratio", () => {
    const v = viewById("precip");
    expect(v.explain("fcst", "snow", DEFAULT_UNITS, "24h")).toMatch(/10:1 snow-to-liquid/);
    expect(v.explain("fcst", "all", DEFAULT_UNITS, "total")).toMatch(/Types can't be added up/);
    expect(v.explain("fcst", "all", DEFAULT_UNITS, "6h")).toMatch(/dominant type/);
    expect(v.explain("trend", "snow", DEFAULT_UNITS, "total")).toMatch(/over the same hours/);
  });
});
