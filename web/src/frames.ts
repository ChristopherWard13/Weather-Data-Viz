import type { Frame, Manifest } from "./types";

export class FrameUnavailable extends Error {
  constructor(public run: string, public fhr: number, reason: string) {
    super(reason);
  }
}

const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * Decode a frame body. Files are gzip; if a server or CDN already removed the
 * gzip layer (Content-Encoding), the bytes arrive raw and are used as-is.
 */
export async function decodeFrame(buf: ArrayBuffer, expectedBytes: number): Promise<Frame> {
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

export function framePath(template: string, run: string, fhr: number): string {
  return template.replace("{run}", run).replace("{fhr:03d}", String(fhr).padStart(3, "0"));
}

/** Fetches frames on demand with a small LRU cache and de-duplicated requests. */
export class FrameCache {
  private cache = new Map<string, Promise<Frame>>();

  constructor(
    private manifest: Manifest,
    private baseUrl: string,
    private capacity = 160,
    private fetcher: typeof fetch = (...a) => fetch(...a),
  ) {}

  has(run: string, fhr: number): boolean {
    const entry = this.manifest.runs.find((r) => r.id === run);
    return !!entry && entry.hours.includes(fhr);
  }

  /** Why a frame can't be loaded, or null if the manifest lists it. */
  missingReason(run: string, fhr: number): string | null {
    const entry = this.manifest.runs.find((r) => r.id === run);
    if (!entry) return "run not retained";
    if (!entry.hours.includes(fhr)) return "forecast hour not available";
    return null;
  }

  get(run: string, fhr: number): Promise<Frame> {
    const key = `${run}/${fhr}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const reason = this.missingReason(run, fhr);
    if (reason) return Promise.reject(new FrameUnavailable(run, fhr, reason));

    const url = new URL(framePath(this.manifest.path_template, run, fhr), this.baseUrl).toString();
    const p = this.fetcher(url)
      .then((res) => {
        if (!res.ok) throw new FrameUnavailable(run, fhr, `HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => decodeFrame(buf, this.manifest.encoding.frame_bytes));
    p.catch(() => this.cache.delete(key)); // let a later request retry
    this.cache.set(key, p);
    while (this.cache.size > this.capacity) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  /** Warm the cache without surfacing errors. */
  preload(run: string, fhr: number): void {
    if (this.has(run, fhr)) this.get(run, fhr).catch(() => {});
  }
}
