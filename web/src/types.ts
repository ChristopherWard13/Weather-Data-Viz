export interface Grid {
  /** Display grid id from config/grids.json, e.g. "na025". */
  id: string;
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
  /** Stored value of a missing sample (the dtype's top value); decodes to NaN. */
  nodata?: number;
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
  /** field id -> the run file holding its frames (schema 4; `file_template`'s {file}) */
  files?: Record<string, string>;
  complete: boolean;
}

export interface Manifest {
  /** 4: one run file per run and field. 3: one file per frame, read until every product is converted. */
  schema_version: 3 | 4;
  generated_at: string;
  /** Product id: a model on one display grid, e.g. "gfs". */
  product: string;
  model: { id: string; name: string };
  grid: Grid;
  compression: "gzip";
  layout: "bands_concatenated_row_major_little_endian";
  filter: "row_delta";
  fields: Record<string, FieldSpec>;
  /** Schema 4: "runs/{run}/{file}", each run naming its files. */
  file_template?: string;
  /** Schema 4: how a run file holds its frames ("wxrb1": an index, then each frame gzipped). */
  container?: string;
  /** Schema 3: "runs/{run}/{field}/f{fhr:03d}.bin.gz". */
  path_template?: string;
  cycle_interval_hours: number;
  display_hours: number[];
  latest: string | null;
  runs: RunEntry[];
}

/** A decoded frame: band name -> physical values (row-major, row 0 = north; NaN = nodata). */
export type Bands = Record<string, Float32Array>;
