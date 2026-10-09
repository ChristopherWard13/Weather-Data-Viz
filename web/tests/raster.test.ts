import { describe, expect, it } from "vitest";
import { shadePrecip, shadeScalar } from "../src/raster";
import { buildLut, PTYPE_COLORS, redBlue, rgbaOf } from "../src/palettes";
import type { Lookup } from "../src/projection";

// 2x2 grid; pixels: west edge, east edge, midpoint, outside
const lookup: Lookup = {
  width: 4, height: 1,
  index: Int32Array.of(0, 0, 0, -1),
  fx: Float32Array.of(0, 1, 0.5, 0),
  fy: Float32Array.of(0, 0, 0.5, 0),
};
const px = (out: Uint8ClampedArray, k: number) => [...out.slice(k * 4, k * 4 + 4)];

describe("shadeScalar", () => {
  it("bilinearly samples and colors through the LUT", () => {
    const out = new Uint8ClampedArray(16);
    shadeScalar(out, lookup, Float32Array.of(-60, 60, -60, 60), 2, buildLut(redBlue(60), -60, 60));
    const [w, e, mid, outside] = [0, 1, 2, 3].map((k) => px(out, k));
    expect(w[2]).toBeGreaterThan(w[0]); // blue
    expect(e[0]).toBeGreaterThan(e[2]); // red
    expect(Math.min(mid[0], mid[1], mid[2])).toBeGreaterThan(235);
    expect(outside[3]).toBe(0);
  });
});

describe("shadePrecip", () => {
  const dry: [number, number, number, number] = [1, 2, 3, 255];
  it("bins the amount and never interpolates the type", () => {
    const out = new Uint8ClampedArray(16);
    // west column: 0.3 in of snow; east column: 0.3 in of rain
    shadePrecip(out, lookup, Float32Array.of(0.3, 0.3, 0.3, 0.3), Float32Array.of(2, 1, 2, 1), 2, dry);
    expect(px(out, 0)).toEqual(rgbaOf(PTYPE_COLORS[2][3])); // 0.25-0.5 bin, snow
    expect(px(out, 1)).toEqual(rgbaOf(PTYPE_COLORS[1][3])); // rain
    expect([rgbaOf(PTYPE_COLORS[2][3]), rgbaOf(PTYPE_COLORS[1][3])]).toContainEqual(px(out, 2));
  });
  it("leaves dry pixels dry and takes the type from a wet neighbour at the edge", () => {
    const out = new Uint8ClampedArray(16);
    // only the south-east point has snow; the midpoint interpolates to 0.05
    shadePrecip(out, lookup, Float32Array.of(0, 0, 0, 0.2), Float32Array.of(0, 0, 0, 2), 2, dry);
    expect(px(out, 0)).toEqual([...dry]);
    expect(px(out, 2)).toEqual(rgbaOf(PTYPE_COLORS[2][1])); // snow, not a rain fringe
  });
});
