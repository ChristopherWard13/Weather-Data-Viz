import type { FramePair } from "../alignment";
import type { ColorbarSpec } from "../colorbar";
import type { ContourStyle, FlowArrows, IsoLine } from "../contours";
import type { BarbField } from "../barbs";
import type { Lut } from "../palettes";
import type { Bands, Grid } from "../types";
import type { Box } from "../config";
import type { Quantity, Units } from "../units";
import type { Period, Window } from "../accum";

export type ViewId = "jet" | "t2m" | "wind10" | "precip" | "h500" | "t850";
export type Mode = "fcst" | "trend";
export type LimitMode = "fixed" | "auto";

export interface ViewInputs {
  grid: Grid;
  /** The focused region's box (stats cover it), or null for the whole grid. */
  focus?: Box | null;
  mode: Mode;
  variable: string;
  overlays: Set<string>;
  isotachs: number[];
  limitMode: LimitMode;
  pair: FramePair;
  /** Bands by field id for the current run (null where unavailable). */
  cur: Record<string, Bands | null>;
  /** Bands by field id for the older run (trend mode), or the other model (compare). */
  old: Record<string, Bands | null>;
  /** What `cur` and `old` are, for readouts and captions. */
  sides: Sides;
  /** The model of `cur` outputs precipitation type (config "precip_type"). */
  precipType: boolean;
  /** Units the viewer chose; frames stay in their stored units. */
  units: Units;
  /** Memoize per-frame work (contours, extrema); `key` must identify the inputs. */
  memo: <T>(key: string, make: () => T) => T;
  /**
   * The window `cur` and `old` were summed over (views with `sums`, at 24 h
   * or Total), or none: then they hold the frames at the valid time.
   */
  acc?: Window | null;
}

/** "Current"/"Older" and "… minus …" in trend mode; model names in compare mode. */
export interface Sides {
  cur: string;
  old: string;
  minus: string;
}

export type RasterSpec =
  | { kind: "scalar"; values: Float32Array; lut: Lut }
  | { kind: "precip"; qpf: Float32Array; ptype: Float32Array }
  /** An amount in bins (window totals): `colors[i]` from `bins[i]` up; dry below the first. */
  | { kind: "binned"; values: Float32Array; bins: number[]; colors: string[] }
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

export interface VariableDef extends Choice {
  /** Field the variable shades; it's offered only for products that have it. */
  field: string;
  /** What it is in a sentence ("gusts"); defaults to the label in lower case. */
  noun?: string;
  /**
   * Picking it hides models without its field (snowfall), as a sidebar field
   * does, instead of each model falling back to a shading it has (500 mb).
   */
  strict?: boolean;
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
  /** The trend (Δ) shading's quantity as shown in the viewer's units, for the scale toggle. */
  trendQ: (u: Units) => Quantity;
  modes: Mode[];
  defaultMode: Mode;
  variables?: VariableDef[];
  overlays: OverlayDef[];
  fields(mode: Mode, variable: string, overlays: Set<string>): FieldNeeds;
  /**
   * Fields that can be totalled over a window, and the bands that are summed
   * (the rest, like precipitation type, are dropped). A view with `sums`
   * offers the periods: 6 h, 24 h and Total.
   */
  sums?: Record<string, string[]>;
  periods?: boolean;
  /** Which `site.json` trend limits apply (default: the view's id). */
  trendKey?: (variable: string, period: Period) => string;
  /**
   * The map's headline: model, field and mode, nothing that changes with the
   * valid time (the runs go on the line under it, the time in the readout).
   */
  title(mode: Mode, variable: string, t: TitleInfo): string;
  explain(mode: Mode, variable: string, units: Units, period?: Period): string;
  scene(inp: ViewInputs): Scene;
}

export interface TitleInfo {
  model: string;
  /** The model has no precipitation type (config "precip_type": false). */
  untyped?: boolean;
  units: Units;
  /** A total's window: its period and the hours it covers. */
  acc?: { period: Period; hours: number } | null;
}
