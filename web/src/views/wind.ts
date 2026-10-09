import { fmtSigned } from "../colorbar";
import { buildLut, redBlue, stopsColor, WIND_KT } from "../palettes";
import { fmtTime } from "../time";
import { pressureLayers } from "./surface";
import type { Layer, Scene, ViewDef, ViewInputs } from "./types";
import { band, compass, extreme, fmtNum, scaleNote, signClass, statRow, trend } from "./util";

const windColor = stopsColor(WIND_KT);

export const wind: ViewDef = {
  id: "wind10",
  tab: "Wind",
  tabSub: "10 m",
  trendUnit: "kt",
  modes: ["fcst", "trend"],
  defaultMode: "fcst",
  variables: [
    { id: "speed", label: "Sustained" },
    { id: "gust", label: "Gusts" },
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
      ? `${t.model} 10 m ${name} trend: init ${t.init} vs ${t.older} | valid ${t.valid} | ${t.fhr}`
      : `${t.model} 10 m ${name} (kt) | init ${t.init} | valid ${t.valid} | ${t.fhr}`;
  },

  explain(mode, variable) {
    const what = variable === "gust" ? "surface wind gust" : "10 m sustained wind speed";
    return (mode === "trend"
      ? `<p><strong>Shading:</strong> the current run's ${what} minus the older run's, both valid at the same time.</p>
         <p class="legend-row"><span class="sw red"></span> current run windier <span class="sw blue"></span> calmer</p>`
      : `<p><strong>Shading:</strong> ${what} (kt).</p>`) +
      `<p><strong>Barbs:</strong> 10 m wind; each full barb is 10 kt, a pennant 50 kt.</p>
       <p><strong>Contours:</strong> sea-level isobars every 4 hPa, with high and low centers.</p>
       <p class="note">GFS reports surface wind at 10 m, the standard height; there is no 2 m wind.</p>`;
  },

  scene(inp: ViewInputs): Scene {
    const { grid } = inp;
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
      { label: "Wind", value: speed ? `${dir ? `${compass(dir[k])} ` : ""}${speed[k].toFixed(0)} kt` : "—" },
      { label: "Gust", value: fmtNum(gust?.[k], 0, " kt") },
      { label: "Pressure", value: fmtNum(mslp?.[k], 1, " hPa") },
    ];
    const vmax = extreme(values, grid, 1);
    const label = isGust ? "Max gust" : "Max wind";

    if (inp.mode === "fcst") {
      return {
        raster: { kind: "scalar", values, lut: buildLut(windColor, 0, 80) },
        layers,
        colorbar: { kind: "continuous", color: windColor, min: 0, max: 80, ticks: [0, 10, 20, 30, 40, 50, 60, 70, 80], extend: "max" },
        caption: isGust ? "Surface wind gust (kt)" : "10 m sustained wind (kt)",
        stats: [statRow(label, `${vmax.v.toFixed(0)} kt`, vmax)],
        readout: windRows,
      };
    }
    const t = trend(inp, field, name, "wind10", redBlue);
    const old = band(inp.old, field, name);
    const stats = [];
    if (t.d) {
      const up = extreme(t.d, grid, 1), down = extreme(t.d, grid, -1);
      stats.push(statRow("Largest increase", `${fmtSigned(up.v)} kt`, up, "pos"));
      stats.push(statRow("Largest decrease", `${fmtSigned(down.v)} kt`, down, "neg"));
    }
    return {
      raster: t.raster,
      layers,
      colorbar: t.colorbar,
      caption: t.d
        ? `Δ ${isGust ? "gust" : "10 m wind"} (kt) · ${fmtTime(inp.pair.currentInit)} minus ${fmtTime(inp.pair.olderInit)} · ${scaleNote(inp.limitMode, t.limit, "kt")}`
        : `Δ ${isGust ? "gust" : "10 m wind"} (kt) · no comparison for this frame`,
      stats,
      readout: (k) => [
        { label: `Current ${isGust ? "gust" : "wind"}`, value: `${values[k].toFixed(0)} kt` },
        { label: `Older ${isGust ? "gust" : "wind"}`, value: fmtNum(old?.[k], 0, " kt") },
        { label: "Δ", value: t.d ? `${fmtSigned(t.d[k])} kt` : "n/a", cls: t.d ? signClass(t.d[k]) : "" },
      ],
    };
  },
};
