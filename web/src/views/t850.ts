import { contourLines, smoothForContours } from "../contours";
import { fmtSigned } from "../colorbar";
import { buildLut, redBlue, stopsColor, T850_C } from "../palettes";
import { fmtTime } from "../time";
import type { Layer, Scene, ViewDef, ViewInputs } from "./types";
import { band, extreme, fmtNum, OLDER_STYLE, scaleNote, signClass, statRow, trend } from "./util";

const tColor = stopsColor(T850_C);
const range = (a: number, b: number, s: number) => Array.from({ length: Math.floor((b - a) / s) + 1 }, (_, i) => a + i * s);
const withF = (c: number | null | undefined) =>
  c === null || c === undefined || Number.isNaN(c) ? "—" : `${c.toFixed(1)}°C (${((c * 9) / 5 + 32).toFixed(0)}°F)`;

const ZERO = { value: 0, color: "#1d4ed8", width: 2.2 };

export const t850: ViewDef = {
  id: "t850",
  tab: "850 mb",
  tabSub: "temperature",
  trendUnit: "°C",
  modes: ["fcst", "trend"],
  defaultMode: "fcst",
  overlays: [
    { id: "zero", label: "0 °C line", default: true },
    { id: "isotherms", label: "Contours every 5 °C", default: false },
    { id: "older", label: "Older run's 0 °C line (dashed)", default: false, modes: ["trend"] },
  ],

  fields(mode) {
    return { primary: "t850", current: ["t850"], older: mode === "trend" ? ["t850"] : [] };
  },

  title(mode, _v, t) {
    return mode === "trend"
      ? `${t.model} 850 mb temperature trend: init ${t.init} vs ${t.older} | valid ${t.valid} | ${t.fhr}`
      : `${t.model} 850 mb temperature (°C) | init ${t.init} | valid ${t.valid} | ${t.fhr}`;
  },

  explain(mode) {
    return (mode === "trend"
      ? `<p><strong>Shading:</strong> the current run's 850 mb temperature minus the older run's, both valid at the same time.</p>
         <p class="legend-row"><span class="sw red"></span> current run warmer <span class="sw blue"></span> colder</p>`
      : `<p><strong>Shading:</strong> temperature at 850 mb, about 1.5 km up (°C), above the daily swings near the ground. It shows warm and cold air masses and fronts.</p>`) +
      `<p><strong>Blue line:</strong> 0 °C at 850 mb, a common rough guide to the rain–snow line.</p>`;
  },

  scene(inp: ViewInputs): Scene {
    const { grid } = inp;
    const t = band(inp.cur, "t850", "temp")!;
    const run = inp.pair.currentRun, f = inp.pair.currentFhr;
    const layers: Layer[] = [];
    if (inp.overlays.has("isotherms")) {
      const lines = inp.memo(`iso5/${run}/${f}`, () => contourLines(smoothForContours(t, grid.nx, grid.ny), grid, range(-40, 35, 5)));
      layers.push({ kind: "contours", lines, style: { color: "rgba(20,20,20,0.6)", width: 0.8, label: (v) => `${v}`, labelColor: "#222", labelSpacing: 380 } });
    }
    const old = band(inp.old, "t850", "temp");
    if (inp.mode === "trend" && inp.overlays.has("older") && old) {
      const lines = inp.memo(`zero-old/${inp.pair.olderRun}/${inp.pair.olderFhr}`, () =>
        contourLines(smoothForContours(old, grid.nx, grid.ny), grid, [0]));
      layers.push({ kind: "contours", lines, style: { ...OLDER_STYLE, label: () => "0°" } });
    }
    if (inp.overlays.has("zero")) {
      const lines = inp.memo(`zero/${run}/${f}`, () => contourLines(smoothForContours(t, grid.nx, grid.ny), grid, [0]));
      layers.push({ kind: "contours", lines, style: { color: ZERO.color, width: ZERO.width, label: () => "0°C", emphasize: ZERO, labelSpacing: 420 } });
    }

    if (inp.mode === "fcst") {
      const hi = extreme(t, grid, 1), lo = extreme(t, grid, -1);
      return {
        raster: { kind: "scalar", values: t, lut: buildLut(tColor, -40, 35) },
        layers,
        colorbar: { kind: "continuous", color: tColor, min: -40, max: 35, ticks: range(-40, 35, 5), extend: "both", format: (v) => `${v}°` },
        caption: "850 mb temperature (°C)",
        stats: [statRow("Warmest", `${hi.v.toFixed(1)}°C`, hi), statRow("Coldest", `${lo.v.toFixed(1)}°C`, lo)],
        readout: (k) => [
          { label: "850 mb temp", value: fmtNum(t[k], 1, "°C") },
          { label: "In °F", value: fmtNum((t[k] * 9) / 5 + 32, 0, "°F") },
        ],
      };
    }

    const tr = trend(inp, "t850", "temp", "t850", redBlue);
    const stats = [];
    if (tr.d) {
      const up = extreme(tr.d, grid, 1), down = extreme(tr.d, grid, -1);
      stats.push(statRow("Most warming", `${fmtSigned(up.v, 1)}°C`, up, "pos"));
      stats.push(statRow("Most cooling", `${fmtSigned(down.v, 1)}°C`, down, "neg"));
    }
    return {
      raster: tr.raster,
      layers,
      colorbar: tr.colorbar,
      caption: tr.d
        ? `Δ 850 mb temperature (°C) · ${fmtTime(inp.pair.currentInit)} minus ${fmtTime(inp.pair.olderInit)} · ${scaleNote(inp.limitMode, tr.limit, "°C")}`
        : "Δ 850 mb temperature (°C) · no comparison for this frame",
      stats,
      readout: (k) => [
        { label: "Current T", value: withF(t[k]) },
        { label: "Older T", value: fmtNum(old?.[k], 1, "°C") },
        { label: "Δ", value: tr.d ? `${fmtSigned(tr.d[k], 1)}°C` : "n/a", cls: tr.d ? signClass(tr.d[k]) : "" },
      ],
    };
  },
};
