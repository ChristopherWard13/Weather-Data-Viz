import { describe, expect, it } from "vitest";
import { pairFor, validTime } from "../src/alignment";
import { config } from "../src/config";
import { loadVectors } from "./vectors";

interface Case { init: string; fhr: number; lag: number; valid: string; older_init: string; older_fhr: number }
const cases = loadVectors<Case>("alignment.json");

describe("valid-time alignment (shared vectors)", () => {
  it.each(cases)("$init F$fhr lag $lag", (c) => {
    const p = pairFor(new Date(c.init), c.fhr, c.lag);
    expect(p.valid.toISOString()).toBe(new Date(c.valid).toISOString());
    expect(p.olderInit.toISOString()).toBe(new Date(c.older_init).toISOString());
    expect(p.olderFhr).toBe(c.older_fhr);
  });

  it("covers every configured lag", () => {
    expect(new Set(cases.map((c) => c.lag))).toEqual(new Set(config.lags));
  });
});

describe("pairFor", () => {
  it("is valid at the same instant for every lag and hour", () => {
    const init = new Date("2026-10-08T18:00:00Z");
    for (const lag of config.lags) {
      for (let f = config.fhr.min; f <= config.fhr.max; f += config.fhr.step) {
        const p = pairFor(init, f, lag);
        expect(validTime(p.olderInit, p.olderFhr).getTime()).toBe(p.valid.getTime());
        expect(p.olderFhr - f).toBe(lag);
      }
    }
  });

  it("formats run ids", () => {
    const p = pairFor(new Date("2027-01-01T00:00:00Z"), 0, 48);
    expect(p.currentRun).toBe("2027010100");
    expect(p.olderRun).toBe("2026123000");
  });

  it("rejects non-positive lags", () => {
    expect(() => pairFor(new Date("2026-10-08T18:00:00Z"), 0, 0)).toThrow();
  });
});
