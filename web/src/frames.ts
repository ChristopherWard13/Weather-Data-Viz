import type { Bands, FieldSpec, Manifest } from "./types";

export class FrameUnavailable extends Error {
  constructor(public run: string, public field: string, public fhr: number, reason: string) {
    super(reason);
  }
}

const GZIP_MAGIC = [0x1f, 0x8b];

/** Undo gzip (unless a server already did) and check the size. */
export async function gunzipFrame(buf: ArrayBuffer, expectedBytes: number): Promise<Uint8Array> {
  let bytes = new Uint8Array(buf);
  if (bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1]) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (bytes.length !== expectedBytes) {
    throw new Error(`frame is ${bytes.length} bytes, expected ${expectedBytes}`);
  }
  return bytes;
}

/**
 * Raw frame bytes -> physical band values. Bands are concatenated; each row
 * is row-delta encoded (running sum modulo 2^bits undoes it); uint16 is
 * little-endian; value = stored * scale + offset.
 */
export function decodeBands(raw: Uint8Array, field: FieldSpec, nx: number, ny: number): Bands {
  const out: Bands = {};
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let pos = 0;
  for (const b of field.bands) {
    const values = new Float32Array(nx * ny);
    const wide = b.dtype === "uint16";
    const mod = wide ? 65536 : 256;
    for (let j = 0; j < ny; j++) {
      let acc = 0;
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const d = wide ? view.getUint16(pos + 2 * k, true) : raw[pos + k];
        acc = (acc + d) % mod;
        values[k] = acc * b.scale + b.offset;
      }
    }
    out[b.name] = values;
    pos += nx * ny * (wide ? 2 : 1);
  }
  return out;
}

export function framePath(template: string, run: string, field: string, fhr: number): string {
  return template
    .replace("{run}", run)
    .replace("{field}", field)
    .replace("{fhr:03d}", String(fhr).padStart(3, "0"));
}

/** Fetches and decodes frames on demand, with an LRU cache and de-duplicated requests. */
export class FrameCache {
  private cache = new Map<string, Promise<Bands>>();

  constructor(
    private manifest: Manifest,
    private baseUrl: string,
    private capacity = 400,
    private fetcher: typeof fetch = (...a) => fetch(...a),
  ) {}

  /** Why a frame can't be loaded, or null if the manifest lists it. */
  missingReason(run: string, field: string, fhr: number): string | null {
    const spec = this.manifest.fields[field];
    if (!spec) return `unknown field ${field}`;
    if (fhr < spec.min_fhr) return `${spec.label.toLowerCase()} starts at F${String(spec.min_fhr).padStart(3, "0")}`;
    const entry = this.manifest.runs.find((r) => r.id === run);
    if (!entry) return "run not retained";
    if (!(entry.hours[field] ?? []).includes(fhr)) return "forecast hour not available";
    return null;
  }

  get(run: string, field: string, fhr: number): Promise<Bands> {
    const key = `${run}/${field}/${fhr}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const reason = this.missingReason(run, field, fhr);
    if (reason) return Promise.reject(new FrameUnavailable(run, field, fhr, reason));

    const spec = this.manifest.fields[field];
    const { nx, ny } = this.manifest.grid;
    const url = new URL(framePath(this.manifest.path_template, run, field, fhr), this.baseUrl).toString();
    const p = this.fetcher(url)
      .then((res) => {
        if (!res.ok) throw new FrameUnavailable(run, field, fhr, `HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => gunzipFrame(buf, spec.frame_bytes))
      .then((raw) => decodeBands(raw, spec, nx, ny));
    p.catch(() => this.cache.delete(key)); // let a later request retry
    this.cache.set(key, p);
    while (this.cache.size > this.capacity) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  /** Warm the cache without surfacing errors. */
  preload(run: string, field: string, fhr: number): void {
    if (!this.missingReason(run, field, fhr)) this.get(run, field, fhr).catch(() => {});
  }
}
