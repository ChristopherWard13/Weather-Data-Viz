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
    /^GFS 250 mb \|V\| trend: init \d{4}-\d\d-\d\d \d\dZ vs \d{4}-\d\d-\d\d \d\dZ \| valid \d{4}-\d\d-\d\d \d\dZ \| F000$/,
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
    `GFS 250 mb |V| trend: init ${fmt(t0)} vs ${fmt(older)} | valid ${fmt(valid)} | F024`,
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
  await banner.getByRole("button", { name: "Show latest" }).click();
  await expect(page).not.toHaveURL(/run=/);
  await expect(banner).toBeHidden();
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

for (const product of ["ecmwf", "aifs", "aigfs", "gefs", "aigefs", "hgefs"]) {
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
  const valid = (await page.locator("#title").textContent())!.match(/valid (\S+ \S+)/)![1];
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
  const valid = (await page.locator("#title").textContent())!.match(/valid (\S+ \S+)/)![1];

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
    "Not shown: AIFS, AIGFS, GEFS mean, AIGEFS mean, HGEFS mean (no gust output)");
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

test("ECMWF gust starts at F006", async ({ page }) => {
  await page.goto("/?m=ecmwf&v=wind10&var=gust&f=0");
  await ready(page, "no-frame", "wind10");
  await expect(page.locator("#banner")).toContainText("starts at F006");
});
