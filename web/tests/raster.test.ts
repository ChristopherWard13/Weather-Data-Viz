import { describe, expect, it } from "vitest";
import { shadeDelta } from "../src/raster";
import { buildLut } from "../src/colormap";
import type { Lookup } from "../src/projection";

describe("shadeDelta", () => {
  it("bilinearly samples Δ and colors by sign", () => {
    // 2x2 grid; three pixels: west edge, east edge, midpoint, plus one outside
    const nx = 2;
    const delta = Int16Array.of(-60, 60, -60, 60);
    const lookup: Lookup = {
      width: 4, height: 1,
      index: Int32Array.of(0, 0, 0, -1),
      fx: Float32Array.of(0, 1, 0.5, 0),
      fy: Float32Array.of(0, 0, 0.5, 0),
    };
    const out = new Uint8ClampedArray(16);
    shadeDelta(out, lookup, delta, nx, 60, buildLut());
    const px = (k: number) => [...out.slice(k * 4, k * 4 + 4)];
    const [w, e, mid, outside] = [px(0), px(1), px(2), px(3)];
    expect(w[2]).toBeGreaterThan(w[0]); // blue: slower
    expect(e[0]).toBeGreaterThan(e[2]); // red: faster
    expect(Math.min(mid[0], mid[1], mid[2])).toBeGreaterThan(235); // ~white at Δ=0
    expect(outside[3]).toBe(0);
  });
});
