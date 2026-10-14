import { describe, expect, it } from "vitest";
import { pairFor } from "../src/alignment";
import { productById } from "../src/config";
import { FrameUnavailable } from "../src/frames";
import { firstGap, loadFields, planFrame, totalsGap, type Product } from "../src/sources";
import { defaultState, type ViewState } from "../src/state";
import type { Bands } from "../src/types";

const T = (iso: string) => new Date(`${iso}:00:00Z`);

/** A product whose 6-h frames hold their own forecast hour (so sums show which frames went in). `lacks` lists hours a run never got. */
function fake(id: string, runs: string[], hours = 384, lacks: Record<string, number[]> = {}): Product & { asked: string[] } {
  const asked: string[] = [];
  const cfg = productById(id)!;
  const display = Array.from({ length: hours / 6 + 1 }, (_, i) => i * 6);
  return {
    asked,
    cfg,
    manifest: {
      display_hours: display,
      latest: runs[0],
      runs: runs.map((r) => ({ id: r, hours: Object.fromEntries(["precip", "snow"].map((f) => [f, display.filter((h) => h >= 6 && !(lacks[r] ?? []).includes(h))])) })),
      fields: { precip: { min_fhr: 6 }, snow: { min_fhr: 6 }, mslp: { min_fhr: 0 } },
    } as unknown as Product["manifest"],
    frames: {
      get(run: string, field: string, fhr: number): Promise<Bands> {
        asked.push(`${run}/${field}/${fhr}`);
        const v = new Float32Array([fhr]);
        const bands: Bands = field === "snow" ? { sf: v } : { qpf: v, ptype: new Float32Array([1]) };
        return Promise.resolve(bands);
      },
      missingReason: (run: string, _f: string, fhr: number) => ((lacks[run] ?? []).includes(fhr) ? "forecast hour not available" : null),
    } as unknown as Product["frames"],
  };
}

const state = (patch: Partial<ViewState>): ViewState => ({ ...defaultState("precip", "gfs"), ...patch });
const valid = T("2026-10-13T12");

