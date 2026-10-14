/**
 * Every frame download goes through one queue, so a fast scrub can't start
 * dozens at once. A few run at a time; the next to start is one the map needs
 * now, then the one nearest the valid time the viewer is on. Preloads never
 * take the last `reserved` slots, so the frame the map is waiting for starts
 * at once. Preloads for a view the viewer has left are dropped before they
 * start; requests the map asked for never are.
 */

/** A download finished: its status, and the body if it succeeded. */
export interface Fetched {
  ok: boolean;
  status: number;
  body: ArrayBuffer | null;
}

/** A preload dropped because the viewer left its view. */
export class Dropped extends Error {
  constructor() {
    super("dropped: the view changed");
  }
}

interface Job {
  url: string;
  /** Valid time (ms) the download is for: preloads go nearest-first from the viewer's. */
  valid: number;
  /** The view it was preloaded for. */
  tag: string;
  /** The focus generation it was last needed for drawing in, or -1 for a preload. */
  urgent: number;
  seq: number;
  promise: Promise<Fetched>;
  resolve: (f: Fetched) => void;
  reject: (e: unknown) => void;
  /** Called (synchronously) when the job is dropped, so a cache can forget it before anyone asks again. */
  onDrop?: () => void;
}

export class FetchQueue {
  private waiting = new Map<string, Job>();
  private running = 0;
  private preloading = 0;
  private gen = 0;
  private focusValid = 0;
  private tag = "";
  private seq = 0;

  constructor(
    private fetcher: typeof fetch = (...a) => fetch(...a),
    private limit = 6,
    private reserved = 2,
  ) {}

  /** Downloads started and not finished (for tests and debugging). */
  get active(): number {
    return this.running;
  }

  /** Downloads waiting to start. */
  get queued(): number {
    return this.waiting.size;
  }

  /**
   * The viewer is drawing `valid` (ms) in the view `tag`. Requests marked
   * urgent from now on go first; waiting preloads of another view are dropped.
   */
  focus(valid: number, tag: string): void {
    this.gen++;
    this.focusValid = valid;
    if (tag === this.tag) return;
    this.tag = tag;
    for (const [url, j] of this.waiting) {
      if (j.urgent >= 0 || j.tag === tag) continue;
      this.waiting.delete(url);
      j.onDrop?.();
      j.reject(new Dropped());
    }
  }

  /** Download `url`, for the frame being drawn (`urgent`) or ahead of time. */
  fetch(url: string, valid: number, urgent: boolean, onDrop?: () => void): Promise<Fetched> {
    const had = this.waiting.get(url);
    if (had) {
      if (urgent) had.urgent = this.gen;
      return had.promise;
    }
    let resolve!: (f: Fetched) => void, reject!: (e: unknown) => void;
    const promise = new Promise<Fetched>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.waiting.set(url, { url, valid, tag: this.tag, urgent: urgent ? this.gen : -1, seq: this.seq++, promise, resolve, reject, onDrop });
    this.pump();
    return promise;
  }

  /** A waiting download is now needed for the frame being drawn. */
  promote(url: string): void {
    const j = this.waiting.get(url);
    if (j) j.urgent = this.gen;
  }

  /** Lower sorts first: needed now, then nearest the viewer's valid time, then oldest. */
  private rank(j: Job): number {
    return j.urgent === this.gen ? -1 : Math.abs(j.valid - this.focusValid);
  }

  private pump(): void {
    while (this.running < this.limit && this.waiting.size) {
      let best: Job | null = null, bestRank = Infinity;
      for (const j of this.waiting.values()) {
        const r = this.rank(j);
        if (r < bestRank || (r === bestRank && j.seq < best!.seq)) {
          best = j;
          bestRank = r;
        }
      }
      const j = best!;
      // Only preloads are waiting, and their share of the slots is taken
      const preload = bestRank >= 0;
      if (preload && this.preloading >= this.limit - this.reserved) return;
      this.waiting.delete(j.url);
      this.running++;
      if (preload) this.preloading++;
      // The slot is held until the body has arrived, not just the headers
      this.fetcher(j.url)
        .then(async (res): Promise<Fetched> => ({ ok: res.ok, status: res.status, body: res.ok ? await res.arrayBuffer() : null }))
        .then(j.resolve, j.reject)
        .finally(() => {
          this.running--;
          if (preload) this.preloading--;
          this.pump();
        });
    }
  }
}

/** The queue every model's frames share: the downloads all go to one host. */
export const frameQueue = new FetchQueue();
