export interface Grid {
  nx: number;
  ny: number;
  lon0: number;
  lat0: number;
  dlon: number;
  dlat: number;
  row_order: "north_to_south";
  col_order: "west_to_east";
  lat_min: number;
  lat_max: number;
  lon_min: number;
  lon_max: number;
}

export interface BandSpec {
  name: string;
  units: string;
  dtype: "uint8" | "uint16";
  scale: number;
  offset: number;
  wrap?: number;
  categories?: string[];
}

export interface FieldSpec {
  label: string;
  min_fhr: number;
  frame_bytes: number;
  bands: BandSpec[];
}

export interface RunEntry {
  id: string;
  init: string;
  /** field id -> available forecast hours */
  hours: Record<string, number[]>;
  complete: boolean;
}

export interface Manifest {
  schema_version: 2;
  generated_at: string;
  model: { name: string; product: string };
  grid: Grid;
  compression: "gzip";
  layout: "bands_concatenated_row_major_little_endian";
  filter: "row_delta";
  fields: Record<string, FieldSpec>;
  path_template: string;
  cycle_interval_hours: number;
  display_hours: number[];
  latest: string | null;
  runs: RunEntry[];
}

/** A decoded frame: band name -> physical values (row-major, row 0 = north). */
export type Bands = Record<string, Float32Array>;
