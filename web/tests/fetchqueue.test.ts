import { describe, expect, it } from "vitest";
import { Dropped, FetchQueue } from "../src/fetchqueue";

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
  it("runs at most `limit` downloads at once, and starts the next as one finishes", async () => {
    const c = controlled();
    const q = new FetchQueue(c.fetcher, 2, 0);
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

  it("starts what the map needs now, then the preloads nearest the viewer's time", async () => {
    const c = controlled();
    const q = new FetchQueue(c.fetcher, 1, 0);
    q.focus(0, "v");
    q.fetch("busy", 0, false);
    q.focus(24 * H, "v");
    for (const [u, h] of [["far", 60], ["near", 30], ["behind", 18]] as const) q.fetch(u, h * H, false);
    q.fetch("target", 24 * H, true);
    for (const u of ["busy", "target", "near", "behind"]) await c.finish(u);
    expect(c.started).toEqual(["busy", "target", "near", "behind", "far"]);
  });

  it("re-ranks waiting downloads when the viewer moves; an old target becomes an ordinary one", async () => {
    const c = controlled();
    const q = new FetchQueue(c.fetcher, 1, 0);
    q.focus(0, "v");
    q.fetch("busy", 0, false);
    q.fetch("f06", 6 * H, true);
    q.fetch("f48", 48 * H, false);
    q.fetch("f54", 54 * H, false);
    q.focus(54 * H, "v");
    await c.finish("busy");
    expect(c.started).toEqual(["busy", "f54"]);
    await c.finish("f54");
    expect(c.started.at(-1)).toBe("f48");
  });

  it("drops waiting preloads of a view the viewer left, but never a download the map asked for", async () => {
    const c = controlled();
    const q = new FetchQueue(c.fetcher, 1, 0);
    q.focus(0, "500 mb");
    q.fetch("busy", 0, false);
    const dropped: string[] = [];
    const pre = q.fetch("pre", 6 * H, false, () => dropped.push("pre"));
    const asked = q.fetch("asked", 0, true, () => dropped.push("asked"));
    q.focus(0, "temperature");
    expect(dropped).toEqual(["pre"]);
    await expect(pre).rejects.toBeInstanceOf(Dropped);
    await c.finish("busy");
    await c.finish("asked");
    await expect(asked).resolves.toHaveProperty("ok", true);
    expect(c.started).toEqual(["busy", "asked"]);
  });

  it("keeps preloads of the same view when only the time changes", () => {
    const c = controlled();
    const q = new FetchQueue(c.fetcher, 1, 0);
    q.focus(0, "v");
    q.fetch("busy", 0, false);
    q.fetch("pre", 6 * H, false);
    q.focus(6 * H, "v");
    expect(q.queued).toBe(1);
  });

  it("promotes a waiting preload the map now needs, and shares one download per URL", async () => {
    const c = controlled();
    const q = new FetchQueue(c.fetcher, 1, 0);
    q.focus(0, "v");
    q.fetch("busy", 0, false);
    q.fetch("near", 6 * H, false).catch(() => {}); // dropped below
    const far = q.fetch("far", 90 * H, false);
    q.promote("far");
    expect(q.fetch("far", 90 * H, true)).toBe(far);
    // Promoted, so it can't be dropped either
    q.focus(0, "other view");
    await c.finish("busy");
    expect(c.started).toEqual(["busy", "far"]);
  });

  it("keeps the reserved slots for the frame the map is waiting for", async () => {
    const c = controlled();
    const q = new FetchQueue(c.fetcher, 3, 2);
    q.focus(0, "v");
    for (const [u, h] of [["p1", 6], ["p2", 12]] as const) q.fetch(u, h * H, false);
    expect(c.started).toEqual(["p1"]); // one slot for preloads
    q.fetch("target", 0, true);
    expect(c.started).toEqual(["p1", "target"]);
    q.fetch("target2", 0, true);
    expect(c.started).toEqual(["p1", "target", "target2"]);
    await c.finish("p1");
    expect(c.started.at(-1)).toBe("p2");
  });

  it("passes an HTTP error through as a status, and frees the slot", async () => {
    const q = new FetchQueue((async () => new Response("", { status: 503 })) as unknown as typeof fetch, 1, 0);
    q.focus(0, "v");
    await expect(q.fetch("a", 0, true)).resolves.toEqual({ ok: false, status: 503, body: null });
    await expect(q.fetch("b", 0, true)).resolves.toHaveProperty("status", 503);
    expect(q.active).toBe(0);
  });
});
