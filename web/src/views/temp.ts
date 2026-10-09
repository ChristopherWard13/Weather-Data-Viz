import { contourLines, smoothForContours } from "../contours";
import { fmtSigned } from "../colorbar";
import { buildLut, DEWPT_F, redBlue, stopsColor, TEMP_F } from "../palettes";
import { fmtTime } from "../time";
import type { Layer, Scene, ViewDef, ViewInputs } from "./types";
import { band, extreme, fmtNum, OLDER_STYLE, scaleNote, signClass, statRow, trend } from "./util";

const tempColor = stopsColor(TEMP_F);
const dewColor = stopsColor(DEWPT_F);
const cOf = (f: number) => ((f - 32) * 5) / 9;
const withC = (f: number | null | undefined) => (f === null || f === undefined ? "—" : `${f.toFixed(0)}°F (${cOf(f).toFixed(0)}°C)`);
const range = (a: number, b: number, s: number) => Array.from({ length: Math.floor((b - a) / s) + 1 }, (_, i) => a + i * s);

const FREEZE = { value: 32, color: "#1d4ed8", width: 2.2 };

export const temp: ViewDef = {
  id: "t2m",
  tab: "Temperature",
  tabSub: "2 m",
  trendUnit: "°F",
  modes: ["fcst", "trend"],
  defaultMode: "fcst",
  variables: [
    { id: "temp", label: "Temperature" },
    { id: "dewpt", label: "Dew point" },
  ],
  overlays: [
    { id: "freeze", label: "32 °F line", default: true },
    { id: "isotherms", label: "Contours every 10 °F", default: false },
    { id: "older", label: "Older run's 32 °F line (dashed)", default: false, modes: ["trend"] },
  ],

  fields(mode, variable, ov) {
    const primary = variable === "dewpt" ? "d2m" : "t2m";
    const older = mode === "trend" ? [primary] : [];
    if (mode === "trend" && ov.has("older") && !older.includes("t2m")) older.push("t2m");
    return { primary, current: ["t2m", "d2m"], older };
  },

  title(mode, variable, t) {
    const name = variable === "dewpt" ? "dew point" : "temperature";
    return mode === "trend"
      ? `${t.model} 2 m ${name} trend: init ${t.init} vs ${t.older} | valid ${t.valid} | ${t.fhr}`
      : `${t.model} 2 m ${name} (°F) | init ${t.init} | valid ${t.valid} | ${t.fhr}`;
  },

  explain(mode, variable) {
    const name = variable === "dewpt" ? "dew point" : "temperature";
    return mode === "trend"
      ? `<p><strong>Shading:</strong> the current run's 2 m ${name} minus the older run's, both valid at the same time.</p>
         <p class="legend-row"><span class="sw red"></span> current run warmer <span class="sw blue"></span> colder</p>
         <p><strong>Blue line:</strong> the current run's 32 °F (freezing) line.</p>`
      : `<p><strong>Shading:</strong> 2 m ${name} (°F).</p>
         <p><strong>Blue line:</strong> 32 °F, where 2 m temperature crosses freezing.</p>`;
  },

  scene(inp: ViewInputs): Scene {
    const { grid } = inp;
    const isDew = inp.variable === "dewpt";
    const field = isDew ? "d2m" : "t2m", name = isDew ? "dewpt" : "temp";
    const values = band(inp.cur, field, name)!;
    const t2m = band(inp.cur, "t2m", "temp");
    const d2m = band(inp.cur, "d2m", "dewpt");
    const run = inp.pair.currentRun, f = inp.pair.currentFhr;
    const layers: Layer[] = [];

    if (inp.overlays.has("isotherms")) {
      const lines = inp.memo(`iso10/${field}/${run}/${f}`, () =>
        contourLines(smoothForContours(values, grid.nx, grid.ny), grid, range(-40, 120, 10)));
      layers.push({ kind: "contours", lines, style: { color: "rgba(20,20,20,0.6)", width: 0.8, label: (v) => `${v}`, labelColor: "#222", labelSpacing: 380 } });
    }
    const oldT = band(inp.old, "t2m", "temp");
    if (inp.mode === "trend" && inp.overlays.has("older") && oldT) {
      const lines = inp.memo(`frz-old/${inp.pair.olderRun}/${inp.pair.olderFhr}`, () =>
        contourLines(smoothForContours(oldT, grid.nx, grid.ny), grid, [32]));
      layers.push({ kind: "contours", lines, style: { ...OLDER_STYLE, label: () => "32°" } });
    }
    if (inp.overlays.has("freeze") && t2m) {
      const lines = inp.memo(`frz/${run}/${f}`, () => contourLines(smoothForContours(t2m, grid.nx, grid.ny), grid, [32]));
      layers.push({ kind: "contours", lines, style: { color: FREEZE.color, width: FREEZE.width, label: () => "32°F", emphasize: FREEZE, labelSpacing: 420 } });
    }

    const hi = extreme(values, grid, 1), lo = extreme(values, grid, -1);
    const label = isDew ? "dew point" : "temperature";
    if (inp.mode === "fcst") {
      const color = isDew ? dewColor : tempColor;
      const [min, max] = isDew ? [-20, 80] : [-40, 120];
      return {
        raster: { kind: "scalar", values, lut: buildLut(color, min, max) },
        layers,
        colorbar: { kind: "continuous", color, min, max, ticks: range(min, max, 10), extend: "both", format: (v) => `${v}°` },
        caption: `2 m ${label} (°F)`,
        stats: [statRow("Highest", `${hi.v.toFixed(0)}°F`, hi), statRow("Lowest", `${lo.v.toFixed(0)}°F`, lo)],
        readout: (k) => [
          { label: "Temperature", value: withC(t2m?.[k]) },
          { label: "Dew point", value: withC(d2m?.[k]) },
        ],
      };
    }

    const t = trend(inp, field, name, "t2m", redBlue);
    const old = band(inp.old, field, name);
    const stats = [];
    if (t.d) {
      const up = extreme(t.d, grid, 1), down = extreme(t.d, grid, -1);
      stats.push(statRow("Most warming", `${fmtSigned(up.v)}°F`, up, "pos"));
      stats.push(statRow("Most cooling", `${fmtSigned(down.v)}°F`, down, "neg"));
    }
    return {
      raster: t.raster,
      layers,
      colorbar: t.colorbar,
      caption: t.d
        ? `Δ 2 m ${label} (°F) · ${fmtTime(inp.pair.currentInit)} minus ${fmtTime(inp.pair.olderInit)} · ${scaleNote(inp.limitMode, t.limit, "°F")}`
        : `Δ 2 m ${label} (°F) · no comparison for this frame`,
      stats,
      readout: (k) => [
        { label: `Current ${isDew ? "Td" : "T"}`, value: withC(values[k]) },
        { label: `Older ${isDew ? "Td" : "T"}`, value: fmtNum(old?.[k], 0, "°F") },
        { label: "Δ", value: t.d ? `${fmtSigned(t.d[k])}°F` : "n/a", cls: t.d ? signClass(t.d[k]) : "" },
      ],
    };
  },
};
