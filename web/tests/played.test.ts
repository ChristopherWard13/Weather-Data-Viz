import { describe, expect, it } from "vitest";
import { finishedScore, puzzleDay } from "../src/games/played";

describe("what this browser has played", () => {
  const at = (iso: string) => new Date(iso);

  it("knows the newest puzzle changes over at the 10:30Z publish, the same everywhere", () => {
    // The Oct 22 puzzle publishes at 10:30Z on Oct 23
    expect(puzzleDay(at("2026-10-23T10:29Z"))).toBe("2026-10-21");
    expect(puzzleDay(at("2026-10-23T10:30Z"))).toBe("2026-10-22");
    // 2 a.m. in New York (06Z) and the Sydney evening (09Z) still have Oct 21's
    expect(puzzleDay(at("2026-10-23T06:00Z"))).toBe("2026-10-21");
    expect(puzzleDay(at("2026-10-23T09:00Z"))).toBe("2026-10-21");
    // Late evening in Los Angeles (Oct 23, 23:00 PDT = Oct 24 06Z) is still Oct 22's
    expect(puzzleDay(at("2026-10-24T06:00Z"))).toBe("2026-10-22");
    expect(puzzleDay(at("2026-01-01T11:00Z"))).toBe("2025-12-31");
  });

  it("reads today's score once a game is finished", () => {
    const now = at("2026-10-22T21:00Z"); // the newest puzzle is Oct 21's
    const saved = (days: object) => JSON.stringify(days);
    expect(finishedScore(saved({ "2026-10-21": { guesses: [], score: 4734, max: 5000 } }), now)).toEqual({ score: 4734, max: 5000 });
    expect(finishedScore(saved({ "2026-10-21": { picks: [0, 1], score: 0, max: 2 } }), now)).toEqual({ score: 0, max: 2 });
    // A day saved before the maximum was
    expect(finishedScore(saved({ "2026-10-21": { guesses: [], score: 812 } }), now)).toEqual({ score: 812, max: null });
    // Not finished, another day, or nothing readable: not done
    expect(finishedScore(saved({ "2026-10-21": { picks: [0, null] } }), now)).toBeNull();
    expect(finishedScore(saved({ "2026-10-20": { score: 3 } }), now)).toBeNull();
    expect(finishedScore(null, now)).toBeNull();
    expect(finishedScore("{not json", now)).toBeNull();
  });
});
