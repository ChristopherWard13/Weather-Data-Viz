import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PTYPE_COLORS, PTYPE_UNSPECIFIED, rgbaOf } from "../src/palettes";

// Real pipeline output. CI uses `make e2e-data`: for each product, a pinned
// cycle and its lag runs, F000-F060 (for the NOMADS products, a frozen bundle
// of a cycle and its 12-h lag run). Every test works on that and on a full
// local dataset.
const dataRoot = process.env.WXTREND_DATA_DIR ?? fileURLToPath(new URL("../../data/", import.meta.url));
const manifestOf = (product: string) => JSON.parse(readFileSync(`${dataRoot}/${product}/manifest.json`, "utf8"));
const manifest = manifestOf("gfs");
const shot = (name: string) => fileURLToPath(new URL(`../../docs/${name}.png`, import.meta.url));

const initOf = (id: string) => new Date(Date.UTC(+id.slice(0, 4), +id.slice(4, 6) - 1, +id.slice(6, 8), +id.slice(8, 10)));
const runIdOf = (t: Date) => t.toISOString().slice(0, 13).replace(/[-T]/g, "");
/** A valid time as titles show it in UTC: "Wed 14 Oct 00Z". */
const shortZ = (t: Date) =>
  `${t.toUTCString().slice(0, 3)} ${String(t.getUTCDate()).padStart(2, "0")} ${t.toUTCString().slice(8, 11)} ${String(t.getUTCHours()).padStart(2, "0")}Z`;
const addH = (t: Date, h: number) => new Date(t.getTime() + h * 3600e3);
const hasFrame = (run: string, field: string, f: number): boolean =>
  manifest.runs.find((r: { id: string }) => r.id === run)?.hours[field]?.includes(f) ?? false;

/** The latest run's hour nearest `want` (at or below) whose `lag`-hour comparison the data has. */
function trendHour(want: number, lag: number): number {
  const older = runIdOf(new Date(initOf(manifest.latest).getTime() - lag * 3600e3));
  for (let f = want; f > 0; f -= 6) {
    if (hasFrame(manifest.latest, "wspd250", f) && hasFrame(older, "wspd250", f + lag)) return f;
  }
  return 0;
}

/** Watch a playing loop for `ms`: draws, gaps between them, hours shown, spinner, and URL writes. */
function watchPlay(page: Page, ms: number) {
  return page.evaluate(async (ms) => {
    const spinner = document.getElementById("spinner")!;
    const r0 = window.__wxtrend!.renders, t0 = performance.now(), url0 = location.search;
    let spun = false, last = r0, urlWrites = 0;
    const stamps: number[] = [];
    const hours = new Set<number>();
    while (performance.now() - t0 < ms) {
      spun ||= !spinner.hidden;
      if (location.search !== url0) urlWrites++;
      if (window.__wxtrend!.renders !== last) {
        last = window.__wxtrend!.renders;
        stamps.push(performance.now());
        hours.add(window.__wxtrend!.last!.fhr as number);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b);
    return { renders: window.__wxtrend!.renders - r0, spun, gaps, hours: [...hours], urlWrites };
  }, ms);
}

/** Collect anything that would show up as a problem in the console or network. */
// The browser's clock sits just after the data's newest run, so model chips read as
// fresh (today's run, not amber) whatever day the data was built: the screenshots
// show the site as visitors see it. Tests about lateness set their own time.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(initOf(manifest.latest).getTime() + 2 * 3600e3));
});

function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => errors.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  return errors;
}

async function ready(page: Page, frame = "delta", view?: string) {
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready");
  if (view) await expect(page.locator("#app")).toHaveAttribute("data-view", view);
  await expect(page.locator("#app")).toHaveAttribute("data-frame", frame);
}

/** The neutral ramp untyped precipitation is shaded with: grey, so `colored` doesn't count it. */
const NEUTRAL = PTYPE_COLORS[PTYPE_UNSPECIFIED].map((c) => rgbaOf(c).slice(0, 3));

/** Count shaded pixels on the map canvas by hue (`neutral`: pixels in the untyped-precipitation ramp). */
async function pixelStats(page: Page) {
  return page.evaluate((neutralRamp) => {
    // Read back through a copy so repeated reads don't trigger Chrome's readback warning.
    const c = document.getElementById("map") as HTMLCanvasElement;
    const copy = document.createElement("canvas");
    copy.width = c.width;
    copy.height = c.height;
    const cx = copy.getContext("2d", { willReadFrequently: true })!;
    cx.drawImage(c, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let red = 0, blue = 0, black = 0, violet = 0, colored = 0, neutral = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colored++;
      if (neutralRamp.some(([nr, ng, nb]) => Math.abs(r - nr) <= 2 && Math.abs(g - ng) <= 2 && Math.abs(b - nb) <= 2)) neutral++;
      if (b - g > 60 && r - g > 30 && b > 150) violet++;
      if (r - b > 40 && r - g > 25) red++;
      else if (b - r > 40) blue++;
      else if (r < 40 && g < 40 && b < 40) black++;
    }
    return { total: c.width * c.height, red, blue, black, violet, colored, neutral };
  }, NEUTRAL);
}

test("a bare URL opens 500 mb over Mainland US, then the visitor's last view", async ({ page }) => {
  const errors = watchForErrors(page);
  await page.goto("/");
  await ready(page, "forecast", "h500");
  await expect(page).toHaveURL(/m=gfs&r=us&v=h500&mode=fcst/);
  await expect(page.locator("#crumbs")).toContainText("Mainland US");
  await fieldButton(page, "Temperature").click();
  await ready(page, "forecast", "t2m");
  await page.goto("/");
  await ready(page, "forecast", "t2m");
  await expect(page).toHaveURL(/r=us&v=t2m/);
  expect(errors).toEqual([]);
});

test("renders real pipeline output with no console errors", async ({ page }) => {
  const errors = watchForErrors(page);
  // A link without a field, from before the field tabs, opens the jet trend
  await page.goto("/?f=0");
  await ready(page);

  const title = page.locator("#title");
  await expect(title).toHaveText(
    /^GFS 250 mb \|V\| trend: init \d{4}-\d\d-\d\d \d\dZ vs \d{4}-\d\d-\d\d \d\dZ \| valid \w{3} \d\d \w{3} \d\dZ \| F000$/,
  );
  // The latest run isn't pinned: a link follows whatever is newest
  expect(page.url()).not.toContain("run=");

  const px = await pixelStats(page);
  // Shading covers a real fraction of the map, with both signs present
  expect((px.red + px.blue) / px.total).toBeGreaterThan(0.03);
  expect(px.red).toBeGreaterThan(2000);
  expect(px.blue).toBeGreaterThan(2000);
  expect(px.black).toBeGreaterThan(500); // isotachs and labels
  expect(errors).toEqual([]);
});

test("header, URL and frames follow the controls", async ({ page }) => {
  const errors = watchForErrors(page);
  const frames: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/runs/")) frames.push(new URL(r.url()).pathname.split("/data/gfs/")[1]);
  });
  await page.goto("/?lag=24&f=24&iso=100,150&lim=fixed");
  await ready(page);

  const init = manifest.latest as string;
  const t0 = initOf(init);
  const fmt = (t: Date) => t.toISOString().slice(0, 13).replace("T", " ") + "Z";
  const older = new Date(t0.getTime() - 24 * 3600e3);
  const valid = new Date(t0.getTime() + 24 * 3600e3);
  await expect(page.locator("#title")).toHaveText(
    `GFS 250 mb |V| trend: init ${fmt(t0)} vs ${fmt(older)} | valid ${shortZ(valid)} | F024`,
  );
  const olderId = runIdOf(older);
  // The pair loaded: current F024 (speed and direction) and the run 24 h older at F048 (speed only)
  expect(frames).toContain(`runs/${init}/wspd250/f024.bin.gz`);
  expect(frames).toContain(`runs/${init}/wdir250/f024.bin.gz`);
  expect(frames).toContain(`runs/${olderId}/wspd250/f048.bin.gz`);
  expect(frames).not.toContain(`runs/${olderId}/wdir250/f048.bin.gz`);
  // ...and neighbours were preloaded so stepping is immediate
  await expect.poll(() => frames.includes(`runs/${init}/wspd250/f030.bin.gz`)).toBe(true);
  await expect.poll(() => frames.includes(`runs/${olderId}/wspd250/f054.bin.gz`)).toBe(true);

  const before = frames.length;
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#title")).toHaveText(/\| F030$/);
  await ready(page);
  expect(frames.slice(before).filter((f) => f.endsWith("f030.bin.gz") || f.endsWith("f054.bin.gz"))).toEqual([]);
  expect(page.url()).toContain(`t=${runIdOf(new Date(t0.getTime() + 30 * 3600e3))}`);

  await page.getByRole("radio", { name: "Auto" }).click();
  await expect(page).toHaveURL(/lim=auto/);
  const limit = Number(await page.locator("#colorbar").getAttribute("data-max"));
  expect(limit % 10).toBe(0);
  expect(limit).toBeGreaterThanOrEqual(10);

  await page.getByRole("radio", { name: "48 h" }).click();
  await expect(page).toHaveURL(/lag=48/);
  await expect(page.locator("#lag-hint")).toContainText("F078");

  await page.locator("#iso button", { hasText: "150" }).click();
  await expect(page).toHaveURL(/iso=100(&|$)/);
  expect(errors).toEqual([]);
});

