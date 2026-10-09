import type { Manifest } from "./types";

export async function loadManifest(baseUrl: string): Promise<Manifest> {
  const url = new URL("manifest.json", baseUrl).toString();
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`could not load ${url}: HTTP ${res.status}`);
  const m = (await res.json()) as Manifest;
  checkManifest(m);
  return m;
}

/** Light runtime check; the full JSON Schema is enforced by the pipeline. */
export function checkManifest(m: Manifest): void {
  if (m.schema_version !== 2) throw new Error(`unsupported manifest schema_version ${m.schema_version}`);
  const g = m.grid;
  if (g.row_order !== "north_to_south" || g.col_order !== "west_to_east") {
    throw new Error(`unsupported grid order ${g.row_order}/${g.col_order}`);
  }
  if (m.filter !== "row_delta" || m.layout !== "bands_concatenated_row_major_little_endian") {
    throw new Error(`unsupported frame layout ${m.layout}/${m.filter}`);
  }
  for (const [id, f] of Object.entries(m.fields)) {
    const bytes = f.bands.reduce((n, b) => n + (b.dtype === "uint16" ? 2 : 1), 0) * g.nx * g.ny;
    if (bytes !== f.frame_bytes) throw new Error(`field ${id}: frame_bytes ${f.frame_bytes} != ${bytes}`);
  }
}
