import { describe, expect, it } from "vitest";
import { buildLut, colorFor, lutIndex, LUT_SIZE, tickStep } from "../src/colormap";

const rgb = (lut: Uint8ClampedArray, i: number) => [lut[i * 4], lut[i * 4 + 1], lut[i * 4 + 2]];

describe("RdBu reversed", () => {
  const lut = buildLut();
  it("is blue for slower, red for faster, near-white at 0", () => {
    const [r0, , b0] = rgb(lut, lutIndex(-60, 60));
    const [r1, , b1] = rgb(lut, lutIndex(60, 60));
    const mid = rgb(lut, lutIndex(0, 60));
    expect(b0).toBeGreaterThan(r0 + 50); // blue
    expect(r1).toBeGreaterThan(b1 + 50); // red
    for (const c of mid) expect(c).toBeGreaterThan(235);
  });
  it("clips beyond the limits", () => {
    expect(lutIndex(-1000, 60)).toBe(0);
    expect(lutIndex(1000, 60)).toBe(LUT_SIZE - 1);
    expect(lutIndex(0, 60)).toBe(Math.round((LUT_SIZE - 1) / 2));
  });
  it("is symmetric", () => {
    for (const v of [10, 25, 59]) {
      expect(lutIndex(v, 60) + lutIndex(-v, 60)).toBe(LUT_SIZE - 1);
    }
  });
  it("colorFor agrees with the LUT direction", () => {
    expect(colorFor(60, 60)).not.toBe(colorFor(-60, 60));
  });
  it("picks tick steps that land on 0 and both ends", () => {
    expect(tickStep(60)).toBe(10);
    expect(tickStep(20)).toBe(5);
    expect(tickStep(70)).toBe(10);
    expect(tickStep(150)).toBe(25);
    for (let limit = 10; limit <= 260; limit += 10) {
      const s = tickStep(limit);
      expect(limit % s).toBe(0);
      expect(((2 * limit) / s) % 2).toBe(0);
    }
  });
});
