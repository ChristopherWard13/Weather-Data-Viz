// The games' arcade tally: a round's numbers count up from zero and its stamp
// and tiles pop in (games.css's `.fresh`), once, when the round is decided.

export const fmt = (n: number) => n.toLocaleString("en-US");

/** A number that counts up in the next tally(); it shows its final value until then. */
export function countUp(n: number, cls = ""): HTMLElement {
  const b = document.createElement("b");
  if (cls) b.className = cls;
  b.textContent = fmt(n);
  b.dataset.count = String(n);
  return b;
}

const MS = 700;

/**
 * Play the tally on what was just rendered into `root`: its countUp() numbers
 * from zero, and its `.fresh` animations. Not when motion is reduced. A screen
 * reader waits for the final numbers: the live region around `root` is busy
 * until they're shown.
 */
export function tally(root: HTMLElement): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const nums = [...root.querySelectorAll<HTMLElement>("[data-count]")];
  const live = root.closest<HTMLElement>("[aria-live]");
  live?.setAttribute("aria-busy", "true");
  let t0: number | null = null;
  const step = (now: number) => {
    // Time from the first frame: a frame's timestamp can be earlier than the call that asked for it
    t0 ??= now;
    const f = Math.min(1, (now - t0) / MS);
    const ease = 1 - (1 - f) ** 3;
    for (const n of nums) if (n.isConnected) n.textContent = fmt(Math.round(Number(n.dataset.count) * ease));
    if (f < 1) requestAnimationFrame(step);
    else live?.removeAttribute("aria-busy");
  };
  requestAnimationFrame(step);
  root.classList.remove("fresh");
  void root.offsetWidth;
  root.classList.add("fresh");
}
