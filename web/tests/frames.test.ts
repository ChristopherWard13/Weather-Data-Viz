import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { FetchQueue } from "../src/fetchqueue";
import {
  decodeBands, framePath, FrameCache, FrameUnavailable, gunzipFrame, HEADER_PROBE, headerLength, parseIndex, resetRanges,
} from "../src/frames";
import { checkManifest } from "../src/manifest";
import type { FieldSpec, Manifest } from "../src/types";
import { loadFixture } from "./vectors";

const toBuf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

describe("frame contract with the Python encoder (shared/test-vectors/frames.json)", () => {
  const fx = loadFixture<{
    frame_format: number; nx: number; ny: number; field: FieldSpec; raw_base64: string;
    /** null marks a nodata sample */
    decoded: Record<string, (number | null)[]>;
  }>("frames.json");
  const raw = Uint8Array.from(Buffer.from(fx.raw_base64, "base64"));

  it("decodes every band to the encoder's values", () => {
    expect(fx.frame_format).toBe(3);
    const bands = decodeBands(raw, fx.field, fx.nx, fx.ny);
    for (const [name, expected] of Object.entries(fx.decoded)) {
      expect(bands[name]).toHaveLength(fx.nx * fx.ny);
      bands[name].forEach((v, i) => {
        const want = expected[i];
        if (want === null) expect(v).toBeNaN();
        else expect(v).toBeCloseTo(want, 3);
      });
    }
  });

  it("covers uint16, wrapped directions, and clipping", () => {
    expect(fx.field.bands.map((b) => b.dtype)).toContain("uint16");
    expect(fx.field.bands.some((b) => b.wrap === 360)).toBe(true);
    expect(fx.decoded.temp).toContain(175); // 200 °F clipped to the top of the range
  });

  it("covers nodata in both dtypes, with valid values clipped below it", () => {
    const nodata = fx.field.bands.filter((b) => b.nodata !== undefined);
    expect(nodata.map((b) => [b.dtype, b.nodata])).toEqual([["uint8", 255], ["uint16", 65535]]);
    for (const b of nodata) expect(fx.decoded[b.name]).toContain(null);
    expect(fx.decoded.speed).toContain(254); // 255 and 300 kt clip to 254: 255 means nodata
    expect(fx.decoded.speed).not.toContain(255);
    expect(fx.decoded.qpf).toContain(655.34);
  });
});

describe("gunzipFrame", () => {
  const raw = Uint8Array.from({ length: 12 }, (_, i) => i * 20);
  it("gunzips with DecompressionStream", async () => {
    expect([...(await gunzipFrame(toBuf(gzipSync(raw)), 12))]).toEqual([...raw]);
  });
  it("passes through bytes a server already decompressed", async () => {
    expect([...(await gunzipFrame(toBuf(raw), 12))]).toEqual([...raw]);
  });
  it("rejects the wrong size", async () => {
    await expect(gunzipFrame(toBuf(gzipSync(raw)), 13)).rejects.toThrow(/expected 13/);
  });
});

describe("framePath", () => {
  it("fills the schema-3 manifest template", () => {
    expect(framePath("runs/{run}/{field}/f{fhr:03d}.bin.gz", "2026100818", "t2m", 6)).toBe("runs/2026100818/t2m/f006.bin.gz");
  });
});

describe("run file contract with the Python packer (shared/test-vectors/runfile.json)", () => {
  const fx = loadFixture<{
    container: string; header_probe: number; nx: number; ny: number; run_file_base64: string;
    index: Record<string, Record<string, [number, number]>>; raw_base64: Record<string, Record<string, string>>;
  }>("runfile.json");
  const bytes = Uint8Array.from(Buffer.from(fx.run_file_base64, "base64"));

  it("reads the index from the first bytes, as the site fetches them", () => {
    expect(fx.container).toBe("wxrb1");
    expect(fx.header_probe).toBe(HEADER_PROBE);
    const n = headerLength(bytes.subarray(0, 8));
    expect(n).toBeLessThan(HEADER_PROBE);
    const index = parseIndex(bytes.subarray(0, n));
    const plain = Object.fromEntries(Object.entries(index).map(([f, m]) => [f, Object.fromEntries([...m].map(([h, s]) => [String(h), s]))]));
    expect(plain).toEqual(fx.index);
  });

  it("slices every frame, which gunzips to the encoder's bytes", async () => {
    const index = parseIndex(bytes);
    for (const [field, hours] of Object.entries(fx.raw_base64)) {
      for (const [h, raw64] of Object.entries(hours)) {
        const [off, len] = index[field].get(Number(h))!;
        const raw = Uint8Array.from(Buffer.from(raw64, "base64"));
        expect([...(await gunzipFrame(toBuf(bytes.slice(off, off + len)), raw.length))]).toEqual([...raw]);
      }
    }
  });

  it("refuses what isn't a run file, or a header cut short", () => {
    expect(() => headerLength(Uint8Array.of(0x1f, 0x8b, 0, 0, 0, 0, 0, 0))).toThrow(/WXRB/);
    expect(() => parseIndex(bytes.subarray(0, 20))).toThrow(/only 20 were read/);
  });
});

