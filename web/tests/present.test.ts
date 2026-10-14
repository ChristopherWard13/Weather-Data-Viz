import { describe, expect, it } from "vitest";
import {
  barsShared, creditLine, frameSize, layoutFrame, SHORTS_SAFE, SILHOUETTES, silhouetteById, slotCount, type Rect,
} from "../src/compose";
import { parsePresent, presentSearch, slotQuery } from "../src/present";
import { fieldName, runName, slotBar, type SlotBar, type SlotFrame } from "../src/slot";
import { defaultState, parseState } from "../src/state";
import type { Product } from "../src/sources";

const inside = (r: Rect, w: number, h: number) => r.x >= 0 && r.y >= 0 && r.x + r.w <= w + 1e-6 && r.y + r.h <= h + 1e-6;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A slot's frame, for the credit line (only what it reads). */
const credited = (credit: string) => ({ product: { cfg: { credit } }, other: null }) as unknown as SlotFrame;
const units = { speed: "kt" as const, temp: "F" as const };
const product = (precipType = true) => ({ cfg: { precipType } }) as unknown as Product;
const bar = (s: Parameters<typeof slotBar>[0], slot = 0, typed = true) => slotBar(s, product(typed), units, slot);
const vortState = { ...defaultState("h500", "gfs"), mode: "fcst" as const, variable: "vort" };
const vort: SlotBar = bar(vortState);
const precip: SlotBar = bar({ ...defaultState("precip", "gfs"), mode: "fcst" });

describe("presentation frames", () => {
  it("are exactly 1920 × 1080 or 1080 × 1920", () => {
    expect(frameSize("16:9")).toEqual({ w: 1920, h: 1080 });
    expect(frameSize("9:16")).toEqual({ w: 1080, h: 1920 });
    expect(SILHOUETTES.map((s) => `${s.id}:${slotCount(s)}`)).toEqual(["single:1", "pair:2", "quad:4", "tall:1", "stack:2"]);
  });

  it("lay every silhouette's slots inside the frame, apart, under the header", () => {
    for (const sil of SILHOUETTES) {
      for (const frames of [new Array(slotCount(sil)).fill(vort), new Array(slotCount(sil)).fill(null), [precip, ...new Array(slotCount(sil) - 1).fill(vort)]]) {
        const l = layoutFrame(sil, frames);
        expect(inside(l.header, l.w, l.h), sil.id).toBe(true);
        l.slots.forEach((s, i) => {
          expect(inside(s.rect, l.w, l.h), `${sil.id} slot ${i}`).toBe(true);
          expect(s.rect.y).toBeGreaterThanOrEqual(l.header.y + l.header.h);
          expect(s.map.h).toBeGreaterThan(300);
          l.slots.slice(i + 1).forEach((o) => expect(overlap(s.rect, o.rect)).toBe(false));
          if (l.sharedBar) expect(s.rect.y + s.rect.h).toBeLessThanOrEqual(l.sharedBar.y);
        });
      }
    }
  });

  it("share one color bar when every slot's forecast bar is the same", () => {
    const quad = silhouetteById("quad")!;
    expect(layoutFrame(quad, [vort, vort, vort, vort]).sharedBar).not.toBeNull();
    const mixed = layoutFrame(quad, [vort, precip, vort, vort]);
    expect(mixed.sharedBar).toBeNull();
    expect(mixed.slots.every((s) => s.bar)).toBe(true);
    // Each slot gives the tallest bar the same room, so the maps line up
    expect(new Set(mixed.slots.map((s) => s.map.h)).size).toBe(1);
    // Heights and vorticity, °F and °C, typed and untyped precipitation: different bars
    expect(barsShared([vort, bar({ ...vortState, variable: "hgt" })])).toBe(false);
    expect(barsShared([precip, bar({ ...defaultState("precip", "aigfs"), mode: "fcst" }, 1, false)])).toBe(false);
    expect(slotBar(defaultState("t2m", "gfs"), product(), units, 0).key).not.toBe(slotBar(defaultState("t2m", "gfs"), product(), { ...units, temp: "C" }, 0).key);
  });

  it("never share trend or difference bars: their captions name the runs", () => {
    const trend = { ...vortState, mode: "trend" as const };
    expect(barsShared([bar(trend, 0), bar(trend, 1)])).toBe(false);
    expect(barsShared([bar({ ...vortState, mode: "compare", compare: "ecmwf" }, 0), bar({ ...vortState, mode: "compare", compare: "ecmwf" }, 1)])).toBe(false);
  });

  it("hold the layout still whether or not a slot drew (its run ending mid-loop)", () => {
    // The layout comes from the slots' views, so it's the same at every time of a loop
    const pair = silhouetteById("pair")!;
    const a = layoutFrame(pair, [bar(defaultState("t2m", "gfs")), vort]);
    const b = layoutFrame(pair, [bar(defaultState("t2m", "gfs")), vort]);
    expect(a).toEqual(b);
    expect(a.sharedBar).toBeNull();
  });

  it("keep a 9:16 frame's titles and color bar clear of Shorts' buttons and captions", () => {
    for (const id of ["tall", "stack"]) {
      const l = layoutFrame(silhouetteById(id)!, id === "tall" ? [vort] : [vort, vort]);
      expect(l.header.y).toBeGreaterThanOrEqual(SHORTS_SAFE.top);
      expect(l.header.x).toBeGreaterThanOrEqual(SHORTS_SAFE.left);
      const bar = l.sharedBar!;
      expect(bar.y + bar.h).toBeLessThanOrEqual(l.h - SHORTS_SAFE.bottom);
      expect(bar.x).toBeGreaterThanOrEqual(SHORTS_SAFE.left);
      expect(bar.x + bar.w).toBeLessThanOrEqual(l.w - SHORTS_SAFE.right);
      expect(l.header.y + l.header.h).toBeLessThan(SHORTS_SAFE.rightFrom); // the buttons start below the header
    }
  });

  it("credit each source once", () => {
    expect(creditLine([credited("NOAA"), credited("ECMWF (CC BY 4.0; modified)"), credited("NOAA"), null])).toBe("Data: NOAA, ECMWF (CC BY 4.0; modified)");
    expect(creditLine([null])).toBe("");
  });
});

