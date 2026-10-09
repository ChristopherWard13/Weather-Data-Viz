import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeFrame, framePath, FrameCache, FrameUnavailable } from "../src/frames";
import type { Manifest } from "../src/types";

const toBuf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

describe("decodeFrame", () => {
  const raw = Uint8Array.from({ length: 12 }, (_, i) => i * 20);
  it("gunzips with DecompressionStream", async () => {
    const out = await decodeFrame(toBuf(gzipSync(raw)), 12);
    expect([...out]).toEqual([...raw]);
  });
  it("passes through bytes a server already decompressed", async () => {
    const out = await decodeFrame(toBuf(raw), 12);
    expect([...out]).toEqual([...raw]);
  });
  it("rejects the wrong size", async () => {
    await expect(decodeFrame(toBuf(gzipSync(raw)), 13)).rejects.toThrow(/expected 13/);
  });
});

describe("framePath", () => {
  it("fills the manifest template", () => {
    expect(framePath("runs/{run}/f{fhr:03d}.bin.gz", "2026100818", 6)).toBe("runs/2026100818/f006.bin.gz");
  });
});

function manifest(): Manifest {
  return {
    schema_version: 1,
    generated_at: "2026-10-09T05:00:00Z",
    model: { name: "gfs", product: "pgrb2.0p25", level: "250 mb", field: "wind speed" },
    encoding: { dtype: "uint8", units: "kt", scale: 1, offset: 0, compression: "gzip", frame_bytes: 4 },
    grid: {
      nx: 2, ny: 2, lon0: -170, lat0: 70, dlon: 0.25, dlat: -0.25, row_order: "north_to_south",
      col_order: "west_to_east", lat_min: 69.75, lat_max: 70, lon_min: -170, lon_max: -169.75,
    },
    path_template: "runs/{run}/f{fhr:03d}.bin.gz",
    cycle_interval_hours: 6,
    display_hours: [0, 6],
    latest: "2026100818",
    runs: [{ id: "2026100818", init: "2026-10-08T18:00:00Z", hours: [0, 6], complete: true }],
  };
}

describe("FrameCache", () => {
  const body = toBuf(gzipSync(Uint8Array.of(1, 2, 3, 4)));
  const ok = () => vi.fn(async (_url: string) => new Response(body.slice(0)));

  it("fetches the right URL once and caches", async () => {
    const fetcher = ok();
    const c = new FrameCache(manifest(), "https://x.test/app/data/", 10, fetcher as unknown as typeof fetch);
    const [a, b] = await Promise.all([c.get("2026100818", 6), c.get("2026100818", 6)]);
    expect([...a]).toEqual([1, 2, 3, 4]);
    expect(a).toBe(b);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("https://x.test/app/data/runs/2026100818/f006.bin.gz");
  });

  it("rejects frames the manifest does not list, without fetching", async () => {
    const fetcher = ok();
    const c = new FrameCache(manifest(), "https://x.test/", 10, fetcher as unknown as typeof fetch);
    await expect(c.get("2026100618", 0)).rejects.toBeInstanceOf(FrameUnavailable);
    await expect(c.get("2026100818", 12)).rejects.toThrow("forecast hour not available");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("evicts least recently used entries", async () => {
    const fetcher = ok();
    const c = new FrameCache(manifest(), "https://x.test/", 1, fetcher as unknown as typeof fetch);
    await c.get("2026100818", 0);
    await c.get("2026100818", 6);
    await c.get("2026100818", 0);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("retries after an HTTP error", async () => {
    let n = 0;
    const fetcher = vi.fn(async () => (n++ === 0 ? new Response("", { status: 503 }) : new Response(body.slice(0))));
    const c = new FrameCache(manifest(), "https://x.test/", 10, fetcher as unknown as typeof fetch);
    await expect(c.get("2026100818", 0)).rejects.toThrow("HTTP 503");
    await expect(c.get("2026100818", 0)).resolves.toHaveLength(4);
  });
});