const SPEED: FieldSpec = { label: "speed", min_fhr: 0, frame_bytes: 4, bands: [{ name: "speed", units: "kt", dtype: "uint8", scale: 1, offset: 0 }] };

/** A run file, packed as the pipeline packs it (store.pack_frames): header, then each frame's gzip bytes. */
function packRunFile(frames: Record<string, Record<number, Uint8Array>>): Uint8Array {
  const order = Object.entries(frames).flatMap(([f, hours]) =>
    Object.keys(hours).map(Number).sort((a, b) => a - b).map((h) => [f, h, hours[h]] as const));
  let start = 8;
  for (;;) {
    const fields: Record<string, number[][]> = {};
    let pos = start;
    for (const [f, h, gz] of order) {
      (fields[f] ??= []).push([h, pos, gz.length]);
      pos += gz.length;
    }
    const json = new TextEncoder().encode(JSON.stringify({ v: 1, fields }));
    if (8 + json.length === start) {
      const out = new Uint8Array(pos);
      out.set([0x57, 0x58, 0x52, 0x42]);
      new DataView(out.buffer).setUint32(4, json.length, true);
      out.set(json, 8);
      let at = start;
      for (const [, , gz] of order) {
        out.set(gz, at);
        at += gz.length;
      }
      return out;
    }
    start = 8 + json.length;
  }
}

// Row-delta encoded: rows [1, 2] and [3, 4] are stored as [1, 1] and [3, 1]; F006 is [5, 6], [7, 8]
const FRAME_0 = gzipSync(Uint8Array.of(1, 1, 3, 1));
const FRAME_6 = gzipSync(Uint8Array.of(5, 1, 7, 1));
const BASE = "https://x.test/app/data/";
const WSPD = "wspd250.0123456789abcdef.bin";
const PRECIP = "precip.fedcba9876543210.bin";

function manifest(): Manifest {
  return {
    schema_version: 4,
    generated_at: "2026-10-09T05:00:00Z",
    product: "gfs",
    model: { id: "gfs", name: "GFS" },
    grid: {
      id: "na025", nx: 2, ny: 2, lon0: -170, lat0: 70, dlon: 0.25, dlat: -0.25, row_order: "north_to_south",
      col_order: "west_to_east", lat_min: 69.75, lat_max: 70, lon_min: -170, lon_max: -169.75,
    },
    compression: "gzip",
    layout: "bands_concatenated_row_major_little_endian",
    filter: "row_delta",
    fields: { wspd250: SPEED, precip: { ...SPEED, label: "6-hour precipitation", min_fhr: 6 } },
    file_template: "runs/{run}/{file}",
    container: "wxrb1",
    cycle_interval_hours: 6,
    display_hours: [0, 6],
    latest: "2026100818",
    runs: [{
      id: "2026100818", init: "2026-10-08T18:00:00Z", hours: { wspd250: [0, 6], precip: [6] },
      files: { wspd250: WSPD, precip: PRECIP }, complete: true,
    }],
  };
}

/** The files a fake server holds, by URL. */
function files(): Record<string, Uint8Array> {
  return {
    [`${BASE}runs/2026100818/${WSPD}`]: packRunFile({ wspd250: { 0: FRAME_0, 6: FRAME_6 } }),
    [`${BASE}runs/2026100818/${PRECIP}`]: packRunFile({ precip: { 6: FRAME_6 } }),
  };
}

