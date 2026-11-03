import type { LastRun } from "./freshness";

/**
 * The daily games' workflow, started at fixed times of day.
 *
 * Unlike a product, the games have no manifest to say they're behind: each run
 * makes the day that ended last night. GitHub started the workflow's 10:30Z
 * cron 3.5 to 6.5 hours late on 2026-10-24 to 26, so the day's puzzles reached
 * players around midday Eastern; this Worker starts it on time, and the
 * workflow's crons stay as backups.
 */
export const GAMES_WORKFLOW = "games.yml";

export interface GamesStart {
  /** Minutes after 00Z. */
  at: number;
  /** The day's first try: Beat the Models waits for a later run before leaving out a model it can't read. */
  firstTry: boolean;
}

/** 10:30Z, once the day has ended in the Lower 48 and its reports are in, then the 12:45Z backup. In order. */
export const GAMES_STARTS: GamesStart[] = [
  { at: 10 * 60 + 30, firstTry: true },
  { at: 12 * 60 + 45, firstTry: false },
];

const MINUTE = 60_000;

/**
 * The start to make now: today's latest start that's due, unless the workflow
 * has run since it was (whatever started that run); else null. A start that
 * couldn't be made is tried again each tick, and a later start replaces it.
 */
export function gamesStartDue(now: Date, last: LastRun | null, starts: GamesStart[] = GAMES_STARTS): { at: Date; firstTry: boolean } | null {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const due = starts
    .map((s) => ({ at: new Date(midnight + s.at * MINUTE), firstTry: s.firstTry }))
    .filter((s) => s.at <= now)
    .at(-1);
  if (!due || (last && last.createdAt >= due.at)) return null;
  return due;
}
