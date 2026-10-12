import type { LastRun, StaleIssue } from "./freshness";
import { pemToPkcs8 } from "./pem";

const API = "https://api.github.com";
type Fetch = typeof fetch;

const headers = (auth: string): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${auth}`,
  "User-Agent": "runtorunwx-scheduler",
  "X-GitHub-Api-Version": "2022-11-28",
});

async function call(fetchFn: Fetch, auth: string, method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetchFn(`${API}${path}`, {
    method,
    headers: { ...headers(auth), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

/** The App's JWT (RS256, valid 9 minutes, backdated a minute for clock drift). */
export async function appJwt(appId: string, pem: string, now: Date): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const t = Math.floor(now.getTime() / 1000);
  const unsigned = `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson({ iat: t - 60, exp: t + 540, iss: appId })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

// Kept while the isolate lives, so most ticks skip signing (tokens last an hour)
let cached: { repo: string; token: string; expires: number } | null = null;

/** An installation token for the App on `repo` ("owner/name"), reused until 5 minutes before it expires. */
export async function installationToken(appId: string, pem: string, repo: string, now: Date, fetchFn: Fetch = fetch): Promise<string> {
  if (cached && cached.repo === repo && cached.expires - now.getTime() > 5 * 60_000) return cached.token;
  const jwt = await appJwt(appId, pem, now);
  const inst = (await (await call(fetchFn, jwt, "GET", `/repos/${repo}/installation`)).json()) as { id: number };
  const tok = (await (await call(fetchFn, jwt, "POST", `/app/installations/${inst.id}/access_tokens`)).json()) as {
    token: string;
    expires_at: string;
  };
  cached = { repo, token: tok.token, expires: Date.parse(tok.expires_at) };
  return tok.token;
}

/** Forget the cached token (tests). */
export function clearTokenCache(): void {
  cached = null;
}

const MARKER = /<!-- scheduler:stale:([a-z0-9-]+) -->/;
export const staleMarker = (product: string) => `<!-- scheduler:stale:${product} -->`;

/** The calls the scheduler makes on the repo, as the App's installation. */
export class GitHub {
  constructor(private token: string, private repo: string, private fetchFn: Fetch = fetch) {}

  private call(method: string, path: string, body?: unknown) {
    return call(this.fetchFn, this.token, method, `/repos/${this.repo}${path}`, body);
  }

  async lastRun(workflow: string): Promise<LastRun | null> {
    const res = await this.call("GET", `/actions/workflows/${workflow}/runs?per_page=1`);
    const run = ((await res.json()) as { workflow_runs: { status: string; created_at: string }[] }).workflow_runs[0];
    return run ? { status: run.status, createdAt: new Date(run.created_at) } : null;
  }

  async dispatch(workflow: string): Promise<void> {
    await this.call("POST", `/actions/workflows/${workflow}/dispatches`, { ref: "main" });
  }

  /** Open issues the scheduler opened, found by the marker in their body. */
  async staleIssues(): Promise<StaleIssue[]> {
    const res = await this.call("GET", "/issues?state=open&per_page=100");
    const issues = (await res.json()) as { number: number; body: string | null; pull_request?: unknown }[];
    return issues.flatMap((i) => {
      const m = !i.pull_request && i.body?.match(MARKER);
      return m ? [{ number: i.number, product: m[1] }] : [];
    });
  }

  async openIssue(title: string, body: string): Promise<void> {
    await this.call("POST", "/issues", { title, body, labels: ["stale-data"] });
  }

  async closeIssue(number: number, comment: string): Promise<void> {
    await this.call("POST", `/issues/${number}/comments`, { body: comment });
    await this.call("PATCH", `/issues/${number}`, { state: "closed", state_reason: "completed" });
  }
}
