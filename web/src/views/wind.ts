import { fmtSigned } from "../colorbar";
import { buildLut, redBlue, stopsColor, WIND_KT } from "../palettes";
import { speedQ, ticksIn } from "../units";
import { pressureLayers } from "./surface";
import type { Layer, Scene, ViewDef, ViewInputs } from "./types";
import { band, compass, extreme, fmtNum, scaleNote, signClass, statRow, trend } from "./util";

const windColor = stopsColor(WIND_KT);

export const wind: ViewDef = {
  id: "wind10",
  tab: "Wind",
  tabSub: "10 m",
  trendQ: speedQ,
  modes: ["fcst", "trend"],
  defaultMode: "fcst",
  variables: [
    { id: "speed", label: "Sustained", field: "wspd10", noun: "sustained wind" },
    { id: "gust", label: "Gusts", field: "gust" },
  ],
  overlays: [
    { id: "barbs", label: "Wind barbs", default: true },
    { id: "isobars", label: "Isobars (4 hPa)", default: true },
    { id: "centers", label: "High / low centers", default: true },
  ],

  fields(mode, variable, ov) {
    const primary = variable === "gust" ? "gust" : "wspd10";
    const current = ["wspd10", "gust"];
    if (ov.has("barbs")) current.push("wdir10");
    if (ov.has("isobars") || ov.has("centers")) current.push("mslp");
    return { primary, current, older: mode === "trend" ? [primary] : [] };
  },

  title(mode, variable, t) {
    const name = variable === "gust" ? "wind gust" : "wind";
    return mode === "trend"
      ? `${t.model} 10 m ${name} trend`
      : `${t.model} 10 m ${name} (${speedQ(t.units).unit})`;
  },

  explain(mode, variable, units) {
    const what = variable === "gust" ? "surface wind gust" : "10 m sustained wind speed";
    return (mode === "trend"
      ? `<p><strong>Shading:</strong> the current run's ${what} minus the older run's, both valid at the same time.</p>
         <p class="legend-row"><span class="sw red"></span> current run windier <span class="sw blue"></span> calmer</p>`
      : `<p><strong>Shading:</strong> ${what} (${speedQ(units).unit}).</p>`) +
      `<p><strong>Barbs:</strong> 10 m wind; each full barb is 10 kt, a pennant 50 kt (barbs are always in knots).</p>
       <p><strong>Contours:</strong> sea-level isobars every 4 hPa, with high and low centers.</p>
       <p class="note">Surface wind is at 10 m, the standard height. Gusts are each model's own: GFS's and GEM's are instantaneous; ECMWF's is the maximum since its previous output (the last hour to F090, 3 hours to F144, then 6 hours); ICON's is the maximum in the last hour. AIFS has no gust output.</p>`;
  },

  scene(inp: ViewInputs): Scene {
    const q = speedQ(inp.units);
    const spd = (v: number | null | undefined) => fmtNum(v === null || v === undefined ? v : q.from(v), 0, ` ${q.unit}`);
    const isGust = inp.variable === "gust";
    const field = isGust ? "gust" : "wspd10", name = isGust ? "gust" : "speed";
    const values = band(inp.cur, field, name)!;
    const speed = band(inp.cur, "wspd10", "speed");
    const gust = band(inp.cur, "gust", "gust");
    const dir = band(inp.cur, "wdir10", "dir");
    const mslp = band(inp.cur, "mslp", "mslp");
    const layers: Layer[] = pressureLayers(inp, inp.overlays.has("isobars"), inp.overlays.has("centers"));
    if (inp.overlays.has("barbs") && speed && dir) {
      layers.unshift({ kind: "barbs", field: { speed, dir }, spacing: 34, color: "rgba(17,24,39,0.82)" });
    }
    const windRows = (k: number) => [
      { label: "Wind", value: speed ? `${dir ? `${compass(dir[k])} ` : ""}${spd(speed[k])}` : "—" },
      { label: "Gust", value: spd(gust?.[k]) },
      { label: "Pressure", value: fmtNum(mslp?.[k], 1, " hPa") },
    ];
    const vmax = extreme(values, inp, 1);
    const label = isGust ? "Max gust" : "Max wind";
    const what = isGust ? "Surface wind gust" : "10 m sustained wind";

    if (inp.mode === "fcst") {
      return {
        raster: { kind: "scalar", values, lut: buildLut(windColor, 0, 80) },
        layers,
        colorbar: { kind: "continuous", color: windColor, min: 0, max: 80, ...ticksIn(q, 0, 80, 10), extend: "max" },
        caption: `${what} (${q.unit})`,
        stats: [statRow(label, spd(vmax.v), vmax)],
        readout: windRows,
      };
    }
    const t = trend(inp, field, name, "wind10", redBlue, q);
    const old = band(inp.old, field, name);
    const stats = [];
    const dSpd = (v: number) => `${fmtSigned(v * q.scale)} ${q.unit}`;
    if (t.d) {
      const up = extreme(t.d, inp, 1), down = extreme(t.d, inp, -1);
      stats.push(statRow("Largest increase", dSpd(up.v), up, "pos"));
      stats.push(statRow("Largest decrease", dSpd(down.v), down, "neg"));
    }
    const short = isGust ? "gust" : "10 m wind";
    return {
      raster: t.raster,
      layers,
      colorbar: t.colorbar,
      caption: t.d
        ? `Δ ${short} (${q.unit}) · ${inp.sides.minus} · ${scaleNote(inp.limitMode, t.shown, q.unit)}`
        : `Δ ${short} (${q.unit}) · no comparison for this frame`,
      stats,
      readout: (k) => [
        { label: `${inp.sides.cur} ${isGust ? "gust" : "wind"}`, value: spd(values[k]) },
        { label: `${inp.sides.old} ${isGust ? "gust" : "wind"}`, value: spd(old?.[k]) },
        { label: "Δ", value: t.d ? dSpd(t.d[k]) : "n/a", cls: t.d ? signClass(t.d[k]) : "" },
      ],
    };
  },
};
