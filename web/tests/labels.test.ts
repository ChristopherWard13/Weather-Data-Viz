import { describe, expect, it } from "vitest";
import { placeLabels, STATES_SPAN, TIER2_SPAN } from "../src/labels";

// A flat lon/lat-to-pixel map: 10 px a degree over 130°W–60°W, 20°N–55°N
const project = (lon: number, lat: number): [number, number] => [(lon + 130) * 10, (55 - lat) * 10];
const measure = (text: string, size: number) => text.length * size * 0.55;

describe("map labels (Q7)", () => {
  it("show only the big cities at continental zoom", () => {
    const { states, cities } = placeLabels(project, 700, 350, 60, measure);
    expect(states).toEqual([]);
    const names = cities.map((c) => c.name);
    expect(names).toContain("Chicago");
    expect(names).not.toContain("Albany");
    expect(cities.every((c) => c.tier === 1)).toBe(true);
  });

  it("add state abbreviations and smaller cities when zoomed in", () => {
    const { states, cities } = placeLabels(project, 700, 350, Math.min(STATES_SPAN, TIER2_SPAN) - 1, measure);
    expect(states.map((s) => s.code)).toContain("KS");
    expect(cities.some((c) => c.tier === 2)).toBe(true);
  });

  it("never overlap, and stay on the canvas", () => {
    const { states, cities } = placeLabels(project, 700, 350, 20, measure);
    const rects = [
      ...states.map((s) => ({ x0: s.x - measure(s.code, s.size) / 2, x1: s.x + measure(s.code, s.size) / 2, y0: s.y - s.size / 2, y1: s.y + s.size / 2 })),
      ...cities.map((c) => {
        const w = measure(c.name, c.size) + 7;
        return c.align === "left"
          ? { x0: c.x - 3, x1: c.x + w, y0: c.y - c.size * 0.6, y1: c.y + c.size * 0.6 }
          : { x0: c.x - w, x1: c.x + 3, y0: c.y - c.size * 0.6, y1: c.y + c.size * 0.6 };
      }),
    ];
    for (const r of rects) {
      expect(r.x0).toBeGreaterThanOrEqual(0);
      expect(r.x1).toBeLessThanOrEqual(700);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1, `${i} and ${j}`).toBe(false);
      }
    }
  });

  it("scale with the canvas, so fewer fit", () => {
    const one = placeLabels(project, 700, 350, 20, measure, 1);
    const big = placeLabels(project, 700, 350, 20, measure, 2);
    expect(big.cities[0].size).toBe(one.cities[0].size * 2);
    expect(big.cities.length).toBeLessThan(one.cities.length);
  });
});