/**
 * A server for run files. "ranges" honours one byte range (206), "whole" ignores
 * it (200, the whole file), and "refuse" fails a ranged request outright, as a
 * browser does when the bucket refuses the CORS preflight.
 */
function server(held = files(), mode: "ranges" | "whole" | "refuse" = "ranges") {
  const calls: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    calls.push(range ? `${url.split("/").at(-1)} ${range}` : url.split("/").at(-1)!);
    if (range && mode === "refuse") throw new TypeError("Failed to fetch");
    const body = held[url];
    if (!body) return new Response("", { status: 404 });
    if (range && mode === "ranges") {
      const [a, b] = range.replace("bytes=", "").split("-").map(Number);
      return new Response(body.slice(a, Math.min(b, body.length - 1) + 1), { status: 206 });
    }
    return new Response(body.slice(), { status: 200 });
  });
  return { calls, fetcher: fetcher as unknown as typeof fetch, mock: fetcher };
}

function cache(s: ReturnType<typeof server>, capacity = 10, m = manifest()) {
  return new FrameCache(m, BASE, capacity, new FetchQueue(s.fetcher));
}

describe("FrameCache", () => {
  afterEach(() => resetRanges());

  it("reads a run file's index once, then each frame by byte range, and caches", async () => {
    const s = server();
    const c = cache(s);
    const [a, b] = await Promise.all([c.get("2026100818", "wspd250", 6), c.get("2026100818", "wspd250", 6)]);
    expect([...a.speed]).toEqual([5, 6, 7, 8]);
    expect(a).toBe(b);
    const file = files()[`${BASE}runs/2026100818/${WSPD}`];
    const n = headerLength(file);
    expect(s.calls).toEqual([`${WSPD} bytes=0-4095`, `${WSPD} bytes=${n + FRAME_0.length}-${n + FRAME_0.length + FRAME_6.length - 1}`]);
    // Another hour of the same file: just its range
    expect([...(await c.get("2026100818", "wspd250", 0)).speed]).toEqual([1, 2, 3, 4]);
    expect(s.calls.slice(2)).toEqual([`${WSPD} bytes=${n}-${n + FRAME_0.length - 1}`]);
  });

  it("fetches the rest of a header longer than the first bytes read", async () => {
    const hours = Object.fromEntries(Array.from({ length: 300 }, (_, h) => [h, FRAME_0]));
    const big = packRunFile({ wspd250: hours });
    const n = headerLength(big);
    expect(n).toBeGreaterThan(HEADER_PROBE);
    const m = manifest();
    m.runs[0].hours.wspd250 = Object.keys(hours).map(Number);
    const s = server({ [`${BASE}runs/2026100818/${WSPD}`]: big });
    expect([...(await cache(s, 10, m).get("2026100818", "wspd250", 299)).speed]).toEqual([1, 2, 3, 4]);
    expect(s.calls.slice(0, 2)).toEqual([`${WSPD} bytes=0-4095`, `${WSPD} bytes=0-${n - 1}`]);
  });

  it("slices frames from the whole file when the server ignores ranges", async () => {
    const s = server(files(), "whole");
    const c = cache(s);
    expect([...(await c.get("2026100818", "wspd250", 6)).speed]).toEqual([5, 6, 7, 8]);
    expect([...(await c.get("2026100818", "wspd250", 0)).speed]).toEqual([1, 2, 3, 4]);
    expect(s.calls).toEqual([`${WSPD} bytes=0-4095`]); // one download, the whole file
  });

  it("reads a file whole when its ranged request fails but the file loads, and gives up on ranges after two", async () => {
    const s = server(files(), "refuse");
    const c = cache(s);
    expect([...(await c.get("2026100818", "wspd250", 6)).speed]).toEqual([5, 6, 7, 8]);
    expect([...(await c.get("2026100818", "wspd250", 0)).speed]).toEqual([1, 2, 3, 4]); // sliced, no request
    expect([...(await c.get("2026100818", "precip", 6)).speed]).toEqual([5, 6, 7, 8]);
    // Each file's refused range, then the file whole
    expect(s.calls).toEqual([`${WSPD} bytes=0-4095`, WSPD, `${PRECIP} bytes=0-4095`, PRECIP]);
    // Two files refused ranges: another model's cache reads whole files from the start
    const other = cache(s);
    await other.get("2026100818", "precip", 6);
    expect(s.calls.slice(4)).toEqual([PRECIP]);
  });

  it("doesn't give up on ranges after one network blip", async () => {
    const s = server();
    let blip = true;
    const fetcher = (async (url: string, init?: RequestInit) => {
      if (blip && init) {
        blip = false;
        throw new TypeError("Failed to fetch");
      }
      return s.fetcher(url, init);
    }) as unknown as typeof fetch;
    const c = new FrameCache(manifest(), BASE, 10, new FetchQueue(fetcher));
    await c.get("2026100818", "wspd250", 6); // the blip, then that file whole
    await c.get("2026100818", "precip", 6);
    expect(s.calls).toEqual([WSPD, `${PRECIP} bytes=0-4095`, expect.stringMatching(new RegExp(`^${PRECIP} bytes=`))]);
  });

  it("fails just the frame when neither a range nor the whole file loads", async () => {
    let down = true;
    const s = server();
    const fetcher = (async (url: string, init?: RequestInit) => {
      if (down) throw new TypeError("Failed to fetch");
      return s.fetcher(url, init);
    }) as unknown as typeof fetch;
    const c = new FrameCache(manifest(), BASE, 10, new FetchQueue(fetcher));
    await expect(c.get("2026100818", "wspd250", 6)).rejects.toBeInstanceOf(FrameUnavailable);
    down = false;
    await expect(c.get("2026100818", "wspd250", 6)).resolves.toHaveProperty("speed");
    expect(s.calls.every((c) => c.includes("bytes="))).toBe(true); // still by range
  });

  it("still reads a schema-3 manifest's file per frame", async () => {
    const m = manifest();
    m.schema_version = 3;
    m.path_template = "runs/{run}/{field}/f{fhr:03d}.bin.gz";
    delete m.file_template;
    delete m.container;
    delete m.runs[0].files;
    const s = server({ [`${BASE}runs/2026100818/wspd250/f006.bin.gz`]: FRAME_6 });
    expect([...(await cache(s, 10, m).get("2026100818", "wspd250", 6)).speed]).toEqual([5, 6, 7, 8]);
    expect(s.calls).toEqual(["f006.bin.gz"]);
  });

  it("rejects frames the manifest does not list, without fetching", async () => {
    const s = server();
    const c = cache(s);
    await expect(c.get("2026100618", "wspd250", 0)).rejects.toBeInstanceOf(FrameUnavailable);
    await expect(c.get("2026100818", "wspd250", 12)).rejects.toThrow("forecast hour not available");
    await expect(c.get("2026100818", "precip", 0)).rejects.toThrow("6-hour precipitation starts at F006");
    expect(s.mock).not.toHaveBeenCalled();
  });

  it("evicts least recently used frames, but keeps the file's index", async () => {
    const s = server();
    const c = cache(s, 1);
    await c.get("2026100818", "wspd250", 0);
    await c.get("2026100818", "wspd250", 6);
    await c.get("2026100818", "wspd250", 0);
    expect(s.calls).toHaveLength(4); // the index once, then three frames
  });

  it("knows which frames are decoded and still cached", async () => {
    const c = cache(server(), 1);
    expect(c.has("2026100818", "wspd250", 0)).toBe(false);
    await c.get("2026100818", "wspd250", 0);
    expect(c.has("2026100818", "wspd250", 0)).toBe(true);
    await c.get("2026100818", "wspd250", 6);
    expect(c.has("2026100818", "wspd250", 0)).toBe(false); // evicted
    expect(c.has("2026100818", "wspd250", 6)).toBe(true);
  });

  it("forgets a preload the queue dropped, so the map's own request downloads it", async () => {
    const s = server();
    // One preload slot, held by a request that never finishes, so the next preload waits
    const q = new FetchQueue(((url: string, init?: RequestInit) =>
      url.endsWith(PRECIP) ? new Promise(() => {}) : s.fetcher(url, init)) as unknown as typeof fetch, 1);
    const c = new FrameCache(manifest(), BASE, 10, q);
    q.focus(0, "wind");
    c.preload("2026100818", "precip", 6);
    c.preload("2026100818", "wspd250", 6);
    q.focus(0, "temperature");
    expect(q.queued).toBe(0);
    await expect(c.get("2026100818", "wspd250", 6)).resolves.toHaveProperty("speed");
  });

  it("starts a waiting preload's downloads when the map needs the frame", async () => {
    const s = server();
    const q = new FetchQueue(((url: string, init?: RequestInit) =>
      url.endsWith(PRECIP) ? new Promise(() => {}) : s.fetcher(url, init)) as unknown as typeof fetch, 1);
    const c = new FrameCache(manifest(), BASE, 10, q);
    q.focus(0, "wind");
    c.preload("2026100818", "precip", 6); // holds the one slot
    c.preload("2026100818", "wspd250", 6); // its index waits
    expect(q.queued).toBe(1);
    await expect(c.get("2026100818", "wspd250", 6)).resolves.toHaveProperty("speed");
  });

  it("starts a file's waiting index for an urgent frame of another hour", async () => {
    const s = server();
    const q = new FetchQueue(((url: string, init?: RequestInit) =>
      url.endsWith(PRECIP) ? new Promise(() => {}) : s.fetcher(url, init)) as unknown as typeof fetch, 1);
    const c = new FrameCache(manifest(), BASE, 10, q);
    q.focus(0, "wind");
    c.preload("2026100818", "precip", 6); // holds the one preload slot
    c.preload("2026100818", "wspd250", 6); // the file's index waits as a preload
    const urgent = c.get("2026100818", "wspd250", 0);
    q.focus(0, "temperature"); // started, so a change of view can't drop it
    await expect(urgent).resolves.toHaveProperty("speed");
  });

  it("forgets every frame waiting on a dropped index at once", async () => {
    const s = server();
    const q = new FetchQueue(((url: string, init?: RequestInit) =>
      url.endsWith(PRECIP) ? new Promise(() => {}) : s.fetcher(url, init)) as unknown as typeof fetch, 1);
    const c = new FrameCache(manifest(), BASE, 10, q);
    q.focus(0, "wind");
    c.preload("2026100818", "precip", 6);
    c.preload("2026100818", "wspd250", 6); // starts the index (waiting)
    c.preload("2026100818", "wspd250", 0); // waits on the same index
    q.focus(0, "temperature"); // drops it
    // Asked again in the same tick: fresh downloads, not the promises about to reject
    await expect(c.get("2026100818", "wspd250", 0)).resolves.toHaveProperty("speed");
    await expect(c.get("2026100818", "wspd250", 6)).resolves.toHaveProperty("speed");
  });

  it("retries after an HTTP error", async () => {
    let n = 0;
    const s = server();
    const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
      (n++ === 0 ? new Response("", { status: 503 }) : s.fetcher(url, init)));
    const c = new FrameCache(manifest(), BASE, 10, new FetchQueue(fetcher as unknown as typeof fetch));
    await expect(c.get("2026100818", "wspd250", 0)).rejects.toThrow("HTTP 503");
    await expect(c.get("2026100818", "wspd250", 0)).resolves.toHaveProperty("speed");
  });
});

