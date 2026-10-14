import { describe, expect, it } from "vitest";
import { defaultState, FIRST_VISIT, parseState, rememberable, serializeState } from "../src/state";

describe("URL state", () => {
  it("round-trips a jet view, giving the valid time", () => {
    const s = { ...defaultState("jet"), run: "2026100818", lag: 24, fhr: 120, isotachs: [100, 150], limitMode: "auto" as const, overlays: ["arrows", "older"] };
    const url = serializeState(s, "2026100818");
    expect(url).toBe("?m=gfs&r=na&v=jet&mode=trend&run=2026100818&lag=24&t=2026101318&iso=100,150&ov=arrows,older&lim=auto");
    expect(parseState(url)).toEqual({ ...s, valid: "2026101318" });
  });

  it("remembers a view without its run and time, and opens first visits on 500 mb over Mainland US", () => {
    expect(rememberable("?m=ecmwf&r=northeast&v=t2m&mode=trend&run=2026101200&lag=24&t=2026101300&ov=none&lim=fixed&c=gfs&crun=same"))
      .toBe("?m=ecmwf&r=northeast&v=t2m&mode=trend&lag=24&ov=none&lim=fixed&c=gfs");
    expect(parseState(FIRST_VISIT)).toMatchObject({ view: "h500", mode: "fcst", region: "us", product: "gfs" });
  });

  it("leaves the latest run unpinned, so a link follows the newest", () => {
    const s = { ...defaultState("h500"), fhr: 24 };
    const url = serializeState(s, "2026101200");
    expect(url).not.toContain("run=");
    expect(url).toContain("t=2026101300");
    expect(parseState("?run=latest&f=72")).toMatchObject({ run: null, fhr: 72 });
  });

  it("round-trips a temperature view with a variable", () => {
    const s = { ...defaultState("t2m"), mode: "trend" as const, variable: "dewpt", overlays: [] };
    const url = serializeState(s, "2026100818");
    expect(url).toContain("v=t2m");
    expect(url).toContain("var=dewpt");
    expect(url).toContain("ov=none");
    expect(url).not.toContain("iso=");
    expect(url).not.toContain("f=");
    // Latest run: unpinned, the valid time comes back for the app to place in the newest run
    expect(parseState(url)).toEqual({ ...s, valid: "2026100818" });
  });

  it("round-trips a region and compare mode", () => {
    const s = { ...defaultState("h500"), region: "northeast", mode: "compare" as const, compare: "ecmwf", compareView: "diff" as const, fhr: 48 };
    const url = serializeState(s, "2026100900");
    expect(url).toContain("r=northeast");
    expect(url).toContain("mode=compare");
    expect(url).toContain("c=ecmwf&cv=diff");
    expect(parseState(url)).toEqual({ ...s, fhr: 0, valid: "2026101100" });
    expect(serializeState({ ...s, mode: "fcst" }, "2026100900")).not.toContain("cv=");
    expect(parseState("?r=atlantis&c=ukmo&cv=wide")).toMatchObject({ region: "na", compare: null, compareView: "side" });
  });

  it("round-trips the compared model's run, and drops it when it's the newest", () => {
    const s = { ...defaultState("h500"), mode: "compare" as const, compare: "ecmwf", compareRun: "same" };
    expect(serializeState(s, "2026101200")).toContain("crun=same");
    expect(parseState("?mode=compare&crun=2026101100").compareRun).toBe("2026101100");
    expect(parseState("?mode=compare&crun=yesterday").compareRun).toBe("latest");
    expect(serializeState({ ...s, compareRun: "latest" }, "2026101200")).not.toContain("crun");
  });

  it("opens links from before the tabs as the GFS jet trend", () => {
    const s = parseState("?run=2026100818&lag=24&f=120&iso=100,150&lim=auto");
    expect(s).toMatchObject({ product: "gfs", region: "na", view: "jet", mode: "trend", lag: 24, fhr: 120, valid: null, isotachs: [100, 150], limitMode: "auto", overlays: ["arrows"] });
  });

  it("opens Phase 1 links (m and f) at the same forecast hour", () => {
    const s = parseState("?m=ecmwf&v=h500&mode=fcst&run=2026100900&lag=12&f=48");
    expect(s).toMatchObject({ product: "ecmwf", view: "h500", run: "2026100900", lag: 12, fhr: 48, valid: null });
    // ...and the new URL gives the same moment as a valid time
    expect(serializeState(s, "2026100900")).toContain("t=2026101100");
  });

  it("takes the valid time over f, and leaves it to the app without a run", () => {
    expect(parseState("?run=2026100900&f=12&t=2026101000")).toMatchObject({ fhr: 24, valid: "2026101000" });
    expect(parseState("?t=2026101000")).toMatchObject({ run: null, fhr: 0, valid: "2026101000" });
    // Past the model's range: the app clamps it with a note
    expect(parseState("?m=ecmwf&run=2026100900&t=2026102500")).toMatchObject({ fhr: 0, valid: "2026102500" });
    expect(parseState("?t=20261340xx").valid).toBeNull();
  });

  it("round-trips other products, with their own lags and hours", () => {
    const s = { ...defaultState("h500", "ecmwf"), run: "2026100900", lag: 12, fhr: 360 };
    expect(serializeState(s, "2026100900")).toContain("?m=ecmwf&r=na&v=h500&");
    expect(parseState(serializeState(s, "2026100900"))).toEqual({ ...s, valid: "2026102400" });
    // ECMWF has no 6-hour lag (00/12Z runs only) and stops at F360; GFS goes to F384
    expect(parseState("?m=ecmwf&lag=6&f=384")).toMatchObject({ product: "ecmwf", lag: 48, fhr: 0 });
    expect(parseState("?m=aifs&lag=6&f=360")).toMatchObject({ product: "aifs", lag: 6, fhr: 360 });
    expect(parseState("?m=gfs&f=384").fhr).toBe(384);
    expect(parseState("?m=ukmo&v=t850")).toMatchObject({ product: "gfs", view: "t850" });
  });

  it("uses per-view defaults", () => {
    expect(defaultState("jet")).toMatchObject({ view: "jet", mode: "trend", lag: 48, fhr: 0, isotachs: [100], overlays: ["arrows"], region: "na", compare: null, compareView: "side" });
    expect(defaultState("t2m")).toMatchObject({ mode: "fcst", variable: "temp", overlays: ["freeze"] });
    expect(defaultState("wind10")).toMatchObject({ mode: "fcst", variable: "speed", overlays: ["barbs", "isobars", "centers"] });
    expect(defaultState("precip")).toMatchObject({ mode: "fcst", variable: "all", period: "6h", overlays: ["isobars", "centers"] });
    expect(defaultState("h500")).toMatchObject({ mode: "fcst", overlays: ["heights"] });
    expect(defaultState("t850")).toMatchObject({ mode: "fcst", overlays: ["zero"] });
  });

  it("ignores invalid values", () => {
    const s = parseState("?v=radar&mode=hindcast&var=x&run=abc&lag=36&f=7&iso=100,95,999&ov=bogus,arrows&lim=wild");
    expect(s).toEqual({ ...defaultState("jet"), isotachs: [100], overlays: ["arrows"] });
    expect(parseState("?v=precip&var=dewpt").variable).toBe("all");
    expect(parseState("?v=precip&acc=week").period).toBe("6h");
    expect(parseState("?v=t2m&acc=24h").period).toBe("6h"); // only views with totals take a period
    expect(parseState("?f=247").fhr).toBe(0);
    expect(parseState("?f=390").fhr).toBe(0);
  });

  it("accepts 50 and 60 kt isotachs", () => {
    expect(parseState("?iso=50,60,100").isotachs).toEqual([50, 60, 100]);
  });

  it("keeps precipitation's shading and period in links (Phase 3.8)", () => {
    const s = parseState("?m=ecmwf&v=precip&var=snow&acc=total&t=2026101300");
    expect(s).toMatchObject({ product: "ecmwf", view: "precip", variable: "snow", period: "total" });
    const url = serializeState(s, "2026101200");
    expect(url).toContain("var=snow");
    expect(url).toContain("acc=total");
    expect(parseState(url)).toMatchObject({ variable: "snow", period: "total" });
    // Old links open on 6-h precipitation by type, as before
    expect(parseState("?v=precip")).toMatchObject({ variable: "all", period: "6h" });
    // Other views don't carry a period
    expect(serializeState(defaultState("t2m"), "2026101200")).not.toContain("acc=");
  });
});
