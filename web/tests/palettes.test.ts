import { describe, expect, it } from "vitest";
import { brownGreen, buildLut, lutIndex, qpfBin, redBlue, stopsColor, TEMP_F, tickStep } from "../src/palettes";

const rgb = (css: string) => css.match(/\d+/g)!.map(Number);

describe("stopsColor", () => {
  const c = stopsColor([[0, "#000000"], [10, "#ffffff"]]);
  it("interpolates and clamps", () => {
    expect(rgb(c(5))).toEqual([128, 128, 128]);
    expect(rgb(c(-5))).toEqual([0, 0, 0]);
    expect(rgb(c(50))).toEqual([255, 255, 255]);
  });
  it("marks freezing with a step from blue to green", () => {
    const t = stopsColor(TEMP_F);
    const [r31, g31, b31] = rgb(t(31.9));
    const [r32, g32, b32] = rgb(t(32));
    expect(b31).toBeGreaterThan(g31); // blue side
    expect(g32).toBeGreaterThan(b32); // green side
    expect(r31 + r32).toBeGreaterThan(0);
  });
});

describe("diverging palettes", () => {
  it("RdBu reversed: red above zero, blue below, white at zero", () => {
    const c = redBlue(60);
    const [r1, , b1] = rgb(c(60));
    const [r0, , b0] = rgb(c(-60));
    expect(r1).toBeGreaterThan(b1 + 50);
    expect(b0).toBeGreaterThan(r0 + 50);
    for (const v of rgb(c(0))) expect(v).toBeGreaterThan(235);
  });
  it("BrBG: green-blue wetter, brown drier", () => {
    const c = brownGreen(0.5);
    const [r1, g1] = rgb(c(0.5));
    const [r0, g0] = rgb(c(-0.5));
    expect(g1).toBeGreaterThan(r1); // teal
    expect(r0).toBeGreaterThan(g0); // brown
  });
});

describe("LUT", () => {
  const lut = buildLut(redBlue(60), -60, 60);
  it("is symmetric and clamps", () => {
    expect(lutIndex(lut, -1000)).toBe(0);
    expect(lutIndex(lut, 1000)).toBe(lut.n - 1);
    for (const v of [10, 25, 59]) expect(lutIndex(lut, v) + lutIndex(lut, -v)).toBe(lut.n - 1);
  });
});

describe("tickStep", () => {
  it("lands on 0 and both ends for every limit the views use", () => {
    for (const limit of [10, 20, 25, 35, 45, 55, 60, 70, 85, 150, 0.25, 0.5, 0.75, 1.5]) {
      const s = tickStep(limit);
      const n = (2 * limit) / s;
      expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-9);
      expect(Math.round(n) % 2).toBe(0);
    }
    expect(tickStep(60)).toBe(10);
    expect(tickStep(0.5)).toBe(0.1);
    expect(tickStep(45)).toBe(15);
    expect(tickStep(55)).toBe(5); // labels are thinned when crowded
  });
});

describe("qpfBin", () => {
  it("bins 6-h totals by lower edge", () => {
    expect(qpfBin(0.004)).toBe(-1);
    expect(qpfBin(0.01)).toBe(0);
    expect(qpfBin(0.3)).toBe(3);
    expect(qpfBin(5)).toBe(9);
  });
});
