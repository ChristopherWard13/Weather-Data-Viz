import { contourLines, smoothForContours } from "../contours";
import { fmtSigned } from "../colorbar";
import { buildLut, redBlue, stopsColor, VORT_1E5 } from "../palettes";
import type { Layer, Scene, ViewDef, ViewInputs } from "./types";
import { band, extreme, fmtNum, OLDER_STYLE, scaleNote, signClass, statRow, trend } from "./util";

const vortColor = stopsColor(VORT_1E5);
const range = (a: number, b: number, s: number) => Array.from({ length: Math.floor((b - a) / s) + 1 }, (_, i) => a + i * s);

/** Heights every 6 dam (60 m), labelled in decametres as on standard 500 mb charts. */
const HEIGHTS = range(4680, 6000, 60);
const dam = (m: number) => String(Math.round(m / 10));
const HEIGHT_STYLE = { color: "rgba(17,24,39,0.9)", width: 1.1, label: dam, labelColor: "#111827", labelSpacing: 380 };

export const h500: ViewDef = {
  id: "h500",
  tab: "500 mb",
  tabSub: "height, vorticity",
  trendUnit: "m",
  modes: ["fcst", "trend"],
  defaultMode: "fcst",
  overlays: [
    { id: "heights", label: "Height contours (6 dam)", default: true },
    { id: "older", label: "Older run's heights (dashed)", default: false, modes: ["trend"] },
  ],

  fields(mode) {
    // Trend mode compares heights: run-to-run vorticity differences are mostly noise.
    if (mode === "trend") {
      return { primary: "hgt500", current: ["hgt500"], older: ["hgt500"] };
    }
    return { primary: "vort500", current: ["vort500", "hgt500"], older: [] };
  },

  title(mode, _v, t) {
    return mode === "trend"
      ? `${t.model} 500 mb height trend: init ${t.init} vs ${t.older} | valid ${t.valid} | ${t.fhr}`
      : `${t.model} 500 mb height & absolute vorticity | init ${t.init} | valid ${t.valid} | ${t.fhr}`;
  },

  explain(mode) {
    return mode === "trend"
      ? `<p><strong>Shading:</strong> the current run's 500 mb height minus the older run's (m), both valid at the same time. Falling heights mean a deeper trough or a weaker ridge.</p>
         <p class="legend-row"><span class="sw red"></span> current run higher <span class="sw blue"></span> lower</p>
         <p><strong>Contours:</strong> the current run's 500 mb heights every 6 dam (60 m), labelled in decametres.</p>`
      : `<p><strong>Shading:</strong> 500 mb absolute vorticity (10⁻⁵ s⁻¹): the spin of the air plus the Earth's. Maxima mark the shortwaves and troughs that drive storms.</p>
         <p><strong>Contours:</strong> 500 mb heights every 6 dam (60 m), labelled in decametres.</p>
         <p class="note">Vorticity is computed the same way for every model, from its 500 mb winds on this map's 0.25° grid. The outermost grid points have no value.</p>`;
  },

  scene(inp: ViewInputs): Scene {
    const { grid } = inp;
    const hgt = band(inp.cur, "hgt500", "hgt");
    const run = inp.pair.currentRun, f = inp.pair.currentFhr;
    const layers: Layer[] = [];
    const oldH = band(inp.old, "hgt500", "hgt");
    if (inp.mode === "trend" && inp.overlays.has("older") && oldH) {
      const lines = inp.memo(`hgt-old/${inp.pair.olderRun}/${inp.pair.olderFhr}`, () =>
        contourLines(smoothForContours(oldH, grid.nx, grid.ny), grid, HEIGHTS));
      layers.push({ kind: "contours", lines, style: { ...OLDER_STYLE, label: dam } });
    }
    if (inp.overlays.has("heights") && hgt) {
      const lines = inp.memo(`hgt/${run}/${f}`, () => contourLines(smoothForContours(hgt, grid.nx, grid.ny), grid, HEIGHTS));
      layers.push({ kind: "contours", lines, style: HEIGHT_STYLE });
    }

    if (inp.mode === "fcst") {
      const vort = band(inp.cur, "vort500", "vort")!;
      const vmax = extreme(vort, inp, 1);
      const stats = [statRow("Max vorticity", `${vmax.v.toFixed(0)} × 10⁻⁵ s⁻¹`, vmax)];
      if (hgt) {
        const lo = extreme(hgt, inp, -1);
        stats.push(statRow("Lowest height", `${dam(lo.v)} dam`, lo));
      }
      return {
        raster: { kind: "scalar", values: vort, lut: buildLut(vortColor, -10, 50) },
        layers,
        colorbar: { kind: "continuous", color: vortColor, min: -10, max: 50, ticks: range(-10, 50, 10), extend: "both" },
        caption: "500 mb absolute vorticity (10⁻⁵ s⁻¹) · heights every 6 dam",
        stats,
        readout: (k) => [
          { label: "Height", value: hgt ? `${hgt[k].toFixed(0)} m (${dam(hgt[k])} dam)` : "—" },
          { label: "Abs. vorticity", value: fmtNum(vort[k], 0, " × 10⁻⁵ s⁻¹") },
        ],
      };
    }

    const t = trend(inp, "hgt500", "hgt", "h500", redBlue);
    const stats = [];
    if (t.d) {
      const up = extreme(t.d, inp, 1), down = extreme(t.d, inp, -1);
      stats.push(statRow("Largest rise", `${fmtSigned(up.v)} m`, up, "pos"));
      stats.push(statRow("Largest fall", `${fmtSigned(down.v)} m`, down, "neg"));
    }
    return {
      raster: t.raster,
      layers,
      colorbar: t.colorbar,
      caption: t.d
        ? `Δ 500 mb height (m) · ${inp.sides.minus} · ${scaleNote(inp.limitMode, t.limit, "m")}`
        : "Δ 500 mb height (m) · no comparison for this frame",
      stats,
      readout: (k) => [
        { label: `${inp.sides.cur} height`, value: fmtNum(hgt?.[k], 0, " m") },
        { label: `${inp.sides.old} height`, value: fmtNum(oldH?.[k], 0, " m") },
        { label: "Δ", value: t.d ? `${fmtSigned(t.d[k])} m` : "n/a", cls: t.d ? signClass(t.d[k]) : "" },
      ],
    };
  },
};
