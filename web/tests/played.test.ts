import { describe, expect, it } from "vitest";
import { finishedScore, puzzleDay } from "../src/games/played";

describe("what this browser has played", () => {
  const evening = new Date(2026, 9, 22, 21); // Oct 22, 9 p.m. local: today's puzzles are Oct 21's

  it("knows today's puzzles are about yesterday, where the player is", () => {
    expect(puzzleDay(evening)).toBe("2026-10-21");
    expect(puzzleDay(new Date(2026, 0, 1, 8))).toBe("2025-12-31");
  });

  it("reads today's score once a game is finished", () => {
    const saved = (days: object) => JSON.stringify(days);
    expect(finishedScore(saved({ "2026-10-21": { guesses: [], score: 4734 } }), evening)).toBe(4734);
    expect(finishedScore(saved({ "2026-10-21": { picks: [0, 1], score: 0 } }), evening)).toBe(0);
    // Not finished, another day, or nothing readable: not done
    expect(finishedScore(saved({ "2026-10-21": { picks: [0, null] } }), evening)).toBeNull();
    expect(finishedScore(saved({ "2026-10-20": { score: 3 } }), evening)).toBeNull();
    expect(finishedScore(null, evening)).toBeNull();
    expect(finishedScore("{not json", evening)).toBeNull();
  });
});
