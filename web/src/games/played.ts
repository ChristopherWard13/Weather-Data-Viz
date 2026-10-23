// What this browser has played: the Weather Games landing page marks a game
// done once today's puzzle is finished. Each game saves its days under
// rtr:game:<game>, with a `score` once every round is played.

/** The day today's puzzles are about: yesterday, where the player is ("YYYY-MM-DD"). */
export function puzzleDay(now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Today's score from a game's saved days (localStorage's raw text), or null if it isn't finished. */
export function finishedScore(raw: string | null, now = new Date()): number | null {
  if (!raw) return null;
  try {
    const days: unknown = JSON.parse(raw);
    const day = days && typeof days === "object" ? (days as Record<string, { score?: unknown }>)[puzzleDay(now)] : null;
    return typeof day?.score === "number" ? day.score : null;
  } catch {
    return null;
  }
}
