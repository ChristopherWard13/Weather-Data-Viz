import { asStored } from "../units";
import { fmtSigned } from "../colorbar";
import {
  brownGreen, FROZEN_TYPES, PTYPE_LABELS, QPF_TOTAL_BINS, QPF_TOTAL_COLORS, SNOW_BINS, SNOW_COLORS,
} from "../palettes";
import type { Period, Window } from "../accum";
import { pressureLayers } from "./surface";
import type { Scene, TitleTimes, ViewDef, ViewInputs } from "./types";
import { band, extreme, fmtNum, pointOf, scaleNote, signClass, statRow, trend } from "./util";

/**
 * Snowfall is stored as liquid equivalent, so the ratio is the site's choice
 * (Phase 3.8 decision A): 10:1 for every model, named wherever snow is shown.
 */
export const SNOW_RATIO = 10;
const RATIO = `${SNOW_RATIO}:1`;

const inch = (v: number) => `${v.toFixed(2)} in`;
const snowInch = (v: number) => `${v.toFixed(v >= 10 ? 0 : 1)} in`;

/** What a frame or window holds: "6-h precipitation", "18-h snowfall", "total snowfall". */
function amountName(snow: boolean, acc: { period: Period; hours: number } | null | undefined): string {
  const what = snow ? "snowfall" : "precipitation";
  if (!acc || acc.period === "6h") return `6-h ${what}`;
  // A window with nothing in it yet (at its start) keeps its full name; the banner explains
  return acc.period === "total" ? `total ${what}` : `${acc.hours || 24}-h ${what}`;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** The hours in the title: "6 h ending …", "18 h ending …", or "Sun 12Z to …". */
function windowText(t: TitleTimes): string {
  const a = t.acc;
  if (!a || a.period === "6h") return `6 h ending ${t.valid}`;
  if (a.period === "total") return a.hours ? `${a.from} to ${t.valid}` : `starting ${t.valid}`;
  return `${a.hours || 24} h ending ${t.valid}`;
}

export const precip: ViewDef = {
  id: "precip",
  tab: "Precipitation",
  tabSub: "6 h, rain / frozen",
  trendQ: () => asStored("in"),
  modes: ["fcst", "trend"],
  defaultMode: "fcst",
  variables: [
    { id: "all", label: "All precipitation", field: "precip", noun: "precipitation" },
    { id: "snow", label: "Snow", field: "snow", noun: "snowfall", strict: true },
  ],
  overlays: [
    { id: "isobars", label: "Isobars (4 hPa)", default: true },
    { id: "centers", label: "High / low centers", default: true },
  ],
  sums: { precip: ["qpf"], snow: ["sf"] },
  periods: true,
  trendKey: (variable, period) => (variable === "snow" ? `snow:${period}` : period === "6h" ? "precip" : `precip:${period}`),

  fields(mode, variable, ov) {
    const primary = variable === "snow" ? "snow" : "precip";
    const current = [primary];
    if (ov.has("isobars") || ov.has("centers")) current.push("mslp");
    return { primary, current, older: mode === "trend" ? [primary] : [] };
  },

  title(mode, variable, t) {
    const snow = variable === "snow";
    const name = amountName(snow, t.acc);
    if (mode === "trend") return `${t.model} ${name}${snow ? ` (${RATIO})` : ""} trend: init ${t.init} vs ${t.older} | ${windowText(t)} | ${t.fhr}`;
    const kind = snow ? ` (${RATIO})` : t.acc && t.acc.period !== "6h" ? "" : t.untyped ? "" : " & type";
    return `${t.model} ${name}${kind} | init ${t.init} | ${windowText(t)} | ${t.fhr}`;
  },

  explain(mode, variable, _units, period = "6h") {
    const snow = variable === "snow";
    const over = period === "6h"
      ? "in the 6 hours ending at the valid time"
      : period === "24h"
        ? "in the 24 hours ending at the valid time (fewer where the day reaches back before the newest run shown starts)"
        : "from the start of the window to the valid time. The window starts with the newest run shown, so every map on screen sums the same hours";
    const what = snow
      ? `<p><strong>Shading:</strong> snowfall ${over}, in inches at a ${RATIO} snow-to-liquid ratio (liquid equivalent × ${SNOW_RATIO}). It's each model's own snowfall; how it's made is under the model's name below.</p>`
      : period === "6h"
        ? `<p><strong>Shading:</strong> liquid-equivalent precipitation ${over} (in), colored by the dominant type over those 6 hours: rain, snow, sleet, or freezing rain.</p>`
        : `<p><strong>Shading:</strong> liquid-equivalent precipitation ${over} (in). Types can't be added up over a window, so totals show the liquid amount only.</p>`;
    const trendText = `<p><strong>Shading:</strong> the current run's ${snow ? `snowfall (in inches at ${RATIO})` : "precipitation"} minus the older run's, over the same hours ${period === "6h" ? "(the 6 hours ending at the valid time)" : "(the window above)"}.</p>
         <p class="legend-row"><span class="sw green"></span> current run ${snow ? "snowier" : "wetter"} <span class="sw brown"></span> ${snow ? "less snow" : "drier"}</p>`;
    return (mode === "trend" ? (period === "6h" ? "" : what.replace("<strong>Shading:</strong>", "<strong>Totals:</strong>")) + trendText : what) +
      `<p><strong>Contours:</strong> sea-level isobars every 4 hPa at the valid time, with high and low centers.</p>`;
  },

  scene(inp: ViewInputs): Scene {
    const snow = inp.variable === "snow";
    const acc = inp.acc ?? null;
    return !snow && !acc ? typedScene(inp) : amountScene(inp, snow, acc);
  },
};

/** 6-h precipitation by type: what every model shows per frame. */
function typedScene(inp: ViewInputs): Scene {
  const { grid } = inp;
  const qpf = band(inp.cur, "precip", "qpf")!;
  const ptype = band(inp.cur, "precip", "ptype")!;
  const mslp = band(inp.cur, "mslp", "mslp");
  const layers = pressureLayers(inp, inp.overlays.has("isobars"), inp.overlays.has("centers"));
  const wettest = extreme(qpf, inp, 1);
  const typeAt = (k: number) => PTYPE_LABELS[Math.round(ptype[k])] ?? "—";
  // Models with no type output mark every wet point "unspecified" (5)
  const untyped = !inp.precipType;

  if (inp.mode === "fcst") {
    // Over the focused region, like the other stats
    const frozenMax = extreme(qpf, inp, 1, (k) => FROZEN_TYPES.has(Math.round(ptype[k])));
    const frozen = Math.max(0, frozenMax.v), frozenAt = frozenMax.k;
    const stats = [statRow("Max 6-h total", inch(wettest.v), wettest)];
    if (wettest.v >= 0.005 && !untyped) stats[0].sub += ` · ${typeAt(wettest.k).toLowerCase()}`;
    if (frozen > 0) {
      stats.push(statRow(`Max frozen (${typeAt(frozenAt).toLowerCase()})`, inch(frozen), pointOf(grid, frozenAt)));
    }
    return {
      raster: { kind: "precip", qpf, ptype },
      layers,
      colorbar: { kind: "precip", untyped },
      caption: untyped
        // The legend's note already says type isn't available
        ? "6-h precipitation (in, liquid equivalent)"
        : "6-h precipitation (in, liquid equivalent) by dominant type",
      stats,
      readout: (k) => [
        { label: "6-h precip", value: qpf[k] >= 0.005 ? inch(qpf[k]) : "none" },
        { label: "Type", value: untyped ? "not available" : qpf[k] >= 0.005 ? typeAt(k) : "—" },
        { label: "Pressure", value: fmtNum(mslp?.[k], 1, " hPa") },
      ],
    };
  }
  const fmt2 = (v: number) => fmtSigned(v, 2);
  const t = trend(inp, "precip", "qpf", "precip", brownGreen);
  const old = band(inp.old, "precip", "qpf");
  const stats = [];
  if (t.d) {
    const up = extreme(t.d, inp, 1), down = extreme(t.d, inp, -1);
    stats.push(statRow("Largest increase", `${fmt2(up.v)} in`, up, "wet"));
    stats.push(statRow("Largest decrease", `${fmt2(down.v)} in`, down, "dry"));
  }
  return {
    raster: t.raster,
    layers,
    colorbar: t.colorbar,
    caption: t.d
      ? `Δ 6-h precipitation (in) · ${inp.sides.minus} · ${scaleNote(inp.limitMode, t.limit, "in")}`
      : "Δ 6-h precipitation (in) · no comparison for this frame",
    stats,
    readout: (k) => [
      { label: inp.sides.cur, value: inch(qpf[k]) },
      { label: inp.sides.old, value: old ? inch(old[k]) : "—" },
      { label: "Δ", value: t.d ? `${fmt2(t.d[k])} in` : "n/a", cls: t.d ? (signClass(t.d[k]) === "pos" ? "wet" : signClass(t.d[k]) === "neg" ? "dry" : "") : "" },
    ],
  };
}

/**
 * Amounts without type: snowfall per 6 h, and totals over a window (liquid
 * or snow). Snow is shown in inches at the ratio, from its liquid equivalent.
 */
function amountScene(inp: ViewInputs, snow: boolean, acc: Window | null): Scene {
  const field = snow ? "snow" : "precip", name = snow ? "sf" : "qpf";
  const period: Period = acc?.period ?? "6h";
  // The memo's prefix names the frames' sources, not the window: the tag does
  const tag = `${field}/${acc ? `${acc.period}/${acc.from.getTime()}` : "6h"}`;
  const shown = (bands: ViewInputs["cur"], side: string) => {
    const v = band(bands, field, name);
    return v && snow ? inp.memo(`${tag}/${side}`, () => v.map((x) => x * SNOW_RATIO)) : v;
  };
  const cur = shown(inp.cur, "cur")!;
  const liquid = band(inp.cur, field, name)!;
  const mslp = band(inp.cur, "mslp", "mslp");
  const layers = pressureLayers(inp, inp.overlays.has("isobars"), inp.overlays.has("centers"));
  const label = amountName(snow, acc);
  const fmt = snow ? snowInch : inch;
  const dry = snow ? 0.05 : 0.005; // below this a readout says none
  const unit = snow ? `in, ${RATIO} snow-to-liquid` : "in, liquid equivalent";

  if (inp.mode === "fcst") {
    const bins = snow ? SNOW_BINS : QPF_TOTAL_BINS, colors = snow ? SNOW_COLORS : QPF_TOTAL_COLORS;
    const top = extreme(cur, inp, 1);
    return {
      raster: { kind: "binned", values: cur, bins, colors },
      layers,
      colorbar: { kind: "bins", bins, colors, label: snow ? `Snow ${RATIO}` : "Liquid" },
      caption: `${cap(label)} (${unit})`,
      stats: [statRow(`Max ${label}`, fmt(Math.max(0, top.v)), top)],
      readout: (k) => [
        { label: snow ? `${cap(label)} (${RATIO})` : cap(label), value: cur[k] >= dry ? fmt(cur[k]) : "none" },
        ...(snow ? [{ label: "Liquid equivalent", value: liquid[k] >= 0.005 ? inch(liquid[k]) : "none" }] : []),
        { label: "Pressure", value: fmtNum(mslp?.[k], 1, " hPa") },
      ],
    };
  }

  const old = shown(inp.old, "old");
  const key = precipTrendKey(snow, period);
  // trend() reads its two sides by field and band: hand it the amounts shown
  const t = trend({ ...inp, cur: { [tag]: { v: cur } }, old: old ? { [tag]: { v: old } } : {} }, tag, "v", key, brownGreen);
  const digits = snow ? 1 : 2;
  const stats = [];
  if (t.d) {
    const up = extreme(t.d, inp, 1), down = extreme(t.d, inp, -1);
    stats.push(statRow("Largest increase", `${fmtSigned(up.v, digits)} in`, up, "wet"));
    stats.push(statRow("Largest decrease", `${fmtSigned(down.v, digits)} in`, down, "dry"));
  }
  const what = `Δ ${label} (in${snow ? `, ${RATIO}` : ""})`;
  return {
    raster: t.raster,
    layers,
    colorbar: t.colorbar,
    caption: t.d
      ? `${what} · ${inp.sides.minus} · ${scaleNote(inp.limitMode, t.shown, "in")}`
      : `${what} · no comparison for this frame`,
    stats,
    readout: (k) => [
      { label: inp.sides.cur, value: fmt(cur[k]) },
      { label: inp.sides.old, value: old ? fmt(old[k]) : "—" },
      {
        label: "Δ", value: t.d ? `${fmtSigned(t.d[k], digits)} in` : "n/a",
        cls: t.d ? (signClass(t.d[k]) === "pos" ? "wet" : signClass(t.d[k]) === "neg" ? "dry" : "") : "",
      },
    ],
  };
}

const precipTrendKey = (snow: boolean, period: Period) => precip.trendKey!(snow ? "snow" : "all", period);
