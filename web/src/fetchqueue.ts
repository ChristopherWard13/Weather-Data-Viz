/**
 * Every frame download goes through one queue, so preloading can't swamp the
 * frame the viewer is waiting for. A frame the map needs now starts at once,
 * however many others are running (a total can need a hundred). Preloads run
 * a few at a time, nearest the valid time the viewer is on first, re-ranked
 * as the viewer moves; those for a view the viewer has left are dropped
 * before they start.
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
  seq: number;
  promise: Promise<Fetched>;
  resolve: (f: Fetched) => void;
  reject: (e: unknown) => void;
  /** Called (synchronously) when the job is dropped, so a cache can forget it before anyone asks again. */
  onDrop?: () => void;
}

export class FetchQueue {
  /** Preloads not started yet. */
  private waiting = new Map<string, Job>();
  private running = 0;
  private preloading = 0;
  private focusValid = 0;
  private tag = "";
  private seq = 0;

  constructor(
    private fetcher: typeof fetch = (...a) => fetch(...a),
    private preloadLimit = 4,
  ) {
    if (!(preloadLimit >= 1)) throw new Error(`preloadLimit must be at least 1, not ${preloadLimit}`);
  }

  /** Downloads started and not finished (for tests and debugging). */
  get active(): number {
    return this.running;
  }

  /** Preloads waiting to start. */
  get queued(): number {
    return this.waiting.size;
  }

  /** The viewer is on `valid` (ms) in the view `tag`: waiting preloads of another view are dropped. */
  focus(valid: number, tag: string): void {
    this.focusValid = valid;
    if (tag === this.tag) return;
    this.tag = tag;
    for (const [url, j] of this.waiting) {
      if (j.tag === tag) continue;
      this.waiting.delete(url);
      j.onDrop?.();
      j.reject(new Dropped());
    }
  }

  /** Download `url`: now, for the frame being drawn (`urgent`), or as a preload. */
  fetch(url: string, valid: number, urgent: boolean, onDrop?: () => void): Promise<Fetched> {
    const had = this.waiting.get(url);
    if (had) {
      // A second asker (a cache that evicted and asked again) is told about a drop too
      if (onDrop) {
        const first = had.onDrop;
        had.onDrop = first ? () => (first(), onDrop()) : onDrop;
      }
      if (urgent) this.promote(url);
      return had.promise;
    }
    let resolve!: (f: Fetched) => void, reject!: (e: unknown) => void;
    const promise = new Promise<Fetched>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job: Job = { url, valid, tag: this.tag, seq: this.seq++, promise, resolve, reject, onDrop };
    if (urgent) this.start(job, false);
    else {
      this.waiting.set(url, job);
      this.pump();
    }
    return promise;
  }

  /** A waiting preload is now needed for the frame being drawn: start it. */
  promote(url: string): void {
    const j = this.waiting.get(url);
    if (!j) return;
    this.waiting.delete(url);
    this.start(j, false);
  }

  /** Start the nearest waiting preloads while there's room for them. */
  private pump(): void {
    while (this.preloading < this.preloadLimit && this.waiting.size) {
      let best: Job | null = null, bestDist = Infinity;
      for (const j of this.waiting.values()) {
        const d = Math.abs(j.valid - this.focusValid);
        if (d < bestDist || (d === bestDist && j.seq < best!.seq)) {
          best = j;
          bestDist = d;
        }
      }
      this.waiting.delete(best!.url);
      this.start(best!, true);
    }
  }

  private start(j: Job, preload: boolean): void {
    this.running++;
    if (preload) this.preloading++;
    // A preload's slot is held until the body has arrived, not just the headers
    this.fetcher(j.url)
      .then(async (res): Promise<Fetched> => ({ ok: res.ok, status: res.status, body: res.ok ? await res.arrayBuffer() : null }))
      .then(j.resolve, j.reject)
      .finally(() => {
        this.running--;
        if (preload) {
          this.preloading--;
          this.pump();
        }
      });
  }
}

/** The queue every model's frames share: the downloads all go to one host. */
export const frameQueue = new FetchQueue();
