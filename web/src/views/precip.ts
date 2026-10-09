import { fmtSigned } from "../colorbar";
import { brownGreen, PTYPE_LABELS } from "../palettes";
import { fmtTime } from "../time";
import { pressureLayers } from "./surface";
import type { Scene, ViewDef, ViewInputs } from "./types";
import { band, extreme, fmtNum, pointOf, scaleNote, signClass, statRow, trend } from "./util";

const inch = (v: number) => `${v.toFixed(2)} in`;

export const precip: ViewDef = {
  id: "precip",
  tab: "Precipitation",
  tabSub: "6 h, rain / frozen",
  trendUnit: "in",
  modes: ["fcst", "trend"],
  defaultMode: "fcst",
  overlays: [
    { id: "isobars", label: "Isobars (4 hPa)", default: true },
    { id: "centers", label: "High / low centers", default: true },
  ],

  fields(mode, _v, ov) {
    const current = ["precip"];
    if (ov.has("isobars") || ov.has("centers")) current.push("mslp");
    return { primary: "precip", current, older: mode === "trend" ? ["precip"] : [] };
  },

  title(mode, _v, t) {
    return mode === "trend"
      ? `${t.model} 6-h precipitation trend: init ${t.init} vs ${t.older} | 6 h ending ${t.valid} | ${t.fhr}`
      : `${t.model} 6-h precipitation & type | init ${t.init} | 6 h ending ${t.valid} | ${t.fhr}`;
  },

  explain(mode) {
    return (mode === "trend"
      ? `<p><strong>Shading:</strong> the current run's 6-hour precipitation minus the older run's, for the same 6 hours.</p>
         <p class="legend-row"><span class="sw green"></span> current run wetter <span class="sw brown"></span> drier</p>`
      : `<p><strong>Shading:</strong> liquid-equivalent precipitation in the 6 hours ending at the valid time (in), colored by the dominant type over those 6 hours: rain, snow, sleet, or freezing rain.</p>`) +
      `<p><strong>Contours:</strong> sea-level isobars every 4 hPa at the valid time, with high and low centers.</p>`;
  },

  scene(inp: ViewInputs): Scene {
    const { grid } = inp;
    const qpf = band(inp.cur, "precip", "qpf")!;
    const ptype = band(inp.cur, "precip", "ptype")!;
    const mslp = band(inp.cur, "mslp", "mslp");
    const layers = pressureLayers(inp, inp.overlays.has("isobars"), inp.overlays.has("centers"));
    const wettest = extreme(qpf, grid, 1);
    const typeAt = (k: number) => PTYPE_LABELS[Math.round(ptype[k])] ?? "—";

    if (inp.mode === "fcst") {
      let frozen = 0, frozenAt = 0;
      for (let k = 0; k < qpf.length; k++) if (ptype[k] >= 2 && qpf[k] > frozen) { frozen = qpf[k]; frozenAt = k; }
      const stats = [statRow("Max 6-h total", inch(wettest.v), wettest)];
      if (wettest.v >= 0.005) stats[0].sub += ` · ${typeAt(wettest.k).toLowerCase()}`;
      if (frozen > 0) {
        stats.push(statRow(`Max frozen (${typeAt(frozenAt).toLowerCase()})`, inch(frozen), pointOf(grid, frozenAt)));
      }
      return {
        raster: { kind: "precip", qpf, ptype },
        layers,
        colorbar: { kind: "precip" },
        caption: "6-h precipitation (in, liquid equivalent) by dominant type",
        stats,
        readout: (k) => [
          { label: "6-h precip", value: qpf[k] >= 0.005 ? inch(qpf[k]) : "none" },
          { label: "Type", value: qpf[k] >= 0.005 ? typeAt(k) : "—" },
          { label: "Pressure", value: fmtNum(mslp?.[k], 1, " hPa") },
        ],
      };
    }
    const fmt2 = (v: number) => fmtSigned(v, 2);
    const t = trend(inp, "precip", "qpf", "precip", brownGreen);
    const old = band(inp.old, "precip", "qpf");
    const stats = [];
    if (t.d) {
      const up = extreme(t.d, grid, 1), down = extreme(t.d, grid, -1);
      stats.push(statRow("Largest increase", `${fmt2(up.v)} in`, up, "wet"));
      stats.push(statRow("Largest decrease", `${fmt2(down.v)} in`, down, "dry"));
    }
    return {
      raster: t.raster,
      layers,
      colorbar: t.colorbar,
      caption: t.d
        ? `Δ 6-h precipitation (in) · ${fmtTime(inp.pair.currentInit)} minus ${fmtTime(inp.pair.olderInit)} · ${scaleNote(inp.limitMode, t.limit, "in")}`
        : "Δ 6-h precipitation (in) · no comparison for this frame",
      stats,
      readout: (k) => [
        { label: "Current", value: inch(qpf[k]) },
        { label: "Older", value: old ? inch(old[k]) : "—" },
        { label: "Δ", value: t.d ? `${fmt2(t.d[k])} in` : "n/a", cls: t.d ? (signClass(t.d[k]) === "pos" ? "wet" : signClass(t.d[k]) === "neg" ? "dry" : "") : "" },
      ],
    };
  },
};

