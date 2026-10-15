import { describe, expect, it } from "vitest";
import { Dropped, FetchQueue, keyOf } from "../src/fetchqueue";

const H = 3600e3;

/** A fetcher whose responses the test releases one URL at a time. */
function controlled() {
  const started: string[] = [];
  const pending = new Map<string, () => void>();
  const fetcher = (url: string) => {
    started.push(url);
    return new Promise<Response>((resolve) => pending.set(url, () => resolve(new Response(url))));
  };
  const finish = async (url: string) => {
    pending.get(url)!();
    pending.delete(url);
    // Let the body read and the next download start
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { started, finish, fetcher: fetcher as unknown as typeof fetch };
}

describe("FetchQueue", () => {
  it("runs at most `preloadLimit` preloads at once, and starts the next as one finishes", async () => {
    const c = controlled();
    const q = new FetchQueue(c.fetcher, 2);
    q.focus(0, "v");
    const all = ["a", "b", "c", "d"].map((u, i) => q.fetch(u, i * H, false));
    expect(c.started).toEqual(["a", "b"]);
    expect(q.queued).toBe(2);
    await c.finish("a");
    expect(c.started).toEqual(["a", "b", "c"]);
    for (const u of ["b", "c", "d"]) await c.finish(u);
    const bodies = await Promise.all(all.map(async (p) => new TextDecoder().decode((await p).body!)));
    expect(bodies).toEqual(["a", "b", "c", "d"]);
  });

  it("starts what the map needs at once, however many preloads are running", () => {
    const c = controlled();
    const q = new FetchQueue(c.fetcher, 1);
    q.focus(0, "v");
    q.fetch("pre1", 6 * H, false);
    q.fetch("pre2", 12 * H, false);
    // A total needs every hour of its window: all of them start together
    for (let h = 0; h < 30; h += 6) q.fetch(`total${h}`, h * H, true);
    expect(c.started).toEqual(["pre1", "total0", "total6", "total12", "total18", "total24"]);
    expect(q.active).toBe(6);
  });

  it("starts the preloads nearest the viewer's time first, re-ranked when the viewer moves", async () => {
    const c = controlled();
    const q = new FetchQueue(c.fetcher, 1);
    q.focus(24 * H, "v");
    q.fetch("busy", 24 * H, false);
    for (const [u, h] of [["far", 60], ["near", 30], ["behind", 18], ["f54", 54]] as const) q.fetch(u, h * H, false);
    await c.finish("busy");
    expect(c.started.at(-1)).toBe("near");
    q.focus(54 * H, "v");
    await c.finish("near");
    expect(c.started.at(-1)).toBe("f54");
    await c.finish("f54");
    expect(c.started.at(-1)).toBe("far");
  });

  it("drops waiting preloads of a view the viewer left", async () => {
    const c = controlled();
    const q = new FetchQueue(c.fetcher, 1);
    q.focus(0, "500 mb");
    q.fetch("busy", 0, false);
    const dropped: string[] = [];
    const pre = q.fetch("pre", 6 * H, false, () => dropped.push("pre"));
    q.focus(0, "temperature");
    expect(dropped).toEqual(["pre"]);
    await expect(pre).rejects.toBeInstanceOf(Dropped);
    expect(q.queued).toBe(0);
  });

  it("keeps preloads of the same view when only the time changes", () => {
    const c = controlled();
    const q = new FetchQueue(c.fetcher, 1);
    q.focus(0, "v");
    q.fetch("busy", 0, false);
    q.fetch("pre", 6 * H, false);
    q.focus(6 * H, "v");
    expect(q.queued).toBe(1);
  });

  it("starts a waiting preload at once when the map needs it, as one download", async () => {
    const c = controlled();
    const q = new FetchQueue(c.fetcher, 1);
    q.focus(0, "v");
    q.fetch("busy", 0, false);
    const far = q.fetch("far", 90 * H, false);
    expect(c.started).toEqual(["busy"]);
    expect(q.fetch("far", 90 * H, true)).toBe(far);
    expect(c.started).toEqual(["busy", "far"]);
    // Started, so a change of view can't drop it
    q.focus(0, "other view");
    await c.finish("far");
    await expect(far).resolves.toHaveProperty("ok", true);
  });

  it("promote() starts a waiting preload at once", () => {
    const c = controlled();
    const q = new FetchQueue(c.fetcher, 1);
    q.focus(0, "v");
    q.fetch("busy", 0, false);
    q.fetch("next", 6 * H, false);
    q.promote("next");
    expect(c.started).toEqual(["busy", "next"]);
    expect(q.queued).toBe(0);
  });

  it("tells every asker of a waiting preload when it's dropped", () => {
    const c = controlled();
    const q = new FetchQueue(c.fetcher, 1);
    q.focus(0, "v");
    q.fetch("busy", 0, false);
    const told: string[] = [];
    q.fetch("pre", 6 * H, false, () => told.push("first")).catch(() => {});
    q.fetch("pre", 6 * H, false, () => told.push("second")).catch(() => {});
    q.focus(0, "w");
    expect(told).toEqual(["first", "second"]);
  });

  it("refuses a preload limit that would never start a preload", () => {
    expect(() => new FetchQueue(fetch, 0)).toThrow(/at least 1/);
  });

  it("passes an HTTP error through as a status, and frees the slot", async () => {
    const q = new FetchQueue((async () => new Response("", { status: 503 })) as unknown as typeof fetch, 1);
    q.focus(0, "v");
    await expect(q.fetch("a", 0, false)).resolves.toEqual({ ok: false, status: 503, body: null });
    await expect(q.fetch("b", 0, false)).resolves.toHaveProperty("status", 503);
    expect(q.active).toBe(0);
  });

  it("downloads byte ranges of one URL as separate downloads, each once", async () => {
    const seen: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen.push(`${url} ${(init?.headers as Record<string, string> | undefined)?.Range ?? "whole"}`);
      return new Response("x", { status: init ? 206 : 200 });
    }) as unknown as typeof fetch;
    const q = new FetchQueue(fetcher, 1);
    q.focus(0, "v");
    const a = q.fetch({ url: "f.bin", range: [0, 4095] }, 0, true);
    q.fetch("busy", 0, false); // holds the one preload slot
    const b = q.fetch({ url: "f.bin", range: [4096, 5000] }, 0, false);
    expect(q.fetch({ url: "f.bin", range: [4096, 5000] }, 0, false)).toBe(b); // waiting: the same download
    q.fetch("f.bin", 0, true);
    await expect(a).resolves.toHaveProperty("status", 206);
    await b;
    expect(seen.sort()).toEqual(["busy whole", "f.bin bytes=0-4095", "f.bin bytes=4096-5000", "f.bin whole"]);
    expect(keyOf({ url: "f.bin", range: [1, 2] })).toBe("f.bin#1-2");
    expect(keyOf({ url: "f.bin" })).toBe(keyOf("f.bin"));
  });
});
