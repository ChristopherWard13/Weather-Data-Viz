import { contourLines, smoothForContours } from "../contours";
import { findExtrema } from "../extrema";
import type { Grid } from "../types";
import type { Layer, Marker, ViewInputs } from "./types";

const ISOBARS = Array.from({ length: (1080 - 920) / 4 + 1 }, (_, i) => 920 + 4 * i);

/** Isobars every 4 hPa and H/L centers from mean sea-level pressure. */
export function pressureLayers(inp: ViewInputs, showIsobars: boolean, showCenters: boolean): Layer[] {
  const mslp = inp.cur.mslp?.mslp;
  if (!mslp) return [];
  const { grid } = inp;
  const key = `${inp.pair.currentRun}/${inp.pair.currentFhr}`;
  const layers: Layer[] = [];
  if (showIsobars) {
    const lines = inp.memo(`isobars/${key}`, () =>
      contourLines(smoothForContours(mslp, grid.nx, grid.ny, 3), grid, ISOBARS));
    layers.push({
      kind: "contours",
      lines,
      style: { color: "rgba(17,24,39,0.9)", width: 1, label: (v) => String(v), labelColor: "#111827", labelSpacing: 360 },
    });
  }
  if (showCenters) {
    const items = inp.memo(`centers/${key}`, () => centers(mslp, grid));
    layers.push({ kind: "markers", items });
  }
  return layers;
}

function centers(mslp: Float32Array, grid: Grid): Marker[] {
  // Heavier smoothing than the isobars: only synoptic-scale centers.
  const smooth = smoothForContours(mslp, grid.nx, grid.ny, 8);
  return findExtrema(smooth, grid.nx, grid.ny, 16, 3).map((e) => ({
    kind: e.kind,
    value: mslp[e.j * grid.nx + e.i],
    lon: grid.lon0 + e.i * grid.dlon,
    lat: grid.lat0 + e.j * grid.dlat,
  }));
}
