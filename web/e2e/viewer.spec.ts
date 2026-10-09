import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dataDir = process.env.WXTREND_DATA_DIR ?? fileURLToPath(new URL("../../data/", import.meta.url));
const manifest = JSON.parse(readFileSync(`${dataDir}/manifest.json`, "utf8"));
const shot = (name: string) => fileURLToPath(new URL(`../../docs/${name}.png`, import.meta.url));

/** Collect anything that would show up as a problem in the console or network. */
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

/** Count shaded pixels on the map canvas by hue. */
async function pixelStats(page: Page) {
  return page.evaluate(() => {
    // Read back through a copy so repeated reads don't trigger Chrome's readback warning.
    const c = document.getElementById("map") as HTMLCanvasElement;
    const copy = document.createElement("canvas");
    copy.width = c.width;
    copy.height = c.height;
    const cx = copy.getContext("2d", { willReadFrequently: true })!;
    cx.drawImage(c, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let red = 0, blue = 0, black = 0, violet = 0, colored = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colored++;
      if (b - g > 60 && r - g > 30 && b > 150) violet++;
      if (r - b > 40 && r - g > 25) red++;
      else if (b - r > 40) blue++;
      else if (r < 40 && g < 40 && b < 40) black++;
    }
    return { total: c.width * c.height, red, blue, black, violet, colored };
  });
}

test("renders real pipeline output with no console errors", async ({ page }) => {
  const errors = watchForErrors(page);
  await page.goto("/");
  await ready(page);

  const title = page.locator("#title");
  await expect(title).toHaveText(
    /^GFS 250 mb \|V\| trend: init \d{4}-\d\d-\d\d \d\dZ vs \d{4}-\d\d-\d\d \d\dZ \| valid \d{4}-\d\d-\d\d \d\dZ \| F000$/,
  );
  expect(page.url()).toContain(`run=${manifest.latest}`);

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
    if (r.url().includes("/runs/")) frames.push(new URL(r.url()).pathname.split("/data/")[1]);
  });
  await page.goto("/?lag=24&f=120&iso=100,150&lim=fixed");
  await ready(page);

  const init = manifest.latest as string;
  const t0 = new Date(Date.UTC(+init.slice(0, 4), +init.slice(4, 6) - 1, +init.slice(6, 8), +init.slice(8, 10)));
  const fmt = (t: Date) => t.toISOString().slice(0, 13).replace("T", " ") + "Z";
  const older = new Date(t0.getTime() - 24 * 3600e3);
  const valid = new Date(t0.getTime() + 120 * 3600e3);
  await expect(page.locator("#title")).toHaveText(
    `GFS 250 mb |V| trend: init ${fmt(t0)} vs ${fmt(older)} | valid ${fmt(valid)} | F120`,
  );
  const olderId = older.toISOString().slice(0, 13).replace(/[-T]/g, "");
  // The pair loaded: current F120 (speed and direction) and the run 24 h older at F144 (speed only)
  expect(frames).toContain(`runs/${init}/wspd250/f120.bin.gz`);
  expect(frames).toContain(`runs/${init}/wdir250/f120.bin.gz`);
  expect(frames).toContain(`runs/${olderId}/wspd250/f144.bin.gz`);
  expect(frames).not.toContain(`runs/${olderId}/wdir250/f144.bin.gz`);
  // ...and neighbours were preloaded so stepping is immediate
  await expect.poll(() => frames.includes(`runs/${init}/wspd250/f126.bin.gz`)).toBe(true);
  await expect.poll(() => frames.includes(`runs/${olderId}/wspd250/f150.bin.gz`)).toBe(true);

  const before = frames.length;
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#title")).toHaveText(/\| F126$/);
  await ready(page);
  expect(frames.slice(before).filter((f) => f.endsWith("f126.bin.gz") || f.endsWith("f150.bin.gz"))).toEqual([]);
  expect(page.url()).toContain("f=126");

  await page.getByRole("radio", { name: "48 h" }).click();
  await expect(page).toHaveURL(/lag=48/);
  await expect(page.locator("#lag-hint")).toContainText("F174");

  await page.getByRole("radio", { name: "Auto" }).click();
  await expect(page).toHaveURL(/lim=auto/);
  const limit = Number(await page.locator("#colorbar").getAttribute("data-max"));
  expect(limit % 10).toBe(0);
  expect(limit).toBeGreaterThanOrEqual(10);

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
  await page.goto("/?f=96");
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
  await expect(page.locator("#title")).toHaveText(/F102$/);
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
  await expect(page).toHaveURL(new RegExp(`run=${manifest.latest}`));
  await expect(banner).toBeHidden();
  expect(errors).toEqual([]);
});

test("fits a phone-width screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await ready(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

const TABS = [
  { view: "t2m", name: "Temperature", url: "/?v=t2m&f=48", frame: "forecast", shot: "screenshot-temperature" },
  { view: "wind10", name: "Wind", url: "/?v=wind10&f=48", frame: "forecast", shot: "screenshot-wind" },
  { view: "precip", name: "Precipitation", url: "/?v=precip&f=48", frame: "forecast", shot: "screenshot-precip" },
];

for (const tab of TABS) {
  test(`${tab.name} tab renders real data in forecast and trend modes`, async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto(tab.url);
    await ready(page, "forecast", tab.view);
    await expect(page.getByRole("tab", { name: new RegExp(tab.name) })).toHaveAttribute("aria-selected", "true");
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

test("tabs switch by click and number key, and remember their settings", async ({ page }) => {
  await page.goto("/?f=24");
  await ready(page, "delta", "jet");
  await page.getByRole("tab", { name: /Wind/ }).click();
  await ready(page, "forecast", "wind10");
  await expect(page).toHaveURL(/v=wind10/);
  await page.getByRole("radio", { name: "Gusts" }).click();
  await expect(page).toHaveURL(/var=gust/);
  await expect(page.locator("#title")).toContainText("10 m wind gust");
  await page.keyboard.press("2");
  await ready(page, "forecast", "t2m");
  await page.keyboard.press("3");
  await ready(page, "forecast", "wind10");
  await expect(page).toHaveURL(/var=gust/); // remembered
  await page.keyboard.press("1");
  await ready(page, "delta", "jet");
  await expect(page).toHaveURL(/f=24/); // the forecast hour carries across tabs
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
  await page.goto("/?f=96&iso=60,100");
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
  await page.goto("/?lag=48&f=96&iso=100,150&lim=fixed");
  await ready(page);
  await page.screenshot({ path: shot("screenshot"), fullPage: false, scale: "css" });
  for (const tab of TABS) {
    await page.goto(tab.url);
    await ready(page, tab.frame, tab.view);
    await page.screenshot({ path: shot(tab.shot), fullPage: false, scale: "css" });
  }
  expect(errors).toEqual([]);
});
