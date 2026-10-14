import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProductInfo } from "../src/freshness";
import { clearTokenCache, staleMarker } from "../src/github";
import { tick, type Env } from "../src/index";
import products from "../src/products.json";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }) as string;
const env: Env = { REPO: "o/r", DATA_BASE: "https://data.test/", SCHEDULER_APP_ID: "1", SCHEDULER_APP_KEY: key };

const P = (id: string, cycleHours = 6, latencyMinutes = 300): ProductInfo =>
  ({ id, name: id.toUpperCase(), workflow: `${id}.yml`, cycleHours, latencyMinutes });
const list = [P("fresh"), P("behind"), P("running"), P("backoff"), P("late"), P("broken"), P("new")];

const now = new Date("2026-10-12T19:30:00Z");
// Each product's latest run: 06Z's successor (12Z) is due 17:00Z; 00Z's (06Z) was due 11:00Z
const latest: Record<string, string | null> = {
  fresh: "2026101212", behind: "2026101206", running: "2026101206", backoff: "2026101206", late: "2026101200",
};
const lastRuns: Record<string, { status: string; created_at: string } | undefined> = {
  running: { status: "in_progress", created_at: "2026-10-12T19:20:00Z" },
  backoff: { status: "completed", created_at: "2026-10-12T19:15:00Z" },
  late: { status: "completed", created_at: "2026-10-12T18:00:00Z" },
};

interface Call { method: string; url: string; body?: unknown }
let calls: Call[];
let openIssues: { number: number; body: string; pull_request?: object }[];

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  const m = url.match(/^https:\/\/data\.test\/([a-z]+)\/manifest\.json$/);
  if (m) {
    if (m[1] === "broken") return new Response("oops", { status: 500 });
    if (!(m[1] in latest)) return new Response("not found", { status: 404 });
    return new Response(`{"schema_version": 3, "fields": {}, "latest": "${latest[m[1]]}", "runs": []}`);
  }
  const path = url.replace("https://api.github.com", "");
  if (path === "/repos/o/r/installation") return json({ id: 42 });
  if (path === "/app/installations/42/access_tokens") return json({ token: "t0k", expires_at: "2026-10-12T21:00:00Z" });
  const runs = path.match(/^\/repos\/o\/r\/actions\/workflows\/([a-z]+)\.yml\/runs\?per_page=1$/);
  if (runs) return json({ workflow_runs: lastRuns[runs[1]] ? [lastRuns[runs[1]]] : [] });
  if (/\/dispatches$/.test(path)) return new Response(null, { status: 204 });
  if (path === "/repos/o/r/issues?state=open&per_page=100") return json(openIssues);
  if (path === "/repos/o/r/issues" && method === "POST") return json({ number: 99 }, 201);
  if (/\/issues\/\d+(\/comments)?$/.test(path)) return json({});
  return new Response(`unexpected ${method} ${url}`, { status: 418 });
}) as typeof fetch;

beforeEach(() => {
  calls = [];
  openIssues = [
    { number: 5, body: `stale\n${staleMarker("fresh")}` }, // caught up: closes
    { number: 6, body: `stale\n${staleMarker("broken")}` }, // unreadable manifest: left alone
    { number: 7, body: "someone else's issue" },
    { number: 8, body: staleMarker("behind"), pull_request: {} }, // a PR, not an issue
  ];
  clearTokenCache();
});

describe("tick", () => {
  it("dispatches what's behind, waits on what's running, and reconciles issues", async () => {
    const out = await tick(env, now, fakeFetch, list);
    const by = Object.fromEntries(out.map((o) => [o.product, o.action]));
    expect(by).toEqual({
      fresh: "fresh", behind: "dispatched", running: "running", backoff: "backoff", late: "dispatched",
      broken: "error", new: "dispatched",
    });

    const dispatched = calls.filter((c) => c.url.endsWith("/dispatches"));
    expect(dispatched.map((c) => c.url.split("/").at(-2))).toEqual(["behind.yml", "late.yml", "new.yml"]);
    expect(dispatched[0].body).toEqual({ ref: "main" });

    // Only "late" is hours past due (06Z was due 11:00Z): one issue, naming the run and the workflow
    const opened = calls.filter((c) => c.method === "POST" && c.url.endsWith("/repos/o/r/issues"));
    expect(opened).toHaveLength(1);
    const issue = opened[0].body as { title: string; body: string; labels: string[] };
    expect(issue.title).toBe("Stale data: LATE");
    expect(issue.labels).toEqual(["stale-data"]);
    expect(issue.body).toContain("2026-10-12 06Z run was due by 2026-10-12 11:00Z");
    expect(issue.body).toContain("The site shows the 2026-10-12 00Z run.");
    expect(issue.body).toContain("https://github.com/o/r/actions/workflows/late.yml");
    expect(issue.body).toContain(staleMarker("late"));

    // Only the caught-up product's issue closes
    expect(calls.filter((c) => /\/issues\/\d+/.test(c.url)).map((c) => `${c.method} ${c.url.split("/issues/")[1]}`))
      .toEqual(["POST 5/comments", "PATCH 5"]);
  });

  it("reuses the installation token while it's valid", async () => {
    await tick(env, now, fakeFetch, list);
    await tick(env, new Date(now.getTime() + 10 * 60_000), fakeFetch, list);
    expect(calls.filter((c) => c.url.endsWith("/access_tokens"))).toHaveLength(1);
  });
});

describe("products.json", () => {
  it("covers every product with its workflow and a measured latency", () => {
    expect(products.map((p) => p.id)).toEqual(["gfs", "ecmwf", "aifs", "aigfs", "gefs", "ecmwf-ens", "aigefs", "hgefs"]);
    for (const p of products) {
      expect(p.workflow).toBe(`${p.id}.yml`);
      expect(p.latencyMinutes).toBeGreaterThan(0);
      expect([6, 12]).toContain(p.cycleHours);
    }
  });
});
