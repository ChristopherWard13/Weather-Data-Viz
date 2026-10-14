import { describe, expect, it } from "vitest";
import { latestOf, sumBands, windowFor, windowHours } from "../src/accum";

const T = (iso: string) => new Date(`${iso}:00:00Z`);

describe("windows (Phase 3.8)", () => {
  const start = T("2026-10-12T00"); // the newest run shown starts here

  it("24 h ends at the valid time and never reaches before the start", () => {
    expect(windowFor("24h", T("2026-10-13T12"), start)).toMatchObject({ from: T("2026-10-12T12"), hours: 24 });
    expect(windowFor("24h", T("2026-10-12T18"), start)).toMatchObject({ from: start, hours: 18 });
    expect(windowFor("24h", start, start).hours).toBe(0);
  });

  it("Total runs from the start to the valid time", () => {
    expect(windowFor("total", T("2026-10-14T00"), start)).toMatchObject({ from: start, hours: 48, start });
    expect(windowFor("total", T("2026-10-11T18"), start).hours).toBe(0); // before the start: nothing yet
  });

  it("names the forecast hours of each run whose 6-h amounts make it up", () => {
    const w = windowFor("24h", T("2026-10-13T12"), start);
    // The run shown (00Z) and one 12 h older: the same four 6-h amounts, at their own hours
    expect(windowHours(T("2026-10-12T00"), w)).toEqual([18, 24, 30, 36]);
    expect(windowHours(T("2026-10-11T12"), w)).toEqual([30, 36, 42, 48]);
    expect(windowHours(start, windowFor("total", T("2026-10-12T12"), start))).toEqual([6, 12]);
    expect(windowHours(start, windowFor("total", start, start))).toEqual([]);
  });

  it("starts where the newest of several runs does", () => {
    expect(latestOf([T("2026-10-12T00"), T("2026-10-12T06"), T("2026-10-11T12")])).toEqual(T("2026-10-12T06"));
  });

  it("sums the amounts and leaves out what can't be summed", () => {
    const a = { qpf: new Float32Array([0.1, 0.5]), ptype: new Float32Array([1, 2]) };
    const b = { qpf: new Float32Array([0.2, 0.25]), ptype: new Float32Array([2, 2]) };
    const total = sumBands([a, b], ["qpf"]);
    expect(Object.keys(total)).toEqual(["qpf"]);
    expect([...total.qpf].map((v) => +v.toFixed(4))).toEqual([0.3, 0.75]);
    expect([...a.qpf]).toEqual([...new Float32Array([0.1, 0.5])]); // the cached frames are untouched
  });
});
