// Fails when any product is far past due, for .github/workflows/freshness.yml's
// daily run. It backs up the scheduler Worker: if the Worker stops (or loses
// its App key), products fall behind and nothing opens an issue, but a failed
// scheduled workflow still gets GitHub to send an email. Run with Node's type
// stripping: `node scripts/watchdog.ts` after scripts/products.mjs.
import { appendFileSync } from "node:fs";
import products from "../src/products.json" with { type: "json" };
import { statusOf, type ProductInfo } from "../src/freshness.ts";
import { latestRun } from "../src/manifest.ts";

const LIMIT_HOURS = 12;
const base = process.env.DATA_BASE ?? "https://data.runtorunwx.com/";
const now = new Date();

const rows: string[] = [];
let failed = 0;
for (const p of products as ProductInfo[]) {
  let line: string;
  try {
    const s = statusOf(p, await latestRun(base, p.id), now);
    const late = s.due ? (now.getTime() - s.due.getTime()) / 3600e3 : Infinity;
    const bad = late > LIMIT_HOURS;
    failed += Number(bad);
    line = `| ${p.name} | ${s.latest ?? "none"} | ${s.due?.toISOString().slice(0, 16) ?? "—"}Z | ${bad ? `**${late.toFixed(1)} h late**` : late > 0 ? `${late.toFixed(1)} h late` : "fresh"} |`;
  } catch (e) {
    failed++;
    line = `| ${p.name} | — | — | **${String(e)}** |`;
  }
  rows.push(line);
}

const table = ["| Product | Latest run | Next run due | State |", "|---|---|---|---|", ...rows].join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
if (failed) {
  console.error(`${failed} product(s) more than ${LIMIT_HOURS} h past due, or unreadable`);
  process.exit(1);
}
