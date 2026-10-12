import { describe, expect, it } from "vitest";
import { defaultState, parseState, serializeState } from "../src/state";

describe("URL state", () => {
  it("round-trips a jet view", () => {
    const s = { ...defaultState("jet"), run: "2026100818", lag: 24, fhr: 120, isotachs: [100, 150], limitMode: "auto" as const, overlays: ["arrows", "older"] };
    expect(serializeState(s)).toBe("?m=gfs&v=jet&mode=trend&run=2026100818&lag=24&f=120&iso=100,150&ov=arrows,older&lim=auto");
    expect(parseState(serializeState(s))).toEqual(s);
  });

  it("round-trips a temperature view with a variable", () => {
    const s = { ...defaultState("t2m"), mode: "trend" as const, variable: "dewpt", overlays: [] };
    const url = serializeState(s);
    expect(url).toContain("v=t2m");
    expect(url).toContain("var=dewpt");
    expect(url).toContain("ov=none");
    expect(url).not.toContain("iso=");
    expect(parseState(url)).toEqual(s);
  });

  it("opens links from before the tabs as the GFS jet trend", () => {
    const s = parseState("?run=2026100818&lag=24&f=120&iso=100,150&lim=auto");
    expect(s).toMatchObject({ product: "gfs", view: "jet", mode: "trend", lag: 24, fhr: 120, isotachs: [100, 150], limitMode: "auto", overlays: ["arrows"] });
  });

  it("round-trips other products, with their own lags and hours", () => {
    const s = { ...defaultState("h500", "ecmwf"), lag: 12, fhr: 360 };
    expect(serializeState(s)).toContain("?m=ecmwf&v=h500&");
    expect(parseState(serializeState(s))).toEqual(s);
    // ECMWF has no 6-hour lag (00/12Z runs only) and stops at F360; GFS goes to F384
    expect(parseState("?m=ecmwf&lag=6&f=384")).toMatchObject({ product: "ecmwf", lag: 48, fhr: 0 });
    expect(parseState("?m=aifs&lag=6&f=360")).toMatchObject({ product: "aifs", lag: 6, fhr: 360 });
    expect(parseState("?m=gfs&f=384").fhr).toBe(384);
    expect(parseState("?m=ukmo&v=t850")).toMatchObject({ product: "gfs", view: "t850" });
  });

  it("uses per-view defaults", () => {
    expect(defaultState("jet")).toMatchObject({ view: "jet", mode: "trend", lag: 48, fhr: 0, isotachs: [100], overlays: ["arrows"] });
    expect(defaultState("t2m")).toMatchObject({ mode: "fcst", variable: "temp", overlays: ["freeze"] });
    expect(defaultState("wind10")).toMatchObject({ mode: "fcst", variable: "speed", overlays: ["barbs", "isobars", "centers"] });
    expect(defaultState("precip")).toMatchObject({ mode: "fcst", variable: "", overlays: ["isobars", "centers"] });
    expect(defaultState("h500")).toMatchObject({ mode: "fcst", overlays: ["heights"] });
    expect(defaultState("t850")).toMatchObject({ mode: "fcst", overlays: ["zero"] });
  });

  it("ignores invalid values", () => {
    const s = parseState("?v=radar&mode=hindcast&var=x&run=abc&lag=36&f=7&iso=100,95,999&ov=bogus,arrows&lim=wild");
    expect(s).toEqual({ ...defaultState("jet"), isotachs: [100], overlays: ["arrows"] });
    expect(parseState("?v=precip&var=dewpt").variable).toBe("");
    expect(parseState("?f=247").fhr).toBe(0);
    expect(parseState("?f=390").fhr).toBe(0);
  });

  it("accepts 50 and 60 kt isotachs", () => {
    expect(parseState("?iso=50,60,100").isotachs).toEqual([50, 60, 100]);
  });
});
