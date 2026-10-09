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

export interface RunEntry {
  id: string;
  init: string;
  hours: number[];
  complete: boolean;
}

export interface Manifest {
  schema_version: 1;
  generated_at: string;
  model: { name: string; product: string; level: string; field: string };
  encoding: {
    dtype: "uint8";
    units: "kt";
    scale: number;
    offset: number;
    compression: "gzip";
    frame_bytes: number;
  };
  grid: Grid;
  path_template: string;
  cycle_interval_hours: number;
  display_hours: number[];
  latest: string | null;
  runs: RunEntry[];
}

/** A decoded frame: wind speed in kt, row-major, row 0 = north. */
export type Frame = Uint8Array;
