import { describe, expect, it } from "vitest";
import { defaultState, parseState, serializeState } from "../src/state";

describe("URL state", () => {
  it("round-trips", () => {
    const s = { run: "2026100818", lag: 24, fhr: 120, isotachs: [100, 150], limitMode: "auto" as const };
    expect(serializeState(s)).toBe("?run=2026100818&lag=24&f=120&iso=100,150&lim=auto");
    expect(parseState(serializeState(s))).toEqual(s);
  });

  it("uses defaults for an empty query", () => {
    expect(parseState("")).toEqual(defaultState());
    expect(defaultState()).toMatchObject({ lag: 48, fhr: 0, isotachs: [100], limitMode: "fixed", run: null });
  });

  it("ignores invalid values", () => {
    const s = parseState("?run=abc&lag=36&f=7&iso=100,95,999&lim=wild");
    expect(s).toEqual({ ...defaultState(), isotachs: [100] });
    expect(parseState("?f=246").fhr).toBe(0); // beyond the display range
    expect(parseState("?f=-6").fhr).toBe(0);
  });

  it("supports no isotachs", () => {
    const s = parseState("?iso=none");
    expect(s.isotachs).toEqual([]);
    expect(serializeState(s)).toContain("iso=none");
  });

  it("dedupes and sorts isotachs", () => {
    expect(parseState("?iso=150,100,150").isotachs).toEqual([100, 150]);
  });
});
