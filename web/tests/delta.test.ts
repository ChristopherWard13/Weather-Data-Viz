import { describe, expect, it } from "vitest";
import { autoLimit, computeDelta } from "../src/delta";
import { loadVectors } from "./vectors";

interface Case { current: number; older: number; delta: number; meaning: string }

describe("Δ sign convention (shared vectors)", () => {
  it.each(loadVectors<Case>("delta.json"))("$current - $older = $delta", (c) => {
    const d = computeDelta(Uint8Array.of(c.current), Uint8Array.of(c.older));
    expect(d[0]).toBe(c.delta);
    expect(Math.sign(d[0])).toBe({ faster: 1, slower: -1, unchanged: 0 }[c.meaning]);
  });

  it("rejects mismatched frames", () => {
    expect(() => computeDelta(new Uint8Array(3), new Uint8Array(4))).toThrow();
  });
});

describe("autoLimit", () => {
  it("rounds max|Δ| up to the step, symmetric", () => {
    expect(autoLimit(Int16Array.of(3, -47, 12), 10)).toBe(50);
    expect(autoLimit(Int16Array.of(50, -20), 10)).toBe(50);
    expect(autoLimit(Int16Array.of(51), 10)).toBe(60);
    expect(autoLimit(Int16Array.of(-87), 10)).toBe(90);
  });
  it("never returns 0", () => {
    expect(autoLimit(Int16Array.of(0, 0), 10)).toBe(10);
  });
});
