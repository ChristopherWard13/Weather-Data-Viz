import { describe, expect, it } from "vitest";
import { gamesStartDue } from "../src/games";

const at = (iso: string) => new Date(`${iso}Z`);
const ran = (iso: string) => ({ status: "completed", createdAt: at(iso) });

describe("gamesStartDue", () => {
  it("is nothing before 10:30Z, whatever ran yesterday", () => {
    expect(gamesStartDue(at("2026-10-27T10:29"), ran("2026-10-26T12:50"))).toBeNull();
    expect(gamesStartDue(at("2026-10-27T00:10"), null)).toBeNull();
  });

  it("is the first try from 10:30Z until a run is made", () => {
    expect(gamesStartDue(at("2026-10-27T10:30"), ran("2026-10-26T18:51"))).toEqual({ at: at("2026-10-27T10:30"), firstTry: true });
    expect(gamesStartDue(at("2026-10-27T11:20"), null)).toEqual({ at: at("2026-10-27T10:30"), firstTry: true });
    expect(gamesStartDue(at("2026-10-27T11:20"), ran("2026-10-27T10:30:05"))).toBeNull();
  });

  it("counts a run whatever started it, such as one by hand", () => {
    expect(gamesStartDue(at("2026-10-27T10:40"), ran("2026-10-27T10:35"))).toBeNull();
  });

  it("skips to the backup, a last try, once it's due", () => {
    // A first try that was never made is replaced by the backup, not made late
    expect(gamesStartDue(at("2026-10-27T12:50"), ran("2026-10-26T18:51"))).toEqual({ at: at("2026-10-27T12:45"), firstTry: false });
    expect(gamesStartDue(at("2026-10-27T12:50"), ran("2026-10-27T10:30:05"))).toEqual({ at: at("2026-10-27T12:45"), firstTry: false });
    expect(gamesStartDue(at("2026-10-27T23:50"), ran("2026-10-27T12:50:03"))).toBeNull();
  });
});
