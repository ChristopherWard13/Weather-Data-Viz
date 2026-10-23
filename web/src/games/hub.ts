// The Weather Games landing page at /play/: the four free games, each marked
// done, with today's score, once its puzzle is finished in this browser.
import "../styles.css";
import "./games.css";
import "./hub.css";
import { finishedScore } from "./played";

/** How each built game shows a finished day's score. */
const SHOW: Record<string, (score: number) => string> = {
  spot: (s) => `${s.toLocaleString("en-US")} / 5,000`,
  measured: (s) => `${s}/5 right`,
};

let played = 0;
const cards = [...document.querySelectorAll<HTMLElement>(".hub-card[data-game]")];
for (const card of cards) {
  const game = card.dataset.game!;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(`rtr:game:${game}`);
  } catch {
    raw = null;
  }
  const score = finishedScore(raw);
  if (score === null) continue;
  played += 1;
  card.dataset.done = "true";
  const status = card.querySelector(".hub-status")!;
  const done = document.createElement("span");
  done.className = "hub-done fx";
  done.textContent = "Done ✓";
  const pts = document.createElement("span");
  pts.className = "hub-score fx";
  pts.textContent = SHOW[game]?.(score) ?? String(score);
  status.replaceChildren(done, pts);
}
document.getElementById("hub-played")!.textContent = `${played}/${cards.length}`;
