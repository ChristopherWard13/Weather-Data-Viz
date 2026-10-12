/**
 * Starts each product's update workflow once its next cycle is due.
 *
 * GitHub drops and delays scheduled runs (on 2026-10-12 a third of the crons
 * fired, hours late), so this Worker is the trigger and the workflows' own
 * crons are the backup. Every 10 minutes it reads each product's manifest,
 * dispatches the workflow of any product whose next cycle should be posted by
 * now, and opens an issue when one stays behind for hours (closing it once the
 * product catches up). See docs/build-plan.md, Phase 3.5 M1.
 */
import products from "./products.json";
import {
  BACKOFF_MIN, reconcileIssues, shouldDispatch, statusOf, type ProductInfo, type Status,
} from "./freshness";
import { GitHub, installationToken, staleMarker } from "./github";
import { latestRun } from "./manifest";

export interface Env {
  /** "owner/name" of the repo whose workflows it starts. */
  REPO: string;
  /** Where product manifests are served, ending in "/". */
  DATA_BASE: string;
  SCHEDULER_APP_ID: string;
  /** The App's private key, as downloaded (PKCS#1 PEM). */
  SCHEDULER_APP_KEY: string;
}

type Fetch = typeof fetch;

/** One product's line in the tick's log. */
export interface Outcome {
  product: string;
  latest: string | null;
  behind: boolean;
  action: "fresh" | "dispatched" | "running" | "backoff" | "error";
  error?: string;
}

const fmt = (t: Date) => `${t.toISOString().slice(0, 16).replace("T", " ")}Z`;
const fmtRun = (id: string) => `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)} ${id.slice(8)}Z`;

function issueText(s: Status, repo: string, now: Date): { title: string; body: string } {
  const p = s.product;
  return {
    title: `Stale data: ${p.name}`,
    body: [
      `${p.name}'s ${fmtRun(s.next!)} run was due by ${fmt(s.due!)} ` +
        `(about ${Math.round(p.latencyMinutes / 6) / 10} h after init) and still isn't on the site at ${fmt(now)}. ` +
        `The site shows the ${fmtRun(s.latest!)} run.`,
      "",
      `The scheduler starts the \`${p.workflow}\` workflow every ${BACKOFF_MIN} minutes while it's behind. ` +
        `Recent runs: https://github.com/${repo}/actions/workflows/${p.workflow}`,
      "",
      "This issue closes itself when the run arrives.",
      "",
      staleMarker(p.id),
    ].join("\n"),
  };
}

export async function tick(env: Env, now: Date, fetchFn: Fetch = fetch, list: ProductInfo[] = products): Promise<Outcome[]> {
  const read = await Promise.allSettled(list.map((p) => latestRun(env.DATA_BASE, p.id, fetchFn)));
  const outcomes: Outcome[] = [];
  const statuses: Status[] = [];
  read.forEach((r, i) => {
    if (r.status === "fulfilled") statuses.push(statusOf(list[i], r.value, now));
    else outcomes.push({ product: list[i].id, latest: null, behind: false, action: "error", error: String(r.reason) });
  });

  const token = await installationToken(env.SCHEDULER_APP_ID, env.SCHEDULER_APP_KEY, env.REPO, now, fetchFn);
  const gh = new GitHub(token, env.REPO, fetchFn);

  for (const s of statuses) {
    const base = { product: s.product.id, latest: s.latest, behind: s.behind };
    if (!s.behind) {
      outcomes.push({ ...base, action: "fresh" });
      continue;
    }
    try {
      const last = await gh.lastRun(s.product.workflow);
      if (shouldDispatch(s, last, now)) {
        await gh.dispatch(s.product.workflow);
        outcomes.push({ ...base, action: "dispatched" });
      } else {
        outcomes.push({ ...base, action: last && last.status !== "completed" ? "running" : "backoff" });
      }
    } catch (e) {
      outcomes.push({ ...base, action: "error", error: String(e) });
    }
  }

  const issues = reconcileIssues(statuses, await gh.staleIssues());
  for (const s of issues.open) {
    const { title, body } = issueText(s, env.REPO, now);
    await gh.openIssue(title, body);
  }
  for (const i of issues.close) {
    const s = statuses.find((x) => x.product.id === i.product)!;
    await gh.closeIssue(i.number, `${s.product.name} caught up: the site now has the ${fmtRun(s.latest!)} run.`);
  }
  return outcomes;
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      tick(env, new Date()).then((outcomes) => {
        for (const o of outcomes) console.log(JSON.stringify(o));
        const failed = outcomes.filter((o) => o.action === "error");
        // A thrown error marks the invocation failed in Cloudflare's logs
        if (failed.length) throw new Error(`${failed.length} product(s) failed: ${failed.map((o) => o.product).join(", ")}`);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
