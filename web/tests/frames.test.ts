import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeBands, framePath, FrameCache, FrameUnavailable, gunzipFrame } from "../src/frames";
import type { FieldSpec, Manifest } from "../src/types";
import { loadFixture } from "./vectors";

const toBuf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

describe("frame contract with the Python encoder (shared/test-vectors/frames.json)", () => {
  const fx = loadFixture<{
    nx: number; ny: number; field: FieldSpec; raw_base64: string; decoded: Record<string, number[]>;
  }>("frames.json");
  const raw = Uint8Array.from(Buffer.from(fx.raw_base64, "base64"));

  it("decodes every band to the encoder's values", () => {
    const bands = decodeBands(raw, fx.field, fx.nx, fx.ny);
    for (const [name, expected] of Object.entries(fx.decoded)) {
      expect(bands[name]).toHaveLength(fx.nx * fx.ny);
      bands[name].forEach((v, i) => expect(v).toBeCloseTo(expected[i], 3));
    }
  });

  it("covers uint16, wrapped directions, and clipping", () => {
    expect(fx.field.bands.map((b) => b.dtype)).toContain("uint16");
    expect(fx.field.bands.some((b) => b.wrap === 360)).toBe(true);
    expect(fx.decoded.temp).toContain(175); // 200 °F clipped to the top of the range
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
  it("fills the manifest template", () => {
    expect(framePath("runs/{run}/{field}/f{fhr:03d}.bin.gz", "2026100818", "t2m", 6)).toBe("runs/2026100818/t2m/f006.bin.gz");
  });
});

const SPEED: FieldSpec = { label: "speed", min_fhr: 0, frame_bytes: 4, bands: [{ name: "speed", units: "kt", dtype: "uint8", scale: 1, offset: 0 }] };

function manifest(): Manifest {
  return {
    schema_version: 2,
    generated_at: "2026-10-09T05:00:00Z",
    model: { name: "gfs", product: "pgrb2.0p25" },
    grid: {
      nx: 2, ny: 2, lon0: -170, lat0: 70, dlon: 0.25, dlat: -0.25, row_order: "north_to_south",
      col_order: "west_to_east", lat_min: 69.75, lat_max: 70, lon_min: -170, lon_max: -169.75,
    },
    compression: "gzip",
    layout: "bands_concatenated_row_major_little_endian",
    filter: "row_delta",
    fields: { wspd250: SPEED, precip: { ...SPEED, label: "6-hour precipitation", min_fhr: 6 } },
    path_template: "runs/{run}/{field}/f{fhr:03d}.bin.gz",
    cycle_interval_hours: 6,
    display_hours: [0, 6],
    latest: "2026100818",
    runs: [{ id: "2026100818", init: "2026-10-08T18:00:00Z", hours: { wspd250: [0, 6], precip: [6] }, complete: true }],
  };
}

describe("FrameCache", () => {
  // Row-delta encoded: rows [1, 2] and [3, 4] are stored as [1, 1] and [3, 1]
  const body = toBuf(gzipSync(Uint8Array.of(1, 1, 3, 1)));
  const ok = () => vi.fn(async (_url: string) => new Response(body.slice(0)));

  it("fetches the right URL once, decodes, and caches", async () => {
    const fetcher = ok();
    const c = new FrameCache(manifest(), "https://x.test/app/data/", 10, fetcher as unknown as typeof fetch);
    const [a, b] = await Promise.all([c.get("2026100818", "wspd250", 6), c.get("2026100818", "wspd250", 6)]);
    expect([...a.speed]).toEqual([1, 2, 3, 4]);
    expect(a).toBe(b);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("https://x.test/app/data/runs/2026100818/wspd250/f006.bin.gz");
  });

  it("rejects frames the manifest does not list, without fetching", async () => {
    const fetcher = ok();
    const c = new FrameCache(manifest(), "https://x.test/", 10, fetcher as unknown as typeof fetch);
    await expect(c.get("2026100618", "wspd250", 0)).rejects.toBeInstanceOf(FrameUnavailable);
    await expect(c.get("2026100818", "wspd250", 12)).rejects.toThrow("forecast hour not available");
    await expect(c.get("2026100818", "precip", 0)).rejects.toThrow("6-hour precipitation starts at F006");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("evicts least recently used entries", async () => {
    const fetcher = ok();
    const c = new FrameCache(manifest(), "https://x.test/", 1, fetcher as unknown as typeof fetch);
    await c.get("2026100818", "wspd250", 0);
    await c.get("2026100818", "wspd250", 6);
    await c.get("2026100818", "wspd250", 0);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("retries after an HTTP error", async () => {
    let n = 0;
    const fetcher = vi.fn(async () => (n++ === 0 ? new Response("", { status: 503 }) : new Response(body.slice(0))));
    const c = new FrameCache(manifest(), "https://x.test/", 10, fetcher as unknown as typeof fetch);
    await expect(c.get("2026100818", "wspd250", 0)).rejects.toThrow("HTTP 503");
    await expect(c.get("2026100818", "wspd250", 0)).resolves.toHaveProperty("speed");
  });
});