describe("presentation links", () => {
  it("round-trip a layout without its slots' times", () => {
    const s = { ...defaultState("h500", "ecmwf"), region: "ny", mode: "trend" as const, variable: "hgt" };
    const q = slotQuery(s, "2026101112");
    expect(q).not.toMatch(/(^|&)t=/);
    expect(q).not.toMatch(/(^|&)run=/);
    const search = presentSearch({ silhouette: "pair", slots: [q, q] }, new Date(Date.UTC(2026, 9, 14, 0)));
    const back = parsePresent(search)!;
    expect(back).toMatchObject({ silhouette: "pair", valid: "2026101400" });
    const slot = parseState(`?${back.slots[1]}`);
    expect(slot).toMatchObject({ product: "ecmwf", region: "ny", view: "h500", mode: "trend", variable: "hgt" });
  });

  it("drop a slot's pinned run, so a saved layout opens the newest runs, and ignore an unknown silhouette", () => {
    const q = slotQuery({ ...defaultState("h500", "gfs"), run: "2026101106" }, "2026101112");
    expect(q).not.toMatch(/run=/);
    expect(parsePresent("?present=six&s1=m=gfs")).toBeNull();
    expect(parsePresent("?present=quad")!.slots).toEqual(["", "", "", ""]);
  });
});

describe("slot labels", () => {
  it("name the field as a viewer would", () => {
    expect(fieldName({ view: "h500", variable: "hgt" })).toBe("500 mb heights");
    expect(fieldName({ view: "h500", variable: "vort" })).toBe("500 mb vorticity");
    expect(fieldName({ view: "wind10", variable: "gust" })).toBe("Gusts");
    expect(fieldName({ view: "t2m", variable: "temp" })).toBe("2 m temperature");
    expect(fieldName({ view: "precip", variable: "" })).toBe("6-hour precipitation");
    expect(fieldName({ view: "precip", variable: "snow", period: "6h" })).toBe("6-hour snowfall (10:1)");
    expect(fieldName({ view: "precip", variable: "snow", period: "24h" }, 18)).toBe("18-hour snowfall (10:1)");
    expect(fieldName({ view: "precip", variable: "all", period: "total" })).toBe("Total precipitation");
  });

  it("name a run by its UTC day and cycle", () => {
    expect(runName("2026101118")).toBe("Sun 18Z");
    expect(runName("2026101200")).toBe("Mon 00Z");
  });

  it("give totals and snowfall one row of bins, shared by slots showing the same", () => {
    const snow = bar({ ...defaultState("precip", "gfs"), variable: "snow" });
    const total = bar({ ...defaultState("precip", "gfs"), period: "total" }, 1);
    expect(snow.spec.kind).toBe("bins");
    expect(barsShared([snow, bar({ ...defaultState("precip", "ecmwf"), variable: "snow" }, 1)])).toBe(true);
    expect(barsShared([snow, total])).toBe(false); // snow and liquid bins differ
    expect(barsShared([total, bar({ ...defaultState("precip", "aigfs"), period: "total" }, 2, false)])).toBe(true); // untyped too: totals have no type
    // The shared caption names one period, so different periods keep their own bars
    expect(barsShared([total, bar({ ...defaultState("precip", "gfs"), period: "24h" }, 2)])).toBe(false);
    expect(barsShared([snow, bar({ ...defaultState("precip", "gfs"), variable: "snow", period: "total" }, 1)])).toBe(false);
  });
});