test("shows a clear unavailable state instead of falling back", async ({ page }) => {
  const errors = watchForErrors(page);
  const oldest = manifest.runs[manifest.runs.length - 1].id;
  await page.goto(`/?run=${oldest}&lag=48&f=60`);
  await ready(page, "no-comparison");
  await expect(page.locator("#banner")).toBeVisible();
  await expect(page.locator("#banner")).toContainText("Comparison unavailable");
  await expect(page.locator("#banner")).toContainText("F108");
  const px = await pixelStats(page);
  expect(px.red + px.blue).toBeLessThan(px.total * 0.002); // no shading at all
  expect(errors).toEqual([]);
});

test("hover readout reports current, older, and Δ", async ({ page }) => {
  await page.goto("/?f=6");
  await ready(page);
  const box = (await page.locator("#map").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
  const tip = page.locator("#tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(/°N \d+\.\d+°W/);
  await expect(tip).toContainText(/Current \|V\|\d+ kt/);
  await expect(tip).toContainText(/Older \|V\|\d+ kt/);
  const consistent = async () => {
    const text = await tip.innerText();
    const num = (label: string) => Number(text.match(new RegExp(`${label}\\s*([+\\u2212-]?\\d+)`))![1].replace("−", "-"));
    expect(num("Current \\|V\\|") - num("Older \\|V\\|")).toBe(num("Δ"));
    return text;
  };
  const before = await consistent();
  // Stepping with the keyboard refreshes the readout under a stationary pointer
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#title")).toHaveText(/F012$/);
  await expect(tip).toBeVisible();
  await expect.poll(() => tip.innerText()).not.toBe(before);
  await consistent();
});

test("a shared link pins its run and offers the latest", async ({ page }) => {
  const errors = watchForErrors(page);
  const second = manifest.runs[1].id;
  await page.goto(`/?run=${second}&lag=6&f=24`);
  await ready(page);
  const banner = page.locator("#banner");
  await expect(banner).toContainText("A newer run");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#title")).toHaveText(/F030$/);
  await expect(banner).toBeVisible(); // stays until the run changes
  const t = new URL(page.url()).searchParams.get("t");
  await banner.getByRole("button", { name: "Show latest" }).click();
  await expect(page).not.toHaveURL(/run=/);
  await expect(banner).toBeHidden();
  // The forecast time stays; the hour counts from the latest run instead
  await expect(page).toHaveURL(new RegExp(`t=${t}`));
  const gap = (initOf(manifest.latest).getTime() - initOf(second).getTime()) / 3600e3;
  await expect(page.locator("#title")).toHaveText(new RegExp(`F${String(30 - gap).padStart(3, "0")}$`));

  // Picking an older run from the menu keeps the time too
  const third = manifest.runs[2].id;
  await page.locator("#run").selectOption(third);
  await expect(page).toHaveURL(new RegExp(`run=${third}.*t=${t}`));
  const gap3 = (initOf(manifest.latest).getTime() - initOf(third).getTime()) / 3600e3;
  await expect(page.locator("#title")).toHaveText(new RegExp(`F${String(30 - gap + gap3).padStart(3, "0")}$`));
  expect(errors).toEqual([]);
});


// Trend mode compares with the run 12 h older, whose F060 the small dataset has.
const TABS = [
  { view: "t2m", name: "Temperature", url: "/?v=t2m&f=48&lag=12", frame: "forecast", shot: "screenshot-temperature" },
  { view: "wind10", name: "Wind", url: "/?v=wind10&f=48&lag=12", frame: "forecast", shot: "screenshot-wind" },
  { view: "precip", name: "Precipitation", url: "/?v=precip&f=48&lag=12", frame: "forecast", shot: "screenshot-precip" },
  { view: "h500", name: "500 mb", url: "/?v=h500&f=48&lag=12", frame: "forecast", shot: "screenshot-500mb" },
  { view: "t850", name: "850 mb", url: "/?v=t850&f=48&lag=12", frame: "forecast", shot: "screenshot-850mb" },
];

/** A Fields sidebar button by its label. */
const fieldButton = (page: Page, name: string) => page.locator("#field-list button", { has: page.locator(".fi-name", { hasText: new RegExp(`^${name}$`) }) });
/** A model-bar chip by model name. */
const chip = (page: Page, name: string) => page.locator("#modelbar button", { has: page.locator(".mchip-name", { hasText: new RegExp(`^${name}$`) }) });

for (const tab of TABS) {
  test(`${tab.name} renders real data in forecast and trend modes`, async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto(tab.url);
    await ready(page, "forecast", tab.view);
    await expect(fieldButton(page, tab.name)).toHaveAttribute("aria-current", "true");
    await expect(page.locator("#title")).toContainText("init");
    let px = await pixelStats(page);
    expect(px.colored / px.total).toBeGreaterThan(0.02);
    await expect(page.locator("#stats")).not.toBeEmpty();

    await page.getByRole("radio", { name: "Trend" }).click();
    await ready(page, "delta", tab.view);
    await expect(page.locator("#title")).toContainText("trend: init");
    await expect(page.locator("#lag-field")).toBeVisible();
    px = await pixelStats(page);
    expect(px.red + px.blue).toBeGreaterThan(1000);
    expect(errors).toEqual([]);
  });
}

test("fields switch by click and number key, and remember their settings", async ({ page }) => {
  await page.goto("/?f=24&lag=24");
  await ready(page, "delta", "jet");
  const t = new URL(page.url()).searchParams.get("t");
  await fieldButton(page, "Gusts").click();
  await ready(page, "forecast", "wind10");
  await expect(page).toHaveURL(/v=wind10.*var=gust/);
  await expect(page.locator("#title")).toContainText("10 m wind gust");
  await page.getByLabel("Wind barbs").uncheck();
  await expect(page).toHaveURL(/ov=isobars,centers/);
  await page.keyboard.press("1");
  await ready(page, "forecast", "t2m");
  await page.keyboard.press("3");
  await ready(page, "forecast", "wind10");
  await expect(page).toHaveURL(/var=speed.*ov=isobars,centers/); // the view's overlays are remembered
  await page.keyboard.press("8");
  await ready(page, "delta", "jet");
  await expect(page).toHaveURL(new RegExp(`t=${t}`)); // the valid time carries across fields
});

test("precipitation at F000 explains why there is nothing to show", async ({ page }) => {
  await page.goto("/?v=precip&f=0");
  await ready(page, "no-frame", "precip");
  await expect(page.locator("#banner")).toContainText("starts at F006");
  await page.keyboard.press("ArrowRight");
  await ready(page, "forecast", "precip");
  await expect(page.locator("#banner")).toBeHidden();
});

// ---------------------------------------------------------------- Phase 3.8: snowfall and totals

test("snowfall at 10:1 per 6 h, 24 h and in total, offered only for models with snowfall", async ({ page }) => {
  const errors = watchForErrors(page);
  const run = manifest.latest as string;
  const init = initOf(run);
  await page.goto("/?m=gfs&v=precip&var=snow&f=48&mode=fcst");
  await ready(page, "forecast", "precip");
  await expect(page.locator("#colorbar")).toHaveAttribute("data-kind", "bins");
  await expect(page.locator(".ptype-label")).toHaveText(["Snow 10:1"]);
  await expect(page.locator("#title")).toContainText("GFS 6-h snowfall (10:1) | init");
  await expect(page.locator("#cb-caption")).toHaveText("6-h snowfall (in, 10:1 snow-to-liquid)");
  // Models with no snow output aren't offered, and the note says why
  await expect(chip(page, "AIGFS")).toBeHidden();
  await expect(chip(page, "ECMWF ENS mean")).toBeVisible();
  await expect(page.locator("#model-note")).toHaveText("Not shown: AIGFS, AIGEFS mean, HGEFS mean (no snowfall output)");
  await expect(page.locator("#explain-view")).toContainText("GFS has no snowfall field");

  // 24 h: the four 6-h amounts ending at the valid time
  await page.locator("#acc").getByRole("radio", { name: "24 h" }).click();
  await ready(page, "forecast", "precip");
  await expect(page).toHaveURL(/var=snow.*acc=24h/);
  await expect(page.locator("#title")).toContainText(`GFS 24-h snowfall (10:1) | init`);
  await expect(page.locator("#title")).toContainText(`24 h ending ${shortZ(addH(init, 48))}`);
  expect(await page.evaluate(() => window.__wxtrend!.last!.period)).toBe("24h");

  // Total: from the start of the run shown, then its trend over the same hours
  await page.locator("#acc").getByRole("radio", { name: "Total" }).click();
  await ready(page, "forecast", "precip");
  await expect(page.locator("#title")).toContainText(`GFS total snowfall (10:1) | init`);
  await expect(page.locator("#title")).toContainText(`${shortZ(init)} to ${shortZ(addH(init, 48))}`);
  await expect(page.locator("#acc-hint")).toContainText(`From ${shortZ(init)}`);
  await page.getByRole("radio", { name: "Trend" }).click();
  await page.locator("#lag").getByRole("radio", { name: "12 h" }).click();
  await ready(page, "delta", "precip");
  await expect(page.locator("#cb-caption")).toContainText("Δ total snowfall (in, 10:1)");
  await expect(page.locator("#title")).toContainText("GFS total snowfall (10:1) trend: init");

  // At the run's first hour a total has nothing in it yet
  await page.goto("/?m=gfs&v=precip&var=all&acc=total&f=0&mode=fcst");
  await ready(page, "no-frame", "precip");
  await expect(page.locator("#banner")).toContainText(`The total starts at ${shortZ(init)}`);
  await page.locator("#banner").getByRole("button", { name: "Go 6 h later" }).click();
  await ready(page, "forecast", "precip");
  await expect(page.locator("#title")).toContainText("GFS total precipitation | init");
  await expect(page.locator(".ptype-label")).toHaveText(["Liquid"]);

  // Snow asked of a model without snowfall moves to one with it, in the same group
  await page.goto("/?m=aigfs&v=precip&var=snow&f=24");
  await ready(page, "forecast", "precip");
  await expect(page.locator("#banner")).toHaveText("AIGFS doesn't output snowfall, so this shows AIFS.");
  await expect(chip(page, "AIFS")).toHaveAttribute("aria-checked", "true");
  // On AIGFS, Snow stays in its place; picking it does the same
  await page.goto("/?m=aigfs&v=precip&var=all&f=24");
  await ready(page, "forecast", "precip");
  await expect(page.locator("#shade").getByRole("radio")).toHaveText(["All precipitation", "Snow"]);
  await page.locator("#shade").getByRole("radio", { name: "Snow" }).click();
  await ready(page, "forecast", "precip");
  await expect(page.locator("#banner")).toHaveText("AIGFS doesn't output snowfall, so this shows AIFS.");
  await expect(page).toHaveURL(/m=aifs.*var=snow/);
  expect(errors).toEqual([]);
});

test("totals compare two models over the same hours, side by side and as a difference", async ({ page }) => {
  const errors = watchForErrors(page);
  await page.goto("/?m=gfs&v=precip&var=snow&acc=24h&mode=compare&c=ecmwf&cv=diff&f=48");
  await ready(page, "delta", "precip");
  await expect(page.locator("#title")).toContainText("GFS minus ECMWF: 24-hour snowfall (10:1) | valid");
  await expect(page.locator("#cb-caption")).toContainText("Δ 24-h snowfall (in, 10:1)");
  await page.goto("/?m=gfs&v=precip&var=all&acc=total&mode=compare&c=ecmwf&cv=side&f=48");
  await ready(page, "forecast", "precip");
  await expect(page.locator("#app")).toHaveAttribute("data-frame-b", "forecast");
  await expect(page.locator("#colorbar")).toHaveAttribute("data-kind", "bins");
  await expect(page.locator("#title")).toContainText("GFS vs ECMWF: total precipitation since ");
  expect(errors).toEqual([]);
});

test("totals stop the scrubber before a run's first missing 6-h amount", async ({ page }) => {
  // The CI dataset stops at F060, so F066 is missing; a full dataset may have no gap at all
  const run = manifest.runs.find((r: { id: string }) => r.id === manifest.latest);
  const have = new Set<number>(run.hours.precip);
  const max = manifest.display_hours[manifest.display_hours.length - 1];
  const gap = Array.from({ length: max / 6 }, (_, i) => (i + 1) * 6).find((f) => !have.has(f));
  test.skip(gap === undefined, "the latest GFS run has every 6-h amount");
  const errors = watchForErrors(page);
  const init = initOf(manifest.latest);
  const reach = addH(init, gap! - 6);
  // A link past the gap steps back to the last total that can be drawn, and says why
  await page.goto(`/?m=gfs&v=precip&var=all&acc=total&mode=fcst&t=${runIdOf(addH(init, gap! + 24))}`);
  await ready(page, "forecast", "precip");
  await expect(page.locator("#banner")).toContainText(`run has no 6-hour precipitation for F${String(gap).padStart(3, "0")}, so totals stop at ${shortZ(reach)}`);
  await expect(page.locator("#title")).toContainText(`to ${shortZ(reach)}`);
  await expect(page.locator("#acc-hint")).toContainText(`Totals stop at ${shortZ(reach)}`);
  // The scrubber ends there: there's no stepping forward, and the arrow key stays put
  await expect(page.locator("#next")).toBeDisabled();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#title")).toContainText(`to ${shortZ(reach)}`);
  // 6-h amounts aren't limited
  await page.locator("#acc").getByRole("radio", { name: "6 h" }).click();
  await ready(page, "forecast", "precip");
  await expect(page.locator("#next")).toBeEnabled();
  expect(errors).toEqual([]);
});

test("presentation slots share a total's window, and the header says where it starts", async ({ page }) => {
  const errors = watchForErrors(page);
  const init = initOf(manifest.latest);
  const slot = (m: string) => encodeURIComponent(`m=${m}&r=us&v=precip&var=snow&acc=total&mode=fcst`);
  await page.goto(`/?present=pair&t=${runIdOf(addH(init, 48))}&s1=${slot("gfs")}&s2=${slot("ecmwf")}`);
  await presentReady(page, 2);
  await expect(page.locator("#present")).toHaveAttribute("data-drawn", "2");
  const png = await downloadFrom(page, "#pc-png");
  expect(png.name).toBe(`runtorunwx-total-snowfall-10-1-${runIdOf(addH(init, 48))}z.png`);
  expect(pngSize(png.bytes)).toEqual([1920, 1080]);
  expect(errors).toEqual([]);
});

test("older-run isotachs draw as dashed violet lines", async ({ page }) => {
  await page.goto("/?f=12&iso=60,100");
  await ready(page);
  const before = (await pixelStats(page)).violet;
  await page.getByLabel("Older run's isotachs (dashed)").check();
  await expect(page).toHaveURL(/ov=arrows,older/);
  await ready(page);
  const after = (await pixelStats(page)).violet;
  expect(after - before).toBeGreaterThan(500);
});

test("screenshots", async ({ page }) => {
  const errors = watchForErrors(page);
  // F096 with real full data; the deepest hour the small CI dataset allows
  await page.goto(`/?lag=48&f=${trendHour(96, 48)}&iso=100,150&lim=fixed`);
  await ready(page);
  await page.screenshot({ path: shot("screenshot"), fullPage: false, scale: "css" });
  for (const tab of TABS) {
    await page.goto(tab.url);
    await ready(page, tab.frame, tab.view);
    await page.screenshot({ path: shot(tab.shot), fullPage: false, scale: "css" });
  }
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------------ other products

const VIEWS = ["jet", "t2m", "wind10", "precip", "h500", "t850"];

// Products without precipitation type (category 5, "unspecified")
const UNTYPED = new Set(["aigfs", "aigefs", "hgefs"]);

for (const product of ["ecmwf", "aifs", "aigfs", "gefs", "ecmwf-ens", "aigefs", "hgefs"]) {
  const name = manifestOf(product).model.name as string;
  test(`${name}: every view renders real data in forecast and trend modes`, async ({ page }) => {
    const errors = watchForErrors(page);
    const frames: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/runs/")) frames.push(new URL(r.url()).pathname);
    });
    const m = manifestOf(product);
    for (const view of VIEWS) {
      // 12 h lag: both products have the run 12 h older, whose F060 the small dataset has
      await page.goto(`/?m=${product}&v=${view}&f=48&lag=12&mode=fcst`);
      await ready(page, "forecast", view);
      await expect(page.locator("#app")).toHaveAttribute("data-product", product);
      await expect(page.locator("#title")).toContainText(`${name} `);
      await expect(chip(page, name)).toHaveAttribute("aria-checked", "true");
      let px = await pixelStats(page);
      // Untyped precipitation is shaded grey on purpose (it never reads as a type)
      const shaded = view === "precip" && UNTYPED.has(product) ? px.neutral : px.colored;
      expect(shaded / px.total, `${view} forecast shading`).toBeGreaterThan(0.02);

      await page.getByRole("radio", { name: "Trend" }).click();
      await ready(page, "delta", view);
      px = await pixelStats(page);
      expect(px.red + px.blue, `${view} trend shading`).toBeGreaterThan(1000);
    }
    // Frames came from this product's own directory
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.startsWith(`/data/${product}/runs/`))).toBe(true);
    // Ensemble means open 500 mb shaded by height; the others by vorticity
    const shaded500 = m.model.name.endsWith(" mean") ? "hgt500" : "vort500";
    expect(frames.some((f) => f.startsWith(`/data/${product}/runs/${m.latest}/${shaded500}/`))).toBe(true);
    // Precipitation's legend: by type, or one neutral row saying type isn't available
    await page.goto(`/?m=${product}&v=precip&f=48&mode=fcst`);
    await ready(page, "forecast", "precip");
    const untyped = UNTYPED.has(product);
    await expect(page.locator("#colorbar")).toHaveAttribute("data-kind", untyped ? "precip-untyped" : "precip");
    await expect(page.locator("#title")).toContainText(untyped ? `${name} 6-h precipitation |` : `${name} 6-h precipitation & type |`);
    if (untyped) {
      await expect(page.locator(".ptype-note")).toHaveText("Precipitation type isn't available: this model doesn't output it.");
      await expect(page.locator(".ptype-label")).toHaveText(["Precip"]);
    } else {
      await expect(page.locator(".ptype-label")).toHaveText(["Rain", "Snow", "Sleet", "Freezing rain"]);
    }
    await page.goto(`/?m=${product}&v=h500&f=48`);
    await ready(page, "forecast", "h500");
    await page.screenshot({ path: shot(`screenshot-${product}`), fullPage: false, scale: "css" });
    expect(errors).toEqual([]);
  });
}

