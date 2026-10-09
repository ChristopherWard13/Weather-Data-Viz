import { describe, expect, it } from "vitest";
import { findExtrema } from "../src/extrema";

function field(nx: number, ny: number, fn: (i: number, j: number) => number): Float32Array {
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) out[j * nx + i] = fn(i, j);
  return out;
}

describe("findExtrema", () => {
  it("finds a high and a low", () => {
    const f = field(80, 40, (i, j) =>
      1012 + 20 * Math.exp(-((i - 20) ** 2 + (j - 20) ** 2) / 60) - 25 * Math.exp(-((i - 60) ** 2 + (j - 20) ** 2) / 60));
    const ex = findExtrema(f, 80, 40, 8, 3);
    expect(ex).toHaveLength(2);
    expect(ex).toContainEqual(expect.objectContaining({ kind: "H", i: 20, j: 20 }));
    expect(ex).toContainEqual(expect.objectContaining({ kind: "L", i: 60, j: 20 }));
  });
  it("marks a broad high with two maxima once, at the stronger one", () => {
    const g = (i: number, j: number, ci: number, a: number) => a * Math.exp(-((i - ci) ** 2 + (j - 25) ** 2) / 20);
    const f = field(100, 50, (i, j) => 1012 + g(i, j, 43, 14) + g(i, j, 57, 15)); // 14 cells apart
    const ex = findExtrema(f, 100, 50, 8, 3);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ kind: "H" });
    expect(ex[0].i).toBeGreaterThan(50);
  });

  it("never marks flat ground as a center", () => {
    const flat = field(60, 40, (i, j) => (i > 20 && i < 40 && j > 10 && j < 30 ? 1030 : 1012));
    // A plateau: no single point is strictly above its neighbours
    expect(findExtrema(flat, 60, 40, 8, 3)).toEqual([]);
  });

  it("ignores weak bumps and the domain edge", () => {
    const weak = field(60, 40, (i, j) => 1012 + 1 * Math.exp(-((i - 30) ** 2 + (j - 20) ** 2) / 40));
    expect(findExtrema(weak, 60, 40, 8, 3)).toEqual([]);
    const ramp = field(60, 40, (i) => 1000 + i); // max on the edge, not a center
    expect(findExtrema(ramp, 60, 40, 8, 3)).toEqual([]);
  });
});
