import { contourLines, smoothForContours } from "../contours";
import { fmtSigned } from "../colorbar";
import { buildLut, DEWPT_F, redBlue, stopsColor, TEMP_F } from "../palettes";
import { otherTemp, tempQ, ticksIn, type Units } from "../units";
import type { Layer, Scene, ViewDef, ViewInputs } from "./types";
import { band, extreme, OLDER_STYLE, scaleNote, signClass, statRow, trend } from "./util";

const tempColor = stopsColor(TEMP_F);
const dewColor = stopsColor(DEWPT_F);
/** A stored °F value in the viewer's unit, then the other: "41°F (5°C)". */
const both = (u: Units) => {
  const a = tempQ(u, "F"), b = tempQ(otherTemp(u), "F");
  return (f: number | null | undefined) =>
    f === null || f === undefined || Number.isNaN(f) ? "—" : `${a.from(f).toFixed(0)}${a.unit} (${b.from(f).toFixed(0)}${b.unit})`;
};
const range = (a: number, b: number, s: number) => Array.from({ length: Math.floor((b - a) / s) + 1 }, (_, i) => a + i * s);

const FREEZE = { value: 32, color: "#1d4ed8", width: 2.2 };

export const temp: ViewDef = {
  id: "t2m",
  tab: "Temperature",
  tabSub: "2 m",
  trendQ: (u) => tempQ(u, "F"),
  modes: ["fcst", "trend"],
  defaultMode: "fcst",
  variables: [
    { id: "temp", label: "Temperature", field: "t2m" },
    { id: "dewpt", label: "Dew point", field: "d2m" },
  ],
  overlays: [
    { id: "freeze", label: "Freezing line (32 °F, 0 °C)", default: true },
    { id: "isotherms", label: "Isotherms (every 10 °F or 5 °C)", default: false },
    { id: "older", label: "Older run's freezing line (dashed)", default: false, modes: ["trend"] },
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
      : `${t.model} 2 m ${name} (${tempQ(t.units, "F").unit}) | init ${t.init} | valid ${t.valid} | ${t.fhr}`;
  },

  explain(mode, variable, units) {
    const name = variable === "dewpt" ? "dew point" : "temperature";
    const freeze = units.temp === "C" ? "0 °C" : "32 °F";
    return mode === "trend"
      ? `<p><strong>Shading:</strong> the current run's 2 m ${name} minus the older run's, both valid at the same time.</p>
         <p class="legend-row"><span class="sw red"></span> current run warmer <span class="sw blue"></span> colder</p>
         <p><strong>Blue line:</strong> the current run's ${freeze} (freezing) line.</p>`
      : `<p><strong>Shading:</strong> 2 m ${name} (${tempQ(units, "F").unit}).</p>
         <p><strong>Blue line:</strong> ${freeze}, where 2 m temperature crosses freezing.</p>`;
  },

  scene(inp: ViewInputs): Scene {
    const { grid } = inp;
    const q = tempQ(inp.units, "F");
    const deg = (f: number) => `${q.from(f).toFixed(0)}${q.unit}`;
    const withOther = both(inp.units);
    const frz = inp.units.temp === "C" ? "0°" : "32°";
    const isDew = inp.variable === "dewpt";
    const field = isDew ? "d2m" : "t2m", name = isDew ? "dewpt" : "temp";
    const values = band(inp.cur, field, name)!;
    const t2m = band(inp.cur, "t2m", "temp");
    const d2m = band(inp.cur, "d2m", "dewpt");
    const run = inp.pair.currentRun, f = inp.pair.currentFhr;
    const layers: Layer[] = [];

    if (inp.overlays.has("isotherms")) {
      // Every 10 °F, or every 5 °C
      const levels = inp.units.temp === "C" ? range(-40, 50, 5).map(q.to) : range(-40, 120, 10);
      const lines = inp.memo(`iso/${inp.units.temp}/${field}/${run}/${f}`, () =>
        contourLines(smoothForContours(values, grid.nx, grid.ny), grid, levels));
      layers.push({ kind: "contours", lines, style: { color: "rgba(20,20,20,0.65)", width: 1, label: (v) => `${Math.round(q.from(v))}`, labelColor: "#222", labelSpacing: 380 } });
    }
    const oldT = band(inp.old, "t2m", "temp");
    if (inp.mode === "trend" && inp.overlays.has("older") && oldT) {
      const lines = inp.memo(`frz-old/${inp.pair.olderRun}/${inp.pair.olderFhr}`, () =>
        contourLines(smoothForContours(oldT, grid.nx, grid.ny), grid, [32]));
      layers.push({ kind: "contours", lines, style: { ...OLDER_STYLE, label: () => frz } });
    }
    if (inp.overlays.has("freeze") && t2m) {
      const lines = inp.memo(`frz/${run}/${f}`, () => contourLines(smoothForContours(t2m, grid.nx, grid.ny), grid, [32]));
      layers.push({ kind: "contours", lines, style: { color: FREEZE.color, width: FREEZE.width, label: () => `${frz}${q.unit.slice(1)}`, emphasize: FREEZE, labelSpacing: 420 } });
    }

    const hi = extreme(values, inp, 1), lo = extreme(values, inp, -1);
    const label = isDew ? "dew point" : "temperature";
    if (inp.mode === "fcst") {
      const color = isDew ? dewColor : tempColor;
      const [min, max] = isDew ? [-20, 80] : [-40, 120];
      const ticks = ticksIn(q, min, max, 10);
      return {
        raster: { kind: "scalar", values, lut: buildLut(color, min, max) },
        layers,
        colorbar: { kind: "continuous", color, min, max, ticks: ticks.ticks, extend: "both", format: (v) => `${ticks.format(v)}°` },
        caption: `2 m ${label} (${q.unit})`,
        stats: [statRow("Highest", deg(hi.v), hi), statRow("Lowest", deg(lo.v), lo)],
        readout: (k) => [
          { label: "Temperature", value: withOther(t2m?.[k]) },
          { label: "Dew point", value: withOther(d2m?.[k]) },
        ],
      };
    }

    const t = trend(inp, field, name, "t2m", redBlue, q);
    const old = band(inp.old, field, name);
    const stats = [];
    const dDeg = (v: number) => `${fmtSigned(v * q.scale)}${q.unit}`;
    if (t.d) {
      const up = extreme(t.d, inp, 1), down = extreme(t.d, inp, -1);
      stats.push(statRow("Most warming", dDeg(up.v), up, "pos"));
      stats.push(statRow("Most cooling", dDeg(down.v), down, "neg"));
    }
    return {
      raster: t.raster,
      layers,
      colorbar: t.colorbar,
      caption: t.d
        ? `Δ 2 m ${label} (${q.unit}) · ${inp.sides.minus} · ${scaleNote(inp.limitMode, t.shown, q.unit)}`
        : `Δ 2 m ${label} (${q.unit}) · no comparison for this frame`,
      stats,
      readout: (k) => [
        { label: `${inp.sides.cur} ${isDew ? "Td" : "T"}`, value: withOther(values[k]) },
        { label: `${inp.sides.old} ${isDew ? "Td" : "T"}`, value: old && !Number.isNaN(old[k]) ? deg(old[k]) : "—" },
        { label: "Δ", value: t.d ? dDeg(t.d[k]) : "n/a", cls: t.d ? signClass(t.d[k]) : "" },
      ],
    };
  },
};
