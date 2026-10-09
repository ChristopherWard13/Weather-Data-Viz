import { contourLines, smoothForContours } from "../contours";
import { fmtSigned } from "../colorbar";
import { buildLut, JET_KT, redBlue, stopsColor } from "../palettes";
import { fmtTime } from "../time";
import type { Layer, Scene, ViewDef, ViewInputs } from "./types";
import { band, compass, extreme, fmtNum, OLDER_STYLE, scaleNote, signClass, statRow, trend } from "./util";

const jetColor = stopsColor(JET_KT);

export const jet: ViewDef = {
  id: "jet",
  tab: "Jet stream",
  tabSub: "250 mb wind",
  trendUnit: "kt",
  modes: ["trend", "fcst"],
  defaultMode: "trend",
  overlays: [
    { id: "arrows", label: "Flow arrows on isotachs", default: true },
    { id: "barbs", label: "Wind barbs", default: false },
    { id: "older", label: "Older run's isotachs (dashed)", default: false, modes: ["trend"] },
  ],

  fields(mode, _variable, ov) {
    const current = ["wspd250"];
    if (ov.has("arrows") || ov.has("barbs")) current.push("wdir250");
    return { primary: "wspd250", current, older: mode === "trend" ? ["wspd250"] : [] };
  },

  title(mode, _v, t) {
    return mode === "trend"
      ? `${t.model} 250 mb |V| trend: init ${t.init} vs ${t.older} | valid ${t.valid} | ${t.fhr}`
      : `${t.model} 250 mb wind speed (kt) | init ${t.init} | valid ${t.valid} | ${t.fhr}`;
  },

  explain(mode) {
    return mode === "trend"
      ? `<p><strong>Shading:</strong> Δ|V|, the current run's 250 mb wind speed minus the older run's, both valid at the same time.</p>
         <p class="legend-row"><span class="sw red"></span> current run faster <span class="sw blue"></span> slower</p>
         <p><strong>Black contours:</strong> the current run's isotachs, with chevrons showing the flow direction.</p>`
      : `<p><strong>Shading:</strong> 250 mb wind speed (kt), the jet stream level.</p>
         <p><strong>Black contours:</strong> isotachs, with chevrons showing the flow direction.</p>`;
  },

  scene(inp: ViewInputs): Scene {
    const { grid } = inp;
    const speed = band(inp.cur, "wspd250", "speed")!;
    const dir = band(inp.cur, "wdir250", "dir");
    const layers: Layer[] = [];
    const run = inp.pair.currentRun, f = inp.pair.currentFhr;

    if (inp.mode === "trend" && inp.overlays.has("older") && inp.old.wspd250) {
      const old = inp.old.wspd250.speed;
      const lines = inp.memo(`iso-old/${inp.pair.olderRun}/${inp.pair.olderFhr}/${inp.isotachs}`, () =>
        contourLines(smoothForContours(old, grid.nx, grid.ny), grid, inp.isotachs));
      layers.push({ kind: "contours", lines, style: { ...OLDER_STYLE, label: (v) => String(v) } });
    }
    const lines = inp.memo(`iso/${run}/${f}/${inp.isotachs}`, () =>
      contourLines(smoothForContours(speed, grid.nx, grid.ny), grid, inp.isotachs));
    layers.push({
      kind: "contours",
      lines,
      style: { color: "#000", width: 1.35, label: (v) => String(v) },
      arrows: inp.overlays.has("arrows") && dir ? { dir, grid } : undefined,
    });
    if (inp.overlays.has("barbs") && dir) {
      // Barbs only in the jets (>= 40 kt), where the flow is the story
      layers.push({ kind: "barbs", field: { speed, dir, minSpeed: 40 }, spacing: 40, color: "rgba(17,24,39,0.85)" });
    }

    const vmax = extreme(speed, grid, 1);
    if (inp.mode === "fcst") {
      return {
        raster: { kind: "scalar", values: speed, lut: buildLut(jetColor, 0, 230) },
        layers,
        colorbar: { kind: "continuous", color: jetColor, min: 30, max: 230, ticks: [30, 50, 70, 90, 110, 130, 150, 170, 190, 210, 230], extend: "max" },
        caption: "250 mb wind speed (kt)",
        stats: [statRow("Max |V|", `${vmax.v.toFixed(0)} kt`, vmax)],
        readout: (k) => [
          { label: "|V|", value: `${speed[k].toFixed(0)} kt` },
          ...(dir ? [{ label: "From", value: `${dir[k].toFixed(0)}° (${compass(dir[k])})` }] : []),
        ],
      };
    }

    const t = trend(inp, "wspd250", "speed", "jet", redBlue);
    const old = band(inp.old, "wspd250", "speed");
    const stats = [statRow("Max |V|", `${vmax.v.toFixed(0)} kt`, vmax)];
    if (t.d) {
      const up = extreme(t.d, grid, 1), down = extreme(t.d, grid, -1);
      stats.push(statRow("Largest gain", `${fmtSigned(up.v)} kt`, up, "pos"));
      stats.push(statRow("Largest loss", `${fmtSigned(down.v)} kt`, down, "neg"));
    }
    return {
      raster: t.raster,
      layers,
      colorbar: t.colorbar,
      caption: t.d
        ? `Δ|V| (kt) · ${fmtTime(inp.pair.currentInit)} minus ${fmtTime(inp.pair.olderInit)} · ${scaleNote(inp.limitMode, t.limit, "kt")}`
        : "Δ|V| (kt) · no comparison for this frame",
      stats,
      readout: (k) => [
        { label: "Current |V|", value: `${speed[k].toFixed(0)} kt` },
        { label: "Older |V|", value: fmtNum(old?.[k], 0, " kt") },
        { label: "Δ", value: t.d ? `${fmtSigned(t.d[k])} kt` : "n/a", cls: t.d ? signClass(t.d[k]) : "" },
        ...(dir ? [{ label: "From", value: `${dir[k].toFixed(0)}° (${compass(dir[k])})` }] : []),
      ],
    };
  },
};
