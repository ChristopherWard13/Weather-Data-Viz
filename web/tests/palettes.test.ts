import { describe, expect, it } from "vitest";
import {
  brownGreen, buildLut, lutIndex, PRECIP_DRY, PTYPE_COLORS, qpfBin, QPF_BINS, redBlue, rgbaOf, stopsColor, TEMP_F, tickStep,
} from "../src/palettes";

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
    expect(qpfBin(0.3)).toBe(2);
    expect(qpfBin(5)).toBe(5);
  });
});

// CIELAB ΔE76, and deuteranopia simulated with Machado et al. (2009) at full
// severity, in linear RGB: the measures the 2026-10-12 creator review used.
const toLin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c: number) => 255 * ((c = Math.min(1, Math.max(0, c))) <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const DEUT = [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]];
const deut = (rgb: number[]) => { const l = rgb.map(toLin); return DEUT.map((row) => toGam(row[0] * l[0] + row[1] * l[1] + row[2] * l[2])); };
function lab(rgb: number[]): number[] {
  const [r, g, b] = rgb.map(toLin);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [x, y, z] = [(0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * b, (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883];
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const deltaE = (a: number[], b: number[]) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
const rgbOf = (css: string) => rgbaOf(css).slice(0, 3);

describe("precipitation-type palette", () => {
  const types = [1, 2, 3, 4];
  const cross = (sim: (c: number[]) => number[]) => {
    let min = Infinity;
    for (const a of types) for (const b of types) {
      if (a >= b) continue;
      for (const ca of PTYPE_COLORS[a]) for (const cb of PTYPE_COLORS[b]) min = Math.min(min, deltaE(sim(rgbOf(ca)), sim(rgbOf(cb))));
    }
    return min;
  };
  it("has one color per bin for every type", () => {
    for (const t of [...types, 5]) expect(PTYPE_COLORS[t]).toHaveLength(QPF_BINS.length);
  });
  it("keeps every type apart from every other, at every amount", () => {
    expect(cross((c) => c)).toBeGreaterThanOrEqual(15);
  });
  it("keeps them apart with deuteranopia simulated (pinned at the 12.2 reached)", () => {
    expect(cross(deut)).toBeGreaterThanOrEqual(12);
  });
  it("makes each type's lightest bin stand out from dry ground, and each bin from the next", () => {
    for (const t of types) {
      expect(deltaE(rgbOf(PTYPE_COLORS[t][0]), rgbOf(PRECIP_DRY)), `type ${t}`).toBeGreaterThanOrEqual(20);
      PTYPE_COLORS[t].slice(1).forEach((c, i) => expect(deltaE(rgbOf(c), rgbOf(PTYPE_COLORS[t][i]))).toBeGreaterThanOrEqual(10));
    }
  });
});
