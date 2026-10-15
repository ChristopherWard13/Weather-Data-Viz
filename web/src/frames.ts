import { Dropped, type FetchQueue, type Fetched, frameQueue, keyOf } from "./fetchqueue";
import { parseRunId } from "./time";
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
 * Raw frame bytes (format v3) -> physical band values. Bands are concatenated;
 * each row is row-delta encoded (running sum modulo 2^bits undoes it); uint16
 * is little-endian; value = stored * scale + offset, or NaN where the band
 * declares `nodata` and the stored value equals it.
 */
export function decodeBands(raw: Uint8Array, field: FieldSpec, nx: number, ny: number): Bands {
  const out: Bands = {};
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let pos = 0;
  for (const b of field.bands) {
    const values = new Float32Array(nx * ny);
    const wide = b.dtype === "uint16";
    const mod = wide ? 65536 : 256;
    const nodata = b.nodata ?? -1; // stored values are never negative
    for (let j = 0; j < ny; j++) {
      let acc = 0;
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const d = wide ? view.getUint16(pos + 2 * k, true) : raw[pos + k];
        acc = (acc + d) % mod;
        values[k] = acc === nodata ? NaN : acc * b.scale + b.offset;
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

// ------------------------------------------------------------------ run files (container wxrb1)

/** Bytes fetched first from a run file: its index fits (the pipeline's HEADER_PROBE). */
export const HEADER_PROBE = 4096;
const MAGIC = [0x57, 0x58, 0x52, 0x42]; // "WXRB"

/** A run file's index: field id -> hour -> [offset, length] of the frame's gzip bytes. */
export type RunIndex = Record<string, Map<number, [number, number]>>;

/** How many bytes from a run file's start its header takes (magic, length and index). */
export function headerLength(bytes: Uint8Array): number {
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error("not a run file (no WXRB header)");
  return 8 + new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true);
}

/**
 * A run file's index, from its first `headerLength` bytes or more: little-endian
 * uint32 n after the magic, then n bytes of JSON,
 * {"v": 1, "fields": {"t2m": [[fhr, offset, length], ...]}}.
 */
export function parseIndex(bytes: Uint8Array): RunIndex {
  const n = headerLength(bytes);
  if (bytes.length < n) throw new Error(`the run file's header is ${n} bytes; only ${bytes.length} were read`);
  const doc = JSON.parse(new TextDecoder().decode(bytes.subarray(8, n))) as { v: number; fields: Record<string, number[][]> };
  if (doc.v !== 1) throw new Error(`run file version ${doc.v}, expected 1`);
  const out: RunIndex = {};
  for (const [field, entries] of Object.entries(doc.fields)) {
    out[field] = new Map(entries.map(([f, off, len]) => [f, [off, len] as [number, number]]));
  }
  return out;
}

/** Fires "frame" when any cache decodes or evicts a frame (the scrubber marks what's loaded). */
export const frameEvents = new EventTarget();

/** Whole run files kept when a server or browser won't do byte ranges (a few: they're a run of one field). */
const WHOLE_FILES = 8;
/**
 * A refused CORS preflight looks like any network error, so a ranged request
 * that fails counts against ranges only when the same file then loads whole.
 * After this many such files, every cache reads whole files for the rest of the
 * page's life; until then each such file is read whole on its own.
 */
const RANGE_FAILURES_TO_GIVE_UP = 2;
let rangeFailures = 0;
let rangesRefused = false;

/**
 * Fetches and decodes frames on demand, with an LRU cache and de-duplicated
 * requests. Downloads go through a queue shared with the other models.
 *
 * Schema 4 keeps each run's field in one run file: the cache reads the file's
 * index once (its first HEADER_PROBE bytes), then each frame by byte range. A
 * server that answers a range with the whole file (200), or a browser whose
 * ranged request fails outright, gets whole files instead, sliced locally.
 * Schema 3 (a file per frame) is still read, until every product is converted.
 */
export class FrameCache {
  private cache = new Map<string, Promise<Bands>>();
  /** Keys whose frame has decoded and is still cached. */
  private ready = new Set<string>();
  /** Run file URL -> its index (pending or read). */
  private indexes = new Map<string, Promise<RunIndex>>();
  private indexed = new Map<string, RunIndex>();
  /** Run file URL -> the whole file, when it came whole. */
  private whole = new Map<string, Promise<ArrayBuffer>>();
  /** Frames asked for as preloads, then needed by the map while still downloading. */
  private promoted = new Set<string>();
  /**
   * The frames waiting on a shared download still in flight (a file's index or
   * the whole file): if the queue drops it, every one of them leaves the cache at
   * once, so a request right after a change of view downloads it afresh.
   */
  private waiting = new Map<string, Set<() => void>>();

  constructor(
    private manifest: Manifest,
    private baseUrl: string,
    private capacity = 400,
    private queue: FetchQueue = frameQueue,
  ) {}

  /** Is the frame decoded and cached, so drawing it needs no download? */
  has(run: string, field: string, fhr: number): boolean {
    return this.ready.has(`${run}/${field}/${fhr}`);
  }

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

  /** The run file holding a frame (schema 4), or null for schema 3's file per frame. */
  private runFile(run: string, field: string): string | null {
    if (this.manifest.schema_version !== 4) return null;
    const name = this.manifest.runs.find((r) => r.id === run)?.files?.[field];
    if (!name) throw new FrameUnavailable(run, field, -1, "no run file named");
    return new URL(this.manifest.file_template!.replace("{run}", run).replace("{file}", name), this.baseUrl).toString();
  }

  /**
   * A frame's bands. `urgent` (the default): the map is waiting for it, so its
   * download goes ahead of preloads; otherwise it's a preload, ranked by how
   * near its valid time is to the viewer's.
   */
  get(run: string, field: string, fhr: number, urgent = true): Promise<Bands> {
    const key = `${run}/${field}/${fhr}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      if (urgent) this.promote(run, field, fhr);
      return hit;
    }
    const reason = this.missingReason(run, field, fhr);
    if (reason) return Promise.reject(new FrameUnavailable(run, field, fhr, reason));

    const spec = this.manifest.fields[field];
    const { nx, ny } = this.manifest.grid;
    const valid = parseRunId(run).getTime() + fhr * 3600e3;
    // A dropped preload leaves the cache at once, so the next request downloads it afresh
    const forget = () => {
      if (this.cache.get(key) === p) this.cache.delete(key);
    };
    const p: Promise<Bands> = this.download(run, field, fhr, valid, () => urgent || this.promoted.has(key), forget)
      .then((buf) => gunzipFrame(buf, spec.frame_bytes))
      .then((raw) => {
        const bands = decodeBands(raw, spec, nx, ny);
        if (this.cache.get(key) === p) {
          this.ready.add(key);
          frameEvents.dispatchEvent(new Event("frame"));
        }
        return bands;
      });
    p.catch(forget); // let a later request retry
    p.finally(() => this.promoted.delete(key)).catch(() => {});
    this.cache.set(key, p);
    while (this.cache.size > this.capacity) {
      const old = this.cache.keys().next().value!;
      this.cache.delete(old);
      // An evicted frame is no longer loaded: the scrubber's marks catch up
      if (this.ready.delete(old)) frameEvents.dispatchEvent(new Event("frame"));
    }
    return p;
  }

  /** Warm the cache without surfacing errors. */
  preload(run: string, field: string, fhr: number): void {
    if (!this.missingReason(run, field, fhr)) this.get(run, field, fhr, false).catch(() => {});
  }

  /** A pending frame is needed now: start its downloads (its file's index, then the frame) if they're waiting. */
  private promote(run: string, field: string, fhr: number): void {
    if (!this.ready.has(`${run}/${field}/${fhr}`)) this.promoted.add(`${run}/${field}/${fhr}`);
    const file = this.runFile(run, field);
    if (!file) {
      this.queue.promote(new URL(framePath(this.manifest.path_template!, run, field, fhr), this.baseUrl).toString());
      return;
    }
    this.queue.promote(keyOf({ url: file, range: [0, HEADER_PROBE - 1] }));
    this.queue.promote(file); // the whole file, when it's read whole
    const span = this.indexed.get(file)?.[field]?.get(fhr);
    if (span) this.queue.promote(keyOf({ url: file, range: [span[0], span[0] + span[1] - 1] }));
  }

  /**
   * A frame's gzip bytes. `urgent()` is asked as each download starts: a preload
   * the map has since asked for (`promote`) goes ahead of the other preloads.
   */
  private async download(run: string, field: string, fhr: number, valid: number, urgent: () => boolean,
                         onDrop: () => void): Promise<ArrayBuffer> {
    const fail = (res: Fetched) => new FrameUnavailable(run, field, fhr, `HTTP ${res.status}`);
    const file = this.runFile(run, field);
    if (!file) {
      const url = new URL(framePath(this.manifest.path_template!, run, field, fhr), this.baseUrl).toString();
      const res = await this.queue.fetch(url, valid, urgent(), onDrop);
      if (!res.ok) throw fail(res);
      return res.body!;
    }
    try {
      return await this.fromRunFile(file, run, field, fhr, valid, urgent, onDrop);
    } catch (e) {
      // A dropped preload stays Dropped; anything else (an index that won't load) is this frame unavailable
      if (e instanceof Dropped || e instanceof FrameUnavailable) throw e;
      throw new FrameUnavailable(run, field, fhr, e instanceof Error ? e.message : String(e));
    }
  }

  private async fromRunFile(file: string, run: string, field: string, fhr: number, valid: number,
                            urgent: () => boolean, onDrop: () => void): Promise<ArrayBuffer> {
    const fail = (res: Fetched) => new FrameUnavailable(run, field, fhr, `HTTP ${res.status}`);
    const index = await this.index(file, valid, urgent(), onDrop);
    const span = index[field]?.get(fhr);
    if (!span) throw new FrameUnavailable(run, field, fhr, "not in its run file");
    const [off, len] = span;
    const cut = (buf: ArrayBuffer) => buf.slice(off, off + len);
    const whole = this.whole.get(file);
    if (whole) return cut(await this.shared(`whole ${file}`, whole, file, urgent(), onDrop));
    const res = await this.ranged(file, [off, off + len - 1], valid, urgent(), onDrop);
    if (!res.ok) throw fail(res);
    if (res.status === 200) return cut(this.keep(file, res.body!)); // the whole file came
    if (res.body!.byteLength !== len) throw new Error(`frame is ${res.body!.byteLength} bytes of a ${len}-byte range`);
    return res.body!;
  }

  /**
   * Bytes `range` of a run file, or the whole file (status 200): when the server
   * sends it, when ranges have been given up on, or when the ranged request fails
   * and the file then loads whole (a refused CORS preflight). If it doesn't load
   * whole either, that was a network error: it fails this request only.
   */
  private async ranged(file: string, range: [number, number], valid: number, urgent: boolean,
                       onDrop: () => void): Promise<Fetched> {
    if (rangesRefused) return { ok: true, status: 200, body: await this.wholeFile(file, valid, urgent, onDrop) };
    try {
      return await this.queue.fetch({ url: file, range }, valid, urgent, onDrop);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e; // Dropped, or anything else, isn't about ranges
      const body = await this.wholeFile(file, valid, urgent, onDrop);
      if (++rangeFailures >= RANGE_FAILURES_TO_GIVE_UP) rangesRefused = true;
      return { ok: true, status: 200, body };
    }
  }

  /**
   * Wait on a shared download still in flight (`key`: a file's index, or the whole
   * file). An urgent asker starts it if it's a waiting preload, and every asker is
   * told at once if the queue drops it.
   */
  private shared<T>(key: string, p: Promise<T>, file: string, urgent: boolean, frameDropped: () => void): Promise<T> {
    this.waiting.get(key)?.add(frameDropped);
    if (urgent) {
      this.queue.promote(keyOf({ url: file, range: [0, HEADER_PROBE - 1] }));
      this.queue.promote(file);
    }
    return p;
  }

  /** Track who waits on a new shared download; the returned onDrop tells them all. */
  private track(key: string, frameDropped: () => void, forget: () => void): () => void {
    const waiters = new Set([frameDropped]);
    this.waiting.set(key, waiters);
    return () => {
      forget();
      if (this.waiting.get(key) === waiters) this.waiting.delete(key);
      for (const w of waiters) w();
    };
  }

  /** A run file's index: fetched once, its first HEADER_PROBE bytes (more if its header is longer). */
  private index(file: string, valid: number, urgent: boolean, frameDropped: () => void): Promise<RunIndex> {
    const key = `index ${file}`;
    const had = this.indexes.get(file);
    if (had) return this.shared(key, had, file, urgent, frameDropped);
    const onDrop = this.track(key, frameDropped, () => {
      if (this.indexes.get(file) === p) this.indexes.delete(file);
    });
    const p: Promise<RunIndex> = (async () => {
      let bytes: Uint8Array;
      const whole = this.whole.get(file);
      if (whole) bytes = new Uint8Array(await whole);
      else {
        let res = await this.ranged(file, [0, HEADER_PROBE - 1], valid, urgent, onDrop);
        if (!res.ok) throw new Error(`run file index: HTTP ${res.status}`);
        if (res.status === 200) this.keep(file, res.body!);
        bytes = new Uint8Array(res.body!);
        const n = headerLength(bytes);
        if (n > bytes.length) {
          res = await this.ranged(file, [0, n - 1], valid, urgent, onDrop);
          if (!res.ok) throw new Error(`run file index: HTTP ${res.status}`);
          if (res.status === 200) this.keep(file, res.body!);
          bytes = new Uint8Array(res.body!);
        }
      }
      const index = parseIndex(bytes);
      this.indexed.set(file, index);
      return index;
    })();
    p.catch(() => {
      if (this.indexes.get(file) === p) this.indexes.delete(file); // a later request tries again
    });
    p.finally(() => this.waiting.delete(key)).catch(() => {});
    this.indexes.set(file, p);
    return p;
  }

  /** The whole run file, downloaded once. */
  private wholeFile(file: string, valid: number, urgent: boolean, frameDropped: () => void): Promise<ArrayBuffer> {
    const key = `whole ${file}`;
    const had = this.whole.get(file);
    if (had) return this.shared(key, had, file, urgent, frameDropped);
    const onDrop = this.track(key, frameDropped, () => {
      if (this.whole.get(file) === p) this.whole.delete(file);
    });
    const p: Promise<ArrayBuffer> = this.queue.fetch(file, valid, urgent, onDrop).then((res) => {
      if (!res.ok) throw new Error(`run file: HTTP ${res.status}`);
      return res.body!;
    });
    p.catch(() => {
      if (this.whole.get(file) === p) this.whole.delete(file);
    });
    p.finally(() => this.waiting.delete(key)).catch(() => {});
    this.remember(file, p);
    return p;
  }

  private keep(file: string, body: ArrayBuffer): ArrayBuffer {
    if (!this.whole.has(file)) this.remember(file, Promise.resolve(body));
    return body;
  }

  private remember(file: string, p: Promise<ArrayBuffer>): void {
    this.whole.set(file, p);
    while (this.whole.size > WHOLE_FILES) this.whole.delete(this.whole.keys().next().value!);
  }
}

/** For tests: forget that a browser refused byte ranges. */
export function resetRanges(): void {
  rangeFailures = 0;
  rangesRefused = false;
}
