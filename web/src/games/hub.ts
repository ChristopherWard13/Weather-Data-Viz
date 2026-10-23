// The Weather Games landing page at /play/: the four free games, each marked
// done, with today's score, once its puzzle is finished in this browser.
import "../styles.css";
import "./games.css";
import "./hub.css";
import { finishedScore, type Finished } from "./played";

/** How each built game shows a finished day's score; days saved without a maximum had five rounds. */
const SHOW: Record<string, (r: Finished) => string> = {
  spot: (r) => `${r.score.toLocaleString("en-US")} / ${(r.max ?? 5000).toLocaleString("en-US")}`,
  measured: (r) => `${r.score}/${r.max ?? 5} right`,
};

const cards = [...document.querySelectorAll<HTMLElement>(".hub-card[data-game]")];
/** Each card's Play button, to put back if a game stops counting as done (a new puzzle is out). */
const play = new Map(cards.map((card) => [card, [...card.querySelector(".hub-status")!.childNodes]]));

function update(): void {
  let played = 0;
  for (const card of cards) {
    const game = card.dataset.game!;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(`rtr:game:${game}`);
    } catch {
      raw = null;
    }
    const result = finishedScore(raw);
    const status = card.querySelector(".hub-status")!;
    if (result === null) {
      delete card.dataset.done;
      status.replaceChildren(...play.get(card)!);
      continue;
    }
    played += 1;
    card.dataset.done = "true";
    const done = document.createElement("span");
    done.className = "hub-done fx";
    done.textContent = "Done ✓";
    const pts = document.createElement("span");
    pts.className = "hub-score fx";
    pts.textContent = SHOW[game]?.(result) ?? String(result.score);
    status.replaceChildren(done, pts);
  }
  document.getElementById("hub-played")!.textContent = `${played}/${cards.length}`;
}

update();
// Back from a game can restore this page as it was (the back-forward cache), and a game finished in
// another tab changes storage: either way, read the results again
addEventListener("pageshow", (e) => e.persisted && update());
addEventListener("storage", (e) => e.key?.startsWith("rtr:game:") && update());
