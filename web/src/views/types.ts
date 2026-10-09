import type { FramePair } from "../alignment";
import type { ColorbarSpec } from "../colorbar";
import type { ContourStyle, FlowArrows, IsoLine } from "../contours";
import type { BarbField } from "../barbs";
import type { Lut } from "../palettes";
import type { Bands, Grid } from "../types";

export type ViewId = "jet" | "t2m" | "wind10" | "precip";
export type Mode = "fcst" | "trend";
export type LimitMode = "fixed" | "auto";

export interface ViewInputs {
  grid: Grid;
  mode: Mode;
  variable: string;
  overlays: Set<string>;
  isotachs: number[];
  limitMode: LimitMode;
  pair: FramePair;
  /** Bands by field id for the current run (null where unavailable). */
  cur: Record<string, Bands | null>;
  /** Bands by field id for the older run (trend mode only). */
  old: Record<string, Bands | null>;
  /** Memoize per-frame work (contours, extrema); `key` must identify the inputs. */
  memo: <T>(key: string, make: () => T) => T;
}

export type RasterSpec =
  | { kind: "scalar"; values: Float32Array; lut: Lut }
  | { kind: "precip"; qpf: Float32Array; ptype: Float32Array }
  | null; // nothing to shade: the domain is hatched

export interface Marker {
  lon: number;
  lat: number;
  kind: "H" | "L";
  value: number;
}

export type Layer =
  | { kind: "contours"; lines: IsoLine[]; style: ContourStyle; arrows?: FlowArrows }
  | { kind: "barbs"; field: BarbField; spacing: number; color: string }
  | { kind: "markers"; items: Marker[] };

export interface Row {
  label: string;
  value: string;
  cls?: string;
  sub?: string;
}

export interface Scene {
  raster: RasterSpec;
  layers: Layer[];
  colorbar: ColorbarSpec;
  caption: string;
  stats: Row[];
  /** Hover rows for native grid index k. */
  readout: (k: number) => Row[];
}

export interface Choice {
  id: string;
  label: string;
}

export interface OverlayDef extends Choice {
  default: boolean;
  /** Modes the overlay applies to (default: all). */
  modes?: Mode[];
}

export interface FieldNeeds {
  /** Field the shading comes from; without it there is no frame. */
  primary: string;
  current: string[];
  older: string[];
}

export interface ViewDef {
  id: ViewId;
  tab: string;
  tabSub: string;
  /** Unit of the trend (Δ) shading, for the scale toggle. */
  trendUnit: string;
  modes: Mode[];
  defaultMode: Mode;
  variables?: Choice[];
  overlays: OverlayDef[];
  fields(mode: Mode, variable: string, overlays: Set<string>): FieldNeeds;
  title(mode: Mode, variable: string, t: TitleTimes): string;
  explain(mode: Mode, variable: string): string;
  scene(inp: ViewInputs): Scene;
}

export interface TitleTimes {
  init: string;
  older: string;
  valid: string;
  fhr: string;
  model: string;
}
