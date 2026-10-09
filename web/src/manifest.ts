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
  if (m.schema_version !== 1) throw new Error(`unsupported manifest schema_version ${m.schema_version}`);
  const g = m.grid;
  if (g.row_order !== "north_to_south" || g.col_order !== "west_to_east") {
    throw new Error(`unsupported grid order ${g.row_order}/${g.col_order}`);
  }
  const e = m.encoding;
  if (e.dtype !== "uint8" || e.scale !== 1 || e.offset !== 0 || e.frame_bytes !== g.nx * g.ny) {
    throw new Error("unsupported frame encoding");
  }
}