describe("checkManifest", () => {
  it("accepts schema 4", () => {
    expect(() => checkManifest(manifest())).not.toThrow();
  });

  it("accepts schema 3 (a file per frame) until every product is converted", () => {
    const m = { ...manifest(), schema_version: 3, path_template: "runs/{run}/{field}/f{fhr:03d}.bin.gz" } as Manifest;
    expect(() => checkManifest(m)).not.toThrow();
  });

  it("rejects older schemas, and a run without its files", () => {
    expect(() => checkManifest({ ...manifest(), schema_version: 2 } as unknown as Manifest)).toThrow(/schema_version 2/);
    const m = manifest();
    delete m.runs[0].files!.precip;
    expect(() => checkManifest(m)).toThrow(/no run file for precip/);
    expect(() => checkManifest({ ...manifest(), container: "zip" })).toThrow(/unsupported run files/);
  });

  it("accepts nodata only at the dtype's top value", () => {
    const m = manifest();
    m.fields.wspd250 = { ...SPEED, bands: [{ ...SPEED.bands[0], nodata: 255 }] };
    expect(() => checkManifest(m)).not.toThrow();
    m.fields.wspd250.bands[0].nodata = 254;
    expect(() => checkManifest(m)).toThrow(/nodata 254 != 255/);
  });
});
