import { contourLines, smoothForContours } from "../contours";
import { fmtSigned } from "../colorbar";
import { buildLut, redBlue, stopsColor, T850_C } from "../palettes";
import { otherTemp, tempQ, ticksIn } from "../units";
import type { Layer, Scene, ViewDef, ViewInputs } from "./types";
import { band, extreme, fmtNum, OLDER_STYLE, scaleNote, signClass, statRow, trend } from "./util";

const tColor = stopsColor(T850_C);
const range = (a: number, b: number, s: number) => Array.from({ length: Math.floor((b - a) / s) + 1 }, (_, i) => a + i * s);

const ZERO = { value: 0, color: "#1d4ed8", width: 2.2 };

export const t850: ViewDef = {
  id: "t850",
  tab: "850 mb",
  tabSub: "temperature",
  trendQ: (u) => tempQ(u, "C"),
  modes: ["fcst", "trend"],
  defaultMode: "fcst",
  overlays: [
    { id: "zero", label: "Freezing line (0 °C, 32 °F)", default: true },
    { id: "isotherms", label: "Isotherms (every 5 °C or 10 °F)", default: false },
    { id: "older", label: "Older run's freezing line (dashed)", default: false, modes: ["trend"] },
  ],

  fields(mode) {
    return { primary: "t850", current: ["t850"], older: mode === "trend" ? ["t850"] : [] };
  },

  title(mode, _v, t) {
    return mode === "trend"
      ? `${t.model} 850 mb temperature trend: init ${t.init} vs ${t.older} | valid ${t.valid} | ${t.fhr}`
      : `${t.model} 850 mb temperature (${tempQ(t.units, "C").unit}) | init ${t.init} | valid ${t.valid} | ${t.fhr}`;
  },

  explain(mode, _v, units) {
    const zero = units.temp === "C" ? "0 °C" : "32 °F (0 °C)";
    return (mode === "trend"
      ? `<p><strong>Shading:</strong> the current run's 850 mb temperature minus the older run's, both valid at the same time.</p>
         <p class="legend-row"><span class="sw red"></span> current run warmer <span class="sw blue"></span> colder</p>`
      : `<p><strong>Shading:</strong> temperature at 850 mb, about 1.5 km up (${tempQ(units, "C").unit}), above the daily swings near the ground. It shows warm and cold air masses and fronts.</p>`) +
      `<p><strong>Blue line:</strong> ${zero} at 850 mb, a common rough guide to the rain–snow line.</p>`;
  },

  scene(inp: ViewInputs): Scene {
    const { grid } = inp;
    const q = tempQ(inp.units, "C"), other = tempQ(otherTemp(inp.units), "C");
    const digits = q.unit === "°C" ? 1 : 0;
    const deg = (c: number) => `${q.from(c).toFixed(digits)}${q.unit}`;
    const withOther = (c: number | null | undefined) =>
      c === null || c === undefined || Number.isNaN(c) ? "—" : `${deg(c)} (${other.from(c).toFixed(1 - digits)}${other.unit})`;
    const zero = q.unit === "°C" ? "0°" : "32°";
    const t = band(inp.cur, "t850", "temp")!;
    const run = inp.pair.currentRun, f = inp.pair.currentFhr;
    const layers: Layer[] = [];
    if (inp.overlays.has("isotherms")) {
      // Every 5 °C, or every 10 °F
      const levels = q.unit === "°C" ? range(-40, 35, 5) : range(-40, 90, 10).map(q.to);
      const lines = inp.memo(`iso/${inp.units.temp}/${run}/${f}`, () => contourLines(smoothForContours(t, grid.nx, grid.ny), grid, levels));
      layers.push({ kind: "contours", lines, style: { color: "rgba(20,20,20,0.6)", width: 0.8, label: (v) => `${Math.round(q.from(v))}`, labelColor: "#222", labelSpacing: 380 } });
    }
    const old = band(inp.old, "t850", "temp");
    if (inp.mode === "trend" && inp.overlays.has("older") && old) {
      const lines = inp.memo(`zero-old/${inp.pair.olderRun}/${inp.pair.olderFhr}`, () =>
        contourLines(smoothForContours(old, grid.nx, grid.ny), grid, [0]));
      layers.push({ kind: "contours", lines, style: { ...OLDER_STYLE, label: () => zero } });
    }
    if (inp.overlays.has("zero")) {
      const lines = inp.memo(`zero/${run}/${f}`, () => contourLines(smoothForContours(t, grid.nx, grid.ny), grid, [0]));
      layers.push({ kind: "contours", lines, style: { color: ZERO.color, width: ZERO.width, label: () => `${zero}${q.unit.slice(1)}`, emphasize: ZERO, labelSpacing: 420 } });
    }

    if (inp.mode === "fcst") {
      const hi = extreme(t, inp, 1), lo = extreme(t, inp, -1);
      const ticks = ticksIn(q, -40, 35, q.unit === "°C" ? 5 : 10);
      return {
        raster: { kind: "scalar", values: t, lut: buildLut(tColor, -40, 35) },
        layers,
        colorbar: { kind: "continuous", color: tColor, min: -40, max: 35, ticks: ticks.ticks, extend: "both", format: (v) => `${ticks.format(v)}°` },
        caption: `850 mb temperature (${q.unit})`,
        stats: [statRow("Warmest", deg(hi.v), hi), statRow("Coldest", deg(lo.v), lo)],
        readout: (k) => [
          { label: "850 mb temp", value: Number.isNaN(t[k]) ? "—" : deg(t[k]) },
          { label: `In ${other.unit}`, value: fmtNum(other.from(t[k]), 1 - digits, other.unit) },
        ],
      };
    }

    const tr = trend(inp, "t850", "temp", "t850", redBlue, q);
    const stats = [];
    const dDeg = (v: number) => `${fmtSigned(v * q.scale, digits)}${q.unit}`;
    if (tr.d) {
      const up = extreme(tr.d, inp, 1), down = extreme(tr.d, inp, -1);
      stats.push(statRow("Most warming", dDeg(up.v), up, "pos"));
      stats.push(statRow("Most cooling", dDeg(down.v), down, "neg"));
    }
    return {
      raster: tr.raster,
      layers,
      colorbar: tr.colorbar,
      caption: tr.d
        ? `Δ 850 mb temperature (${q.unit}) · ${inp.sides.minus} · ${scaleNote(inp.limitMode, tr.shown, q.unit)}`
        : `Δ 850 mb temperature (${q.unit}) · no comparison for this frame`,
      stats,
      readout: (k) => [
        { label: `${inp.sides.cur} T`, value: withOther(t[k]) },
        { label: `${inp.sides.old} T`, value: old && !Number.isNaN(old[k]) ? deg(old[k]) : "—" },
        { label: "Δ", value: tr.d ? dDeg(tr.d[k]) : "n/a", cls: tr.d ? signClass(tr.d[k]) : "" },
      ],
    };
  },
};
