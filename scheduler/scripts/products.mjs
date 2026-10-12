// Writes src/products.json, what the Worker knows about each product, from the
// repo's config/: the model bar's products, each one's cycle interval and
// measured posting latency, and the workflow that updates it. Run before tests,
// type checks and deploys (wrangler's [build] command), so the Worker always
// matches the config it ships with.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

const site = read(join(repo, "config", "site.json"));
const models = readdirSync(join(repo, "config", "models"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => read(join(repo, "config", "models", f)));

const products = site.model_bar.flatMap((g) => g.products).map((id) => {
  const m = models.find((x) => id in x.products);
  if (!m) throw new Error(`config/site.json lists product ${id}, which no config/models/*.json defines`);
  if (!Number.isInteger(m.latency_minutes) || m.latency_minutes <= 0) {
    throw new Error(`product ${id}: config/models needs "latency_minutes", the measured minutes after init when a whole run is posted`);
  }
  const workflow = `${id}.yml`;
  if (!existsSync(join(repo, ".github", "workflows", workflow))) {
    throw new Error(`product ${id}: no .github/workflows/${workflow} to dispatch`);
  }
  return { id, name: m.name, workflow, cycleHours: m.cycle_interval_hours, latencyMinutes: m.latency_minutes };
});

writeFileSync(join(here, "..", "src", "products.json"), `${JSON.stringify(products, null, 2)}\n`);