test("ECMWF ENS mean: 500 mb without vorticity, a jet without direction, and what its mean is made of", async ({ page }) => {
  const errors = watchForErrors(page);
  await page.goto("/?m=ecmwf-ens&v=h500&f=48");
  await ready(page, "forecast", "h500");
  // Heights only: no Shading choice, and the 500 mb item keeps the model
  await expect(page.locator("#title")).toContainText("ECMWF ENS mean 500 mb height | init");
  await expect(page.locator("#shade-field")).toBeHidden();
  await expect(chip(page, "ECMWF ENS mean")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#explain-view")).toContainText("ECMWF's 50 perturbed members");

  // ECMWF's mean has 250 mb speed only: no flow arrows or barbs to offer
  await page.goto("/?m=ecmwf-ens&v=jet&f=48&mode=fcst");
  await ready(page, "forecast", "jet");
  await expect(page.locator("#app")).toHaveAttribute("data-product", "ecmwf-ens");
  await expect(page.locator("#overlays-field")).toBeHidden();
  await chip(page, "ECMWF").click();
  await ready(page, "forecast", "jet");
  await expect(page.locator("#overlays label")).toHaveText(["Flow arrows on isotachs", "Wind barbs"]);
  await expect(page.locator("#explain-view")).not.toContainText("perturbed members");

  // Compare draws the current shading on both sides: no ENS partner for vorticity, one for heights
  await page.goto("/?m=gfs&v=h500&var=vort&mode=compare&cmp=ecmwf-ens&f=48");
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#cmp option", { hasText: "ECMWF ENS mean" })).toHaveCount(0);
  await expect(page.locator("#banner")).not.toContainText("unknown field");
  await page.locator("#shade").getByRole("radio", { name: "Heights" }).click();
  await expect(page.locator("#cmp option", { hasText: "ECMWF ENS mean" })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("fields a model lacks aren't offered: dew point falls back within the group", async ({ page }) => {
  const errors = watchForErrors(page);
  await page.goto("/?m=aigfs&v=t2m&var=temp&f=24");
  await ready(page, "forecast", "t2m");
  await expect(chip(page, "AIGFS")).toHaveAttribute("aria-checked", "true");
  await fieldButton(page, "Dew point").click();
  await ready(page, "forecast", "t2m");
  // AIFS has dew point and shares AIGFS's group
  await expect(page.locator("#banner")).toHaveText("AIGFS doesn't output dew point, so this shows AIFS.");
  await expect(page.locator("#model-note")).toHaveText("Not shown: AIGFS, AIGEFS mean, HGEFS mean (no dew point output)");
  await expect(chip(page, "GEFS mean")).toBeVisible(); // derived from 2 m T and RH
  // The ensemble means fall back to GEFS mean, the one in their group with dew point
  await page.goto("/?m=hgefs&v=t2m&var=dewpt&f=24");
  await ready(page, "forecast", "t2m");
  await expect(page.locator("#banner")).toHaveText("HGEFS mean doesn't output dew point, so this shows GEFS mean.");
  await expect(page).toHaveURL(/m=gefs/);
  expect(errors).toEqual([]);
});

test("switching model keeps the field and valid time", async ({ page }) => {
  const errors = watchForErrors(page);
  await page.goto("/?v=h500&f=48");
  await ready(page, "forecast", "h500");
  const valid = (await page.locator("#title").textContent())!.match(/valid (.+?) \|/)![1];
  const t = new URL(page.url()).searchParams.get("t");
  for (const name of ["ECMWF", "AIFS", "GFS"]) {
    await chip(page, name).click();
    await expect(page.locator("#title")).toContainText(`${name} 500 mb`);
    await ready(page, "forecast", "h500");
    await expect(page.locator("#title")).toContainText(`valid ${valid}`);
    await expect(page).toHaveURL(new RegExp(`t=${t}`));
    await expect(fieldButton(page, "500 mb")).toHaveAttribute("aria-current", "true");
  }
  await expect(page).toHaveURL(/m=gfs/);
  // Each chip shows its model's latest run (with its day, unless it's from today)
  await expect(chip(page, "ECMWF").locator(".mchip-run")).toHaveText(new RegExp(`${manifestOf("ecmwf").latest.slice(8)}Z$`));
  // ECMWF has no 6-hour lag (00/12Z runs only): the lag falls back to its default
  await page.goto("/?v=jet&lag=6&f=24");
  await ready(page, "delta", "jet");
  await chip(page, "ECMWF").click();
  await expect(page).toHaveURL(/m=ecmwf.*lag=48/);
  await expect(page.getByRole("radio", { name: "6 h" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("chips show a run's day when it isn't today's, and turn amber when the next run is late", async ({ page }) => {
  const errors = watchForErrors(page);
  const latest: string = manifestOf("ecmwf").latest;
  const init = Date.UTC(+latest.slice(0, 4), +latest.slice(4, 6) - 1, +latest.slice(6, 8), +latest.slice(8, 10));
  const hh = `${latest.slice(8, 10)}Z`;
  const ecmwf = chip(page, "ECMWF");

  // An hour after init: today's run, on time
  await page.clock.setFixedTime(new Date(init + 3600e3));
  await page.goto("/?v=h500&f=24");
  await ready(page, "forecast", "h500");
  await expect(ecmwf.locator(".mchip-run")).toHaveText(hh);
  await expect(ecmwf).not.toHaveClass(/late/);

  // Two days on: the 12-hourly ECMWF's next run (due 12 h + 7:36 after init) is long overdue
  await page.clock.setFixedTime(new Date(init + 48 * 3600e3));
  await page.reload();
  await ready(page, "forecast", "h500");
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(init).getUTCDay()];
  await expect(ecmwf.locator(".mchip-run")).toHaveText(`${day} ${hh}`);
  await expect(ecmwf).toHaveClass(/late/);
  await expect(ecmwf).toHaveAttribute("title", /^ECMWF: latest run .* Late: the .* run was due by .* and hasn't arrived yet\.$/);
  expect(errors).toEqual([]);
});

test("a field the model lacks hides its chip and falls back to another model", async ({ page }) => {
  const errors = watchForErrors(page);
  await page.goto("/?m=aifs&v=wind10&var=speed&f=24");
  await ready(page, "forecast", "wind10");
  await expect(chip(page, "AIFS")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#model-note")).toBeEmpty();
  const valid = (await page.locator("#title").textContent())!.match(/valid (.+?) \|/)![1];

  await fieldButton(page, "Gusts").click();
  await ready(page, "forecast", "wind10");
  // AIGFS, the other AI model, has no gusts either, so the fallback is GFS
  await expect(page.locator("#banner")).toHaveText("AIFS doesn't output gusts, so this shows GFS.");
  await expect(page).toHaveURL(/m=gfs.*var=gust/);
  await expect(page.locator("#title")).toContainText(`GFS 10 m wind gust`);
  await expect(page.locator("#title")).toContainText(`valid ${valid}`);
  await expect(chip(page, "AIFS")).toBeHidden();
  await expect(page.locator('.mgroup[data-group="AI"]')).toBeHidden(); // an empty group collapses
  await expect(page.locator("#model-note")).toHaveText(
    "Not shown: AIFS, AIGFS, GEFS mean, ECMWF ENS mean, AIGEFS mean, HGEFS mean (no gust output)");
  await expect(page.locator('.mgroup[data-group="Ensemble mean"]')).toBeHidden();

  // Back to a field AIFS has: its chip returns, and the note goes
  await fieldButton(page, "Wind").click();
  await ready(page, "forecast", "wind10");
  await expect(chip(page, "AIFS")).toBeVisible();
  await expect(page.locator("#model-note")).toBeEmpty();
  // A link asking for an impossible combination falls back the same way
  await page.goto("/?m=aifs&v=wind10&var=gust&f=24");
  await ready(page, "forecast", "wind10");
  await expect(page.locator("#banner")).toHaveText("AIFS doesn't output gusts, so this shows GFS.");
  expect(errors).toEqual([]);
});

test("old links open on GFS and are rewritten with a valid time", async ({ page }) => {
  const errors = watchForErrors(page);
  // From before the tabs and models: no m, v or t
  await page.goto(`/?run=${manifest.latest}&lag=24&f=24&iso=100,150&lim=fixed`);
  await ready(page, "delta", "jet");
  const valid = runIdOf(new Date(initOf(manifest.latest).getTime() + 24 * 3600e3));
  await expect(page).toHaveURL(new RegExp(`\\?m=gfs&r=na&v=jet&mode=trend&lag=24&t=${valid}&iso=100,150&`));
  expect(new URL(page.url()).searchParams.has("f")).toBe(false);
  await expect(page.locator("#title")).toHaveText(/\| F024$/);
  // Phase 1's ?m=…&f=…
  const ecmwf = manifestOf("ecmwf");
  await page.goto(`/?m=ecmwf&v=h500&mode=fcst&run=${ecmwf.latest}&lag=12&f=48`);
  await ready(page, "forecast", "h500");
  await expect(page).toHaveURL(new RegExp(`m=ecmwf&r=na&v=h500&mode=fcst&var=vort&lag=12&t=${runIdOf(new Date(initOf(ecmwf.latest).getTime() + 48 * 3600e3))}`));
  await expect(page.locator("#title")).toHaveText(/ECMWF 500 mb.*\| F048$/);
  expect(errors).toEqual([]);
});

test("clicking a region zooms in without fetching frames, and Esc zooms out", async ({ page }) => {
  const errors = watchForErrors(page);
  await page.goto("/?v=t2m&f=24");
  await ready(page, "forecast", "t2m");
  await page.waitForLoadState("networkidle"); // let the neighbour preloads finish
  const frames: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/runs/")) frames.push(r.url());
  });
  const renders = await page.evaluate(() => window.__wxtrend!.renders);
  const before = await page.locator("#map").screenshot();
  await expect(page.locator("#crumbs")).toHaveText("North America");

  // Hovering New York outlines the Northeast; clicking focuses it
  const ny = (await page.evaluate(() => window.__wxtrend!.toScreen!(-75.5, 42.8)))!;
  await page.mouse.move(ny.x, ny.y);
  await expect(page.locator("#map-wrap")).toHaveClass(/can-focus/);
  await page.mouse.click(ny.x, ny.y);
  await expect(page.locator("#app")).toHaveAttribute("data-region", "northeast");
  await expect(page).toHaveURL(/r=northeast/);
  await expect(page.locator("#crumbs")).toHaveText("North America›Mainland US›Northeast");
  await expect(page.locator("#region")).toHaveValue("northeast");
  expect((await page.locator("#map").screenshot()).equals(before)).toBe(false);
  // New York is now near the middle of the map
  const box = (await page.locator("#map").boundingBox())!;
  const at = (await page.evaluate(() => window.__wxtrend!.toScreen!(-75.5, 42.8)))!;
  expect(Math.abs(at.x - (box.x + box.width / 2))).toBeLessThan(box.width * 0.2);
  // Stats cover the region: the highest temperature is inside its box
  const where = await page.locator("#stats em").first().textContent();
  const [lat, lon] = where!.match(/([\d.]+)°N ([\d.]+)°W/)!.slice(1).map(Number);
  expect(lat).toBeGreaterThanOrEqual(37);
  expect(lat).toBeLessThanOrEqual(48);
  expect(-lon).toBeGreaterThanOrEqual(-83);
  expect(-lon).toBeLessThanOrEqual(-66);

  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/r=us/);
  await expect(page.locator("#crumbs")).toHaveText("North America›Mainland US");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/r=na/);
  await expect(page.locator("#crumbs")).toHaveText("North America");
  // The selector and breadcrumb do the same
  await page.locator("#region").selectOption("hawaii");
  await expect(page.locator("#crumbs")).toHaveText("North America›Hawaii");
  await page.locator("#crumbs").getByRole("button", { name: "North America" }).click();
  await expect(page).toHaveURL(/r=na/);

  // Globals reuse the frames they already had: no requests, no re-render
  expect(frames).toEqual([]);
  expect(await page.evaluate(() => window.__wxtrend!.renders)).toBe(renders);
  expect(errors).toEqual([]);
});

test("side by side, a model without precipitation type gets its own grey legend row", async ({ page }) => {
  const errors = watchForErrors(page);
  for (const [m, c, untyped] of [["gfs", "aigfs", "AIGFS"], ["aigfs", "gfs", "AIGFS"]]) {
    await page.goto(`/?m=${m}&v=precip&mode=compare&c=${c}&cv=side&f=24`);
    await ready(page, "forecast", "precip");
    await expect(page.locator("#app")).toHaveAttribute("data-frame-b", "forecast");
    await expect(page.locator("#colorbar")).toHaveAttribute("data-kind", "precip-mixed");
    await expect(page.locator(".ptype-label")).toHaveText(["Rain", "Snow", "Sleet", "Freezing rain", untyped]);
    await expect(page.locator(".ptype-note")).toHaveText(`${untyped} doesn't output precipitation type, so its precipitation is grey.`);
  }
  // Two models with types keep the plain legend
  await page.goto("/?m=gfs&v=precip&mode=compare&c=ecmwf&cv=side&f=24");
  await ready(page, "forecast", "precip");
  await expect(page.locator("#colorbar")).toHaveAttribute("data-kind", "precip");
  expect(errors).toEqual([]);
});

test("compare mode shows two models side by side and their difference", async ({ page }) => {
  const errors = watchForErrors(page);
  const frames: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/runs/")) frames.push(new URL(r.url()).pathname);
  });
  await page.goto("/?v=t2m&f=48&r=southeast");
  await ready(page, "forecast", "t2m");
  await page.getByRole("radio", { name: "Compare" }).click();
  await ready(page, "forecast", "t2m");
  await expect(page.locator("#app")).toHaveAttribute("data-compare", "ecmwf");
  await expect(page.locator("#app")).toHaveAttribute("data-frame-b", "forecast");
  await expect(page).toHaveURL(/mode=compare.*c=ecmwf&cv=side/);
  await expect(page.locator("#panel-b")).toBeVisible();
  await expect(page.locator("#title")).toContainText("GFS vs ECMWF: temperature | valid");
  await expect(page.locator("#title-a")).toContainText("GFS · init");
  await expect(page.locator("#title-b")).toContainText("ECMWF · init");
  // Both maps are shaded, and both share the focused region
  for (const id of ["map", "map-b"]) {
    const colored = await page.evaluate((cid) => {
      const c = document.getElementById(cid) as HTMLCanvasElement;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 40) n++;
      return n / (c.width * c.height);
    }, id);
    expect(colored, id).toBeGreaterThan(0.2);
  }
  await expect(page.locator("#crumbs")).toContainText("Southeast");
  await expect(page.locator("#stats .stats-head")).toHaveText(["GFS", "ECMWF"]);
  expect(frames.some((f) => f.startsWith("/data/ecmwf/runs/") && f.includes("/t2m/"))).toBe(true);

  // Both are on na025, so the difference map is offered
  await page.getByRole("radio", { name: "Difference" }).click();
  await ready(page, "delta", "t2m");
  await expect(page).toHaveURL(/cv=diff/);
  await expect(page.locator("#panel-b")).toBeHidden();
  await expect(page.locator("#title")).toContainText("GFS minus ECMWF: temperature");
  await expect(page.locator("#cb-caption")).toContainText("GFS");
  const px = await pixelStats(page);
  expect(px.red + px.blue).toBeGreaterThan(1000);
  const box = (await page.locator("#map").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(page.locator("#tooltip")).toContainText(/GFS T.*ECMWF T.*Δ/s);

  // The partner can change, and compare carries across fields
  await page.locator("#cmp").selectOption({ label: "AIFS" });
  await expect(page).toHaveURL(/c=aifs/);
  await ready(page, "delta", "t2m");
  await fieldButton(page, "500 mb").click();
  await ready(page, "delta", "h500");
  await expect(page.locator("#title")).toContainText("GFS minus AIFS: 500 mb");
  // Only heights are differenced, and the legend says so
  await expect(page.locator("#explain-view")).toContainText("GFS's 500 mb heights minus AIFS's");
  expect(errors).toEqual([]);
});

test("compare picks the other model's run, and says when the two runs are far apart", async ({ page }) => {
  const errors = watchForErrors(page);
  // Runs come from the manifests, so this works on the CI dataset and on a full local one
  const gfs: string[] = manifestOf("gfs").runs.map((r: { id: string }) => r.id);
  const ecmwf: string[] = manifestOf("ecmwf").runs.map((r: { id: string }) => r.id);
  const fmt = (id: string) => `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)} ${id.slice(8)}Z`;

  // A GFS run beside ECMWF's own run of the same cycle
  const twin = gfs.find((id) => ecmwf.includes(id))!;
  await page.goto(`/?v=h500&run=${twin}&f=24&mode=compare&c=ecmwf&cv=side`);
  await ready(page, "forecast", "h500");
  await page.locator("#crun").selectOption("same");
  await ready(page, "forecast", "h500");
  await expect(page).toHaveURL(/crun=same/);
  await expect(page.locator("#title-b")).toContainText(`ECMWF · init ${fmt(twin)} · F024`);
  // (Any banner is a pinned link's "newer run available" note, not an age warning)
  await expect(page.locator("#banner")).not.toContainText("older than");

  // A 06/18Z GFS run has no ECMWF twin (00/12Z only): the banner says why
  const offCycle = gfs.find((id) => +id.slice(8) % 12 !== 0)!;
  await page.locator("#run").selectOption(offCycle);
  await ready(page, "forecast", "h500");
  await expect(page.locator("#banner")).toContainText("ECMWF has no frame valid");
  await expect(page.locator("#banner")).toContainText(`it has no ${offCycle.slice(8)}Z run`);

  // An ECMWF run a day or more older than GFS's latest: allowed, but flagged
  const hours = (a: string, b: string) => (initOf(a).getTime() - initOf(b).getTime()) / 3600e3;
  const old = ecmwf.find((id) => hours(gfs[0], id) >= 24 && hours(gfs[0], id) <= 36)!;
  const f = hours(gfs[0], old) <= 24 ? 12 : 0;
  await page.goto(`/?v=h500&f=${f}&mode=compare&c=ecmwf&cv=diff&crun=${old}`);
  await ready(page, "delta", "h500");
  await expect(page.locator("#crun")).toHaveValue(old);
  await expect(page.locator("#banner")).toHaveText(
    `ECMWF's run is ${hours(gfs[0], old)} h older than GFS's (GFS ${fmt(gfs[0])}, ECMWF ${fmt(old)}).`,
  );
  // A picked run belongs to its model: changing model goes back to the newest
  await page.locator("#cmp").selectOption({ label: "AIFS" });
  await ready(page, "delta", "h500");
  await expect(page.locator("#crun")).toHaveValue("latest");
  await expect(page).not.toHaveURL(/crun=/);
  expect(errors).toEqual([]);
});

test("ensemble means open 500 mb shaded by height; a picked shading sticks across models", async ({ page }) => {
  const errors = watchForErrors(page);
  const shade = page.locator("#shade");
  await page.goto("/?m=gefs&v=h500&f=24");
  await ready(page, "forecast", "h500");
  await expect(page.locator("#shade-field")).toBeVisible();
  await expect(shade.getByRole("radio", { name: "Heights" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#title")).toContainText("GEFS mean 500 mb height | init");
  let px = await pixelStats(page);
  expect(px.colored / px.total).toBeGreaterThan(0.2);

  // GFS's own default is vorticity
  await chip(page, "GFS").click();
  await ready(page, "forecast", "h500");
  await expect(page.locator("#title")).toContainText("GFS 500 mb height & absolute vorticity");

  // Picked, heights stay through model and field changes
  await shade.getByRole("radio", { name: "Heights" }).click();
  await ready(page, "forecast", "h500");
  await expect(page).toHaveURL(/var=hgt/);
  await chip(page, "ECMWF").click();
  await ready(page, "forecast", "h500");
  await expect(page.locator("#title")).toContainText("ECMWF 500 mb height | init");
  await fieldButton(page, "Temperature").click();
  await ready(page, "forecast", "t2m");
  await expect(page.locator("#shade-field")).toBeHidden();
  await fieldButton(page, "500 mb").click();
  await ready(page, "forecast", "h500");
  await expect(shade.getByRole("radio", { name: "Heights" })).toHaveAttribute("aria-checked", "true");
  px = await pixelStats(page);
  expect(px.colored / px.total).toBeGreaterThan(0.2);
  expect(errors).toEqual([]);
});

test.describe("on a 375 px phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

  test("bottom sheets, a pinned scrubber, and tap-to-focus", async ({ page }) => {
    const errors = watchForErrors(page);
    // 12 h lag: the small CI dataset has the older run's F036
    await page.goto("/?v=t2m&f=24&lag=12");
    await ready(page, "forecast", "t2m");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // The sidebar and options are sheets, closed until opened
    await expect(page.locator("#fields")).toBeHidden();
    await expect(page.locator("#options")).toBeHidden();
    // The scrubber stays pinned to the bottom of the screen
    const tl = (await page.locator("#timeline").boundingBox())!;
    expect(tl.y + tl.height).toBeGreaterThan(812 - 120);
    await page.screenshot({ path: shot("screenshot-mobile"), fullPage: false, scale: "css" });

    await page.getByRole("button", { name: "Fields: Temperature" }).tap();
    await expect(page.locator("#fields")).toBeVisible();
    await fieldButton(page, "850 mb").tap();
    await ready(page, "forecast", "t850");
    await expect(page.locator("#fields")).toBeHidden();
    await expect(page.getByRole("button", { name: "Fields: 850 mb" })).toBeVisible();

    await page.getByRole("button", { name: "Options" }).tap();
    await expect(page.locator("#options")).toBeVisible();
    await page.getByRole("radio", { name: "Trend" }).tap();
    await ready(page, "delta", "t850");
    await page.keyboard.press("Escape");
    await expect(page.locator("#options")).toBeHidden();

    // Tapping a region focuses it
    const tx = (await page.evaluate(() => window.__wxtrend!.toScreen!(-99, 31.5)))!;
    await page.touchscreen.tap(tx.x, tx.y);
    await expect(page).toHaveURL(/r=splains/);
    await expect(page.locator("#crumbs")).toContainText("Southern Plains");
    expect(errors).toEqual([]);
  });
});

test("state zoom: inside a region a click zooms to a state, and Esc goes back up", async ({ page }) => {
  const errors = watchForErrors(page);
  await page.goto("/?v=h500&r=northeast");
  await ready(page, "forecast", "h500");
  await expect(page.locator("#crumbs-hint")).toContainText("Click a state to zoom");
  const ny = (await page.evaluate(() => window.__wxtrend!.toScreen!(-75.5, 42.9)))!;
  await page.mouse.click(ny.x, ny.y);
  await expect(page).toHaveURL(/r=ny/);
  await expect(page.locator("#crumbs")).toHaveText(/North America›Mainland US›Northeast›New York/);
  await expect(page.locator("#region")).toHaveValue("ny");
  // Inside a state, another state's click switches to it
  const vt = (await page.evaluate(() => window.__wxtrend!.toScreen!(-72.7, 44.1)))!;
  await page.mouse.click(vt.x, vt.y);
  await expect(page).toHaveURL(/r=vt/);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/r=northeast/);
  // The selector lists the states too
  await page.locator("#region").selectOption("tx");
  await expect(page.locator("#crumbs")).toContainText("Southern Plains›Texas");
  await expect(page).toHaveURL(/r=tx/);
  expect(errors).toEqual([]);
});

test("cities and states can be turned off, and that's remembered", async ({ page }) => {
  await page.goto("/?v=h500&r=midwest");
  await ready(page, "forecast", "h500");
  const box = page.locator("#labels");
  await expect(box).toBeChecked();
  const before = await page.locator("#map").screenshot();
  await box.uncheck();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("rtr:display")!).labels)).toBe(false);
  expect((await page.locator("#map").screenshot()).equals(before)).toBe(false);
  await page.reload();
  await ready(page, "forecast", "h500");
  await expect(box).not.toBeChecked();
});

test("ECMWF gust starts at F006", async ({ page }) => {
  await page.goto("/?m=ecmwf&v=wind10&var=gust&f=0");
  await ready(page, "no-frame", "wind10");
  await expect(page.locator("#banner")).toContainText("starts at F006");
});

test("the scrubber spans the model shown; switching model keeps the time, and says where a run ends", async ({ page }) => {
  const errors = watchForErrors(page);
  const hgefs = manifestOf("hgefs");
  const hInit = initOf(hgefs.latest);
  const end = addH(hInit, hgefs.display_hours[hgefs.display_hours.length - 1]);
  // A day past HGEFS's last hour (F240), well inside GFS's F384
  const t = addH(end, 24);
  await page.goto(`/?m=gfs&v=h500&t=${runIdOf(t)}`);
  const app = page.locator("#app");
  await expect(app).toHaveAttribute("data-product", "gfs");
  await expect(page).toHaveURL(new RegExp(`t=${runIdOf(t)}`));
  const slider = page.locator("#fhr");
  const gfsMax = Number(await slider.getAttribute("max"));

  await chip(page, "HGEFS mean").click();
  await expect(app).toHaveAttribute("data-product", "hgefs");
  await expect(app).toHaveAttribute("data-frame", "no-frame");
  await expect(page).toHaveURL(new RegExp(`t=${runIdOf(t)}`));
  const fmt = (d: Date) => d.toISOString().slice(0, 13).replace("T", " ") + "Z";
  await expect(page.locator("#banner")).toContainText(`HGEFS mean's ${fmt(hInit)} run ends at ${shortZ(end)}.`);
  await expect(page.locator("#fhr-readout")).toContainText("no HGEFS mean frame");
  // HGEFS stops at F240, so its scrubber ends there: shorter than GFS's, and all of it covered
  const max = Number(await slider.getAttribute("max"));
  expect(max).toBeLessThan(gfsMax);
  expect(max - Number(await slider.getAttribute("min"))).toBe(hgefs.display_hours[hgefs.display_hours.length - 1] - hgefs.display_hours[0]);
  expect(await page.locator("#coverage").evaluate((e) => parseFloat((e as HTMLElement).style.width))).toBeCloseTo(100, 0);

  // Zooming to a region keeps the banner (the map is still empty)
  await page.locator("#region").selectOption("us");
  await expect(page.locator("#crumbs")).toContainText("Mainland US");
  await expect(page.locator("#banner")).toContainText("run ends at");

  // Side by side, the other model still draws where this one has nothing
  await page.locator("#mode").getByRole("radio", { name: "Compare" }).click();
  await expect(app).toHaveAttribute("data-compare", "gfs");
  await expect(page.locator("#panel-b")).toBeVisible();
  await expect(page.locator("#title-a")).toHaveText(`HGEFS mean · its ${fmt(hInit)} run doesn't reach this time`);
  await expect(page.locator("#banner")).toContainText("run ends at");
  await page.locator("#mode").getByRole("radio", { name: "Forecast" }).click();

  await page.locator("#banner").getByRole("button", { name: "Go to its last hour" }).click();
  await expect(page).toHaveURL(new RegExp(`t=${runIdOf(end)}`));
  await expect(page.locator("#title")).toHaveText(/\| F240$/);
  // Shift+← steps a day, to the same hour, also with the scrubber focused (which alone steps 6 h)
  await page.locator("#fhr").focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(page).toHaveURL(new RegExp(`t=${runIdOf(addH(end, -24))}`));
  await expect(page.locator("#title")).toHaveText(/\| F216$/);
  expect(errors).toEqual([]);
});

test("a time off the scrubber steps onto it", async ({ page }) => {
  const errors = watchForErrors(page);
  // A link to the oldest GFS run, then another model: the time stays, before the axis starts
  const oldest = manifest.runs[manifest.runs.length - 1].id;
  await page.goto(`/?run=${oldest}&v=h500&f=0`);
  await ready(page, "forecast", "h500");
  await chip(page, "ECMWF").click();
  await expect(page.locator("#app")).toHaveAttribute("data-product", "ecmwf");
  await expect(page).toHaveURL(new RegExp(`t=${oldest}`));
  // The scrubber spans ECMWF's latest run now
  const start = addH(initOf(manifestOf("ecmwf").latest), manifestOf("ecmwf").display_hours[0]);
  await expect(page.locator("#prev")).toBeDisabled();
  await expect(page.locator("#next")).toBeEnabled();
  await page.locator("#next").click();
  await expect(page).toHaveURL(new RegExp(`t=${runIdOf(start)}`));
  expect(errors).toEqual([]);
});

test.describe("in New York", () => {
  test.use({ timezoneId: "America/New_York" });

  test("times read in the viewer's zone with Z beside them, and the zone is remembered", async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto("/?v=h500&f=24");
    await ready(page, "forecast", "h500");
    const valid = addH(initOf(manifest.latest), 24);
    const z = `${valid.toUTCString().slice(0, 3)} ${String(valid.getUTCHours()).padStart(2, "0")}Z`;
    await expect(page.locator("#zone")).toHaveValue("ET");
    await expect(page.locator("#title")).toHaveText(new RegExp(`valid \\w{3} \\d\\d \\w{3} \\d{1,2} (AM|PM) ET · ${z} \\| F024$`));
    await expect(page.locator("#fhr-readout strong")).toHaveText(/ (AM|PM) ET$/);
    await expect(page.locator("#fhr-readout")).toContainText(new RegExp(`${z} · F024 · Day \\d`));

    await page.locator("#zone").selectOption("PT");
    await expect(page.locator("#title")).toHaveText(new RegExp(`(AM|PM) PT · ${z} \\|`));
    await page.reload();
    await ready(page, "forecast", "h500");
    await expect(page.locator("#zone")).toHaveValue("PT");
    // UTC shows Z alone
    await page.locator("#zone").selectOption("UTC");
    await expect(page.locator("#title")).toHaveText(new RegExp(`valid ${shortZ(valid)} \\| F024$`));
    expect(errors).toEqual([]);
  });
});

test("units: mph and °C are remembered, and 500 mb differences are in dam", async ({ page }) => {
  const errors = watchForErrors(page);
  await page.goto("/?v=wind10&var=speed&f=24&lag=12");
  await ready(page, "forecast", "wind10");
  await expect(page.locator("#cb-caption")).toHaveText("10 m sustained wind (kt)");
  await page.locator("#speed-unit").getByRole("radio", { name: "mph", exact: true }).click();
  await expect(page.locator("#cb-caption")).toHaveText("10 m sustained wind (mph)");
  await expect(page.locator("#title")).toContainText("10 m wind (mph)");
  await expect(page.locator("#stats")).toContainText(/Max wind\d+ mph/);
  await page.reload();
  await ready(page, "forecast", "wind10");
  await expect(page.locator("#cb-caption")).toHaveText("10 m sustained wind (mph)");

  await fieldButton(page, "Temperature").click();
  await ready(page, "forecast", "t2m");
  await page.locator("#temp-unit").getByRole("radio", { name: "°C" }).click();
  await expect(page.locator("#cb-caption")).toHaveText("2 m temperature (°C)");
  await fieldButton(page, "850 mb").click();
  await ready(page, "forecast", "t850");
  await expect(page.locator("#cb-caption")).toHaveText("850 mb temperature (°C)");

  await page.goto("/?v=h500&mode=trend&f=48&lag=12");
  await ready(page, "delta", "h500");
  await expect(page.locator("#cb-caption")).toContainText("Δ 500 mb height (dam)");
  await expect(page.getByRole("radio", { name: "±6 dam" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a loop plays its range at the chosen speed after preloading, with no spinner", async ({ page }) => {
  const errors = watchForErrors(page);
  await page.goto("/?v=h500&f=0");
  await ready(page, "forecast", "h500");
  const init = initOf(manifest.latest);

  // Days 1–7 zoom and the "Next 7 days" preset
  await page.getByRole("button", { name: "Zoom to Days 1–7" }).click();
  await expect(page.locator("#zoom")).toHaveAttribute("aria-pressed", "true");
  await page.reload(); // remembered
  await ready(page, "forecast", "h500");
  await expect(page.locator("#zoom")).toHaveAttribute("aria-pressed", "true");
  const span = await page.locator("#fhr").evaluate((e) => Number((e as HTMLInputElement).max) - Number((e as HTMLInputElement).min));
  expect(span).toBeGreaterThanOrEqual(144);
  expect(span).toBeLessThanOrEqual(168);
  await page.locator("#loop-preset").getByRole("radio", { name: "Next 7 days" }).click();
  await expect(page.locator("#loop-preset").getByRole("radio", { name: "Next 7 days" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Zoom to Days 1–7" }).click();
  await page.locator("#loop-preset").getByRole("radio", { name: "All" }).click();

  // Dragging a handle sets a range of its own
  const handle = (await page.locator("#loop-end").boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 120, handle.y + handle.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator("#loop-end")).not.toHaveAttribute("aria-valuetext", await page.locator("#loop-start").getAttribute("aria-valuetext") ?? "");
  expect(Number(await page.locator("#loop-end").getAttribute("aria-valuenow")))
    .toBeLessThan(Number(await page.locator("#loop-end").getAttribute("aria-valuemax")));
  await expect(page.locator('#loop-preset [aria-checked="true"]')).toHaveCount(0);

  // F000–F048 (frames the small dataset has): the end handle to the start, then seven steps on
  const end = page.locator("#loop-end");
  await end.focus();
  await page.keyboard.press("Home");
  for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowRight");
  await expect(end).toHaveAttribute("aria-valuetext", shortZ(addH(init, 48)));
  await expect(page.locator("#loop-start")).toHaveAttribute("aria-valuetext", shortZ(init));
  await expect(page.locator('#loop-preset [aria-checked="true"]')).toHaveCount(0);

  // Nine hours, each with vorticity and heights
  await page.locator("#preload").click();
  await expect(page.locator("#preload")).toHaveText("Loop preloaded (18 frames)");

  await page.locator("#fps").selectOption("8");
  await page.locator("#play").click();
  const fast = await watchPlay(page, 4000);
  await page.locator("#play").click();
  expect(fast.spun).toBe(false);
  expect(fast.renders).toBeGreaterThanOrEqual(12);
  // About 1/8 s a frame, holding the last one for 1.5 s, then wrapping from F048 to F000 within the loop
  expect(fast.gaps[fast.gaps.length >> 1]).toBeLessThan(300);
  expect(fast.gaps[fast.gaps.length - 1]).toBeGreaterThan(1400);
  expect(fast.hours).toContain(0);
  expect(fast.hours).toContain(48);
  for (const f of fast.hours) expect(f >= 0 && f <= 48).toBe(true);
  // The URL waits for the loop to stop
  expect(fast.urlWrites).toBe(0);
  await expect(page).toHaveURL(/t=\d{10}/);

  await page.locator("#fps").selectOption("1");
  await page.locator("#play").click();
  const slow = await watchPlay(page, 2500);
  await page.locator("#play").click();
  expect(slow.renders).toBeLessThanOrEqual(4);
  expect(errors).toEqual([]);
});

test("the next 7 days loop preloads and plays", async ({ page }) => {
  const errors = watchForErrors(page);
  await page.goto("/?v=t2m&f=0");
  await ready(page, "forecast", "t2m");
  await page.locator("#loop-preset").getByRole("radio", { name: "Next 7 days" }).click();
  const hours = async (id: string) => Number(await page.locator(id).getAttribute("aria-valuenow"));
  const span = (await hours("#loop-end")) - (await hours("#loop-start"));
  expect(span).toBeGreaterThanOrEqual(144);
  expect(span).toBeLessThanOrEqual(168);
  await page.locator("#preload").click();
  await expect(page.locator("#preload")).toHaveText(/^Loop preloaded \(\d+ frames\)$/);
  await expect(page.locator("#preload-status")).toHaveText(/^Loop preloaded: \d+ frames$/);
  await page.locator("#fps").selectOption("8");
  await page.locator("#play").click();
  // Frames past the small dataset's F060 say "Frame unavailable" without fetching
  const run = await watchPlay(page, 3000);
  await page.locator("#play").click();
  expect(run.spun).toBe(false);
  expect(run.renders).toBeGreaterThanOrEqual(10);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------------ presentation mode (M3)

/** A PNG's width and height, from its header. */
const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];

async function presentReady(page: Page, slots: number) {
  await expect(page.locator("#present")).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#present")).toHaveAttribute("data-slots", String(slots));
}

/** Save what clicking `button` downloads, and return its bytes and name. */
async function downloadFrom(page: Page, button: string) {
  await page.locator("#present").hover(); // controls hide when the mouse is still
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(button).click()]);
  return { name: dl.suggestedFilename(), bytes: readFileSync((await dl.path())!) };
}

test("presentation: pick a layout, fill slots, step a day, export a PNG at the frame's exact size, and leave", async ({ page }) => {
  const errors = watchForErrors(page);
  await page.goto("/?v=h500&r=us");
  await ready(page, "forecast", "h500");
  await page.locator("#present-open").click();
  await expect(page.locator("#present-picker")).toBeVisible();
  await page.locator('[data-silhouette="quad"]').click();
  await presentReady(page, 4);
  // The site's view first, then the next models, all at the same time
  await expect(page).toHaveURL(/present=quad/);
  const q = new URL(page.url()).searchParams;
  expect(["s1", "s2", "s3", "s4"].map((k) => new URLSearchParams(q.get(k)!).get("m"))).toEqual(["gfs", "ecmwf", "aifs", "aigfs"]);
  expect(Number(await page.locator("#present").getAttribute("data-drawn"))).toBeGreaterThanOrEqual(2);
  const t0 = q.get("t")!;

  // Slot 2 to New York: one slot's region, the rest unchanged
  await page.keyboard.press("2");
  await expect(page.locator("#present-editor")).toBeVisible();
  await page.locator("#present-editor label", { hasText: "Region" }).locator("select").selectOption("ny");
  await expect(page).toHaveURL(/s2=[^&]*r%3Dny/);
  await expect(page).toHaveURL(/s1=[^&]*r%3Dus/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#present-editor")).toBeHidden();

  // A clicker's Next steps a day
  await page.keyboard.press("PageDown");
  await expect(page).toHaveURL(new RegExp(`t=${runIdOf(addH(initOf(t0), 24))}`));
  await presentReady(page, 4);

  const png = await downloadFrom(page, "#pc-png");
  expect(png.name).toMatch(/^runtorunwx-500-mb-vorticity-\d{10}z\.png$/);
  expect(pngSize(png.bytes)).toEqual([1920, 1080]);
  await page.locator("#pc-png-scale").selectOption("2");
  expect(pngSize((await downloadFrom(page, "#pc-png")).bytes)).toEqual([3840, 2160]);

  // Esc leaves; the site and its link come back
  await page.keyboard.press("Escape");
  await expect(page.locator("#present")).toBeHidden();
  await expect(page).toHaveURL(/v=h500/);
  await expect(page).not.toHaveURL(/present=/);
  expect(errors).toEqual([]);
});

test("a presentation link opens its layout; a 9:16 frame exports at 1080 × 1920 and has the Shorts guide", async ({ page }) => {
  const errors = watchForErrors(page);
  const s1 = encodeURIComponent("m=gfs&r=us&v=t2m&var=temp&mode=fcst");
  const s2 = encodeURIComponent("m=ecmwf&r=northeast&v=precip&mode=fcst");
  await page.goto(`/?present=stack&s1=${s1}&s2=${s2}`);
  await presentReady(page, 2);
  await page.locator("#present").hover();
  await expect(page.locator("#pc-guide")).toBeVisible();
  await page.keyboard.press("g");
  await expect(page.locator("#pc-guide")).toHaveAttribute("aria-pressed", "true");
  const png = await downloadFrom(page, "#pc-png");
  // Different fields: named for the models, not one field
  expect(png.name).toMatch(/^runtorunwx-models-\d{10}z\.png$/);
  expect(pngSize(png.bytes)).toEqual([1080, 1920]);
  expect(errors).toEqual([]);
});

test("the loop exports as an MP4", async ({ page }) => {
  await page.goto(`/?present=single&s1=${encodeURIComponent("m=gfs&r=us&v=h500&mode=fcst")}`);
  await presentReady(page, 1);
  await page.locator("#present").hover();
  test.skip(await page.locator("#pc-mp4").isHidden(), "this browser can't encode H.264");
  const mp4 = await downloadFrom(page, "#pc-mp4");
  expect(mp4.name).toMatch(/\.mp4$/);
  expect(mp4.bytes.subarray(4, 8).toString("latin1")).toBe("ftyp");
  expect(mp4.bytes.includes(Buffer.from("avc1"))).toBe(true);
});

test("presentation keys stay in presentation mode, and leaving returns to the site as it was", async ({ page }) => {
  const errors = watchForErrors(page);
  await page.goto("/?v=h500&r=us");
  await ready(page, "forecast", "h500");
  const siteUrl = page.url();
  await page.keyboard.press("p");
  await expect(page.locator("#present-picker")).toBeVisible();
  // Esc from the picker goes back to the site
  await page.keyboard.press("Escape");
  await expect(page.locator("#present")).toBeHidden();
  await expect(page).toHaveURL(siteUrl);

  await page.keyboard.press("p");
  await page.locator('[data-silhouette="pair"]').click();
  await presentReady(page, 2);
  // A digit edits a slot rather than picking a site field; arrows step presentation time
  await page.keyboard.press("2");
  await expect(page.locator("#present-editor")).toContainText("Slot 2");
  await page.keyboard.press("Escape");
  const t0 = new URL(page.url()).searchParams.get("t")!;
  await page.keyboard.press("ArrowRight");
  await expect(page).not.toHaveURL(new RegExp(`t=${t0}`));
  await page.keyboard.press("Escape");
  await expect(page.locator("#present")).toBeHidden();
  await expect(page.locator("#app")).toHaveAttribute("data-view", "h500");
  await expect(page.locator("#title")).toContainText("500 mb");

  // The next layout starts from the site's view again, not the last one
  await fieldButton(page, "Temperature").click();
  await ready(page, "forecast", "t2m");
  await page.keyboard.press("p");
  await page.locator('[data-silhouette="single"]').click();
  await presentReady(page, 1);
  expect(new URLSearchParams(new URL(page.url()).searchParams.get("s1")!).get("v")).toBe("t2m");
  expect(errors).toEqual([]);
});

test("changing layout with a slot editor open leaves no phantom slot", async ({ page }) => {
  const errors = watchForErrors(page);
  await page.goto(`/?present=quad&s1=${encodeURIComponent("m=gfs&r=us&v=h500&mode=fcst")}`);
  await presentReady(page, 4);
  await page.keyboard.press("4");
  await expect(page.locator("#present-editor")).toBeVisible();
  await page.locator("#present").hover();
  await page.locator("#pc-layout").click();
  await page.locator('[data-silhouette="single"]').click();
  await presentReady(page, 1);
  await expect(page.locator("#present-editor")).toBeHidden();
  await expect(page).not.toHaveURL(/s2=/);
  expect(errors).toEqual([]);
});

test("presentation's scrubber spans its slots' models, and a preload survives stepping", async ({ page }) => {
  const errors = watchForErrors(page);
  const s1 = encodeURIComponent("m=gfs&r=us&v=h500&mode=fcst");
  const s2 = encodeURIComponent("m=hgefs&r=us&v=h500&var=hgt&mode=fcst");
  await page.goto(`/?present=pair&s1=${s1}&s2=${s2}`);
  await presentReady(page, 2);
  // From the earlier start to the later end of the two latest runs
  const span = (p: string) => {
    const m = manifestOf(p), init = initOf(m.latest);
    return [addH(init, m.display_hours[0]).getTime(), addH(init, m.display_hours[m.display_hours.length - 1]).getTime()];
  };
  const [g, h] = [span("gfs"), span("hgefs")];
  const hours = (Math.max(g[1], h[1]) - Math.min(g[0], h[0])) / 3600e3;
  expect(Number(await page.locator("#pc-scrub").getAttribute("max"))).toBe(hours);

  await page.locator("#present").hover();
  await page.locator("#pc-preload").click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#pc-preload")).toHaveText(/Loop preloaded/, { timeout: 30_000 });
  // Changing a slot does reset it
  await page.keyboard.press("1");
  await page.locator("#present-editor label", { hasText: "Region" }).locator("select").selectOption("midwest");
  await expect(page.locator("#pc-preload")).toHaveText("Preload loop");
  expect(errors).toEqual([]);
});

test("a 480p downscale of a 1080p frame keeps its proportions", async ({ page }) => {
  await page.goto(`/?present=quad&s1=${encodeURIComponent("m=gfs&r=us&v=h500&mode=fcst")}`);
  await presentReady(page, 4);
  const small = await page.evaluate(() => window.__wxtrend!.presentFrame!(1, 854));
  expect([small.width, small.height]).toEqual([1920, 1080]);
  expect(pngSize(Buffer.from(small.png.split(",")[1], "base64"))).toEqual([854, 480]);
});

test("an MP4 export can be stopped, and the button comes back", async ({ page }) => {
  await page.goto(`/?present=single&s1=${encodeURIComponent("m=gfs&r=us&v=h500&mode=fcst")}`);
  await presentReady(page, 1);
  await page.locator("#present").hover();
  test.skip(await page.locator("#pc-mp4").isHidden(), "this browser can't encode H.264");
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.locator("#pc-mp4").click();
  await expect(page.locator("#pc-mp4")).toHaveText(/stop/);
  await page.locator("#pc-mp4").click();
  await expect(page.locator("#pc-mp4")).toHaveText("MP4");
  await expect(page.locator("#pc-mp4")).toHaveAttribute("aria-pressed", "false");
  await page.waitForTimeout(500);
  expect(downloads).toBe(0);
});