describe("window totals (Phase 3.8)", () => {
  it("6-h frames need no window", () => {
    const gfs = fake("gfs", ["2026101300"]);
    expect(planFrame(state({}), gfs, null, pairFor(T("2026-10-13T00"), 12, 12)).acc).toBeNull();
  });

  it("a trend sums both runs over the current run's window", async () => {
    const gfs = fake("gfs", ["2026101300", "2026101212"]);
    const plan = planFrame(state({ mode: "trend", period: "total", variable: "snow" }), gfs, null, pairFor(T("2026-10-13T00"), 12, 12));
    expect(plan.acc).toMatchObject({ start: T("2026-10-13T00"), from: T("2026-10-13T00"), hours: 12 });
    const [cur] = await loadFields(plan.cur, ["snow"], plan);
    const [old] = await loadFields(plan.older!, ["snow"], plan);
    // F006 + F012 of the 00Z run; F018 + F024 of the 12Z run before it: the same hours
    expect(cur.status === "fulfilled" && cur.value.sf[0]).toBe(18);
    expect(old.status === "fulfilled" && old.value.sf[0]).toBe(42);
    expect(gfs.asked).toEqual(["2026101300/snow/6", "2026101300/snow/12", "2026101212/snow/18", "2026101212/snow/24"]);
  });

  it("totals drop precipitation type, which can't be summed", async () => {
    const gfs = fake("gfs", ["2026101300"]);
    const plan = planFrame(state({ period: "24h" }), gfs, null, pairFor(T("2026-10-13T00"), 36, 12));
    const [res] = await loadFields(plan.cur, ["precip"], plan);
    expect(res.status === "fulfilled" && Object.keys(res.value)).toEqual(["qpf"]);
    expect(res.status === "fulfilled" && res.value.qpf[0]).toBe(18 + 24 + 30 + 36);
  });

  it("a comparison starts where the newer of the two runs does", () => {
    const gfs = fake("gfs", ["2026101306"]);
    const ecmwf = fake("ecmwf", ["2026101300"]);
    const s = state({ mode: "compare", compareView: "diff", period: "total", compare: "ecmwf" });
    const plan = planFrame(s, gfs, ecmwf, pairFor(T("2026-10-13T06"), 6, 12));
    expect(plan.older?.run).toBe("2026101300");
    expect(plan.acc?.start).toEqual(T("2026-10-13T06")); // GFS's 06Z, newer than ECMWF's 00Z
    expect(plan.acc?.to).toEqual(valid);
  });

  it("presentation slots can push the start later, never earlier", () => {
    const gfs = fake("gfs", ["2026101300"]);
    const pair = pairFor(T("2026-10-13T00"), 36, 12);
    expect(planFrame(state({ period: "total" }), gfs, null, pair, T("2026-10-13T06")).acc?.start).toEqual(T("2026-10-13T06"));
    expect(planFrame(state({ period: "total" }), gfs, null, pair, T("2026-10-12T00")).acc?.start).toEqual(T("2026-10-13T00"));
  });

  it("overlays stay single frames at the valid time", async () => {
    const gfs = fake("gfs", ["2026101300"]);
    const plan = planFrame(state({ period: "24h" }), gfs, null, pairFor(T("2026-10-13T00"), 36, 12));
    expect(plan.needsCur).toEqual(["precip", "mslp"]);
    await loadFields(plan.cur, ["mslp"], plan);
    expect(gfs.asked).toEqual(["2026101300/mslp/36"]);
  });

  it("a window with no amounts yet loads nothing and says why", async () => {
    const gfs = fake("gfs", ["2026101300"]);
    const plan = planFrame(state({ period: "total" }), gfs, null, pairFor(T("2026-10-13T00"), 0, 12));
    expect(plan.acc?.hours).toBe(0);
    const [res] = await loadFields(plan.cur, ["precip"], plan);
    expect(res.status).toBe("rejected");
    expect(res.status === "rejected" && res.reason).toBeInstanceOf(FrameUnavailable);
    expect(gfs.asked).toEqual([]);
  });

  it("a missing 6-h amount is named, not the hour shown", async () => {
    const gfs = fake("gfs", ["2026101300"], 384, { "2026101300": [18] });
    const plan = planFrame(state({ period: "total" }), gfs, null, pairFor(T("2026-10-13T00"), 36, 12));
    const [res] = await loadFields(plan.cur, ["precip"], plan);
    expect(res.status === "rejected" && (res.reason as Error).message).toBe("the total needs F018: forecast hour not available");
    expect(gfs.asked).toEqual([]); // nothing fetched for a total that can't be made
  });

  it("totals stop before the first missing 6-h amount of any run they sum", () => {
    const gfs = fake("gfs", ["2026101300", "2026101212"], 384, { "2026101300": [42], "2026101212": [30] });
    expect(firstGap(gfs, "2026101300", "precip")).toMatchObject({ fhr: 42, reach: T("2026-10-14T12") });
    // Forecast: the run shown's gap; trend 12 h: the older run's F030 (valid 13 Oct 18Z) comes first
    expect(totalsGap(state({ period: "total" }), gfs, null, "2026101300")?.reach).toEqual(T("2026-10-14T12"));
    expect(totalsGap(state({ period: "24h", mode: "trend", lag: 12 }), gfs, null, "2026101300")).toMatchObject({ run: "2026101212", fhr: 30, reach: T("2026-10-13T12") });
    // The compared model's run counts too
    const ecmwf = fake("ecmwf", ["2026101300"], 360, { "2026101300": [12] });
    expect(totalsGap(state({ period: "total", mode: "compare", compare: "ecmwf" }), gfs, ecmwf, "2026101300")?.reach).toEqual(T("2026-10-13T06"));
    // 6-h frames and other fields don't stop the scrubber
    expect(totalsGap(state({}), gfs, null, "2026101300")).toBeNull();
    expect(totalsGap({ ...defaultState("t2m", "gfs") }, gfs, null, "2026101300")).toBeNull();
  });
});
