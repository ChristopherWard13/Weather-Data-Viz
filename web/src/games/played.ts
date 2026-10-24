// What this browser has played: the Weather Games landing page marks a game
// done once today's puzzle is finished. Each game saves its days under
// rtr:game:<game>, with a `score` once every round is played; Beat the Models
// saves a day's `call`, and is done once the newest day has one.

/**
 * When the daily games publish: games.yml runs at 10:30Z and makes the day
 * before (the newest day ended everywhere in the Lower 48). Its backup at
 * 12:45Z only reruns a day that failed.
 */
const PUBLISH_UTC_MS = (10 * 60 + 30) * 60_000;
const DAY_MS = 86_400_000;

/**
 * The newest puzzle's day ("YYYY-MM-DD"): the UTC day before the latest
 * 10:30Z. It's the same everywhere: a player in Sydney or at 2 a.m. in New
 * York still has the previous day's puzzle until 10:30Z.
 */
export function puzzleDay(now = new Date()): string {
  return new Date(now.getTime() - PUBLISH_UTC_MS - DAY_MS).toISOString().slice(0, 10);
}

/**
 * Beat the Models' newest puzzle's day: it's published with the others at
 * 10:30Z, but for the day after the one that's starting, so two days on from
 * theirs.
 */
export function beatDay(now = new Date()): string {
  return new Date(now.getTime() - PUBLISH_UTC_MS + DAY_MS).toISOString().slice(0, 10);
}

/** The high called for Beat the Models' newest puzzle (localStorage's raw text), or null. */
export function calledHigh(raw: string | null, now = new Date()): number | null {
  if (!raw) return null;
  try {
    const days: unknown = JSON.parse(raw);
    const day = days && typeof days === "object" ? (days as Record<string, { call?: unknown }>)[beatDay(now)] : null;
    return typeof day?.call === "number" ? day.call : null;
  } catch {
    return null;
  }
}

/** A finished day: its score, and the most it could have been (saved with it; absent before 2026-10-23). */
export interface Finished {
  score: number;
  max: number | null;
}

/** Today's result from a game's saved days (localStorage's raw text), or null if it isn't finished. */
export function finishedScore(raw: string | null, now = new Date()): Finished | null {
  if (!raw) return null;
  try {
    const days: unknown = JSON.parse(raw);
    const day = days && typeof days === "object"
      ? (days as Record<string, { score?: unknown; max?: unknown }>)[puzzleDay(now)] : null;
    if (typeof day?.score !== "number") return null;
    return { score: day.score, max: typeof day.max === "number" ? day.max : null };
  } catch {
    return null;
  }
}
