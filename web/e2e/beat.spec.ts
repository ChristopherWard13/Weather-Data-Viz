import { expect, test, type Page } from "@playwright/test";

// Beat the Models (build plan G4) reads three days' files from the data bucket.
// These tests serve their own, for a morning after games.yml's run on Oct 25:
// Oct 26 open for a call (Denver, locking at 06Z), Oct 25 locked with the
// models' calls, and Oct 24's verdict.

const city = (id: string, name: string, state: string, station: string, tz: string, region: string) =>
  ({ id, city: name, state, station, lat: 39.8, lon: -104.7, elev: 1640, tz, region });
const DEN = city("KDEN", "Denver", "CO", "DENVER INTNL ARPT", "America/Denver", "southwest");
const ATL = city("KATL", "Atlanta", "GA", "ATLANTA INTL ARPT", "America/New_York", "southeast");
const MSP = city("KMSP", "Minneapolis", "MN", "MINNEAPOLIS/ST PAUL", "America/Chicago", "midwest");
const MODELS = [["gfs", "GFS"], ["gefs", "GEFS mean"], ["ecmwf", "ECMWF"], ["icon", "ICON"], ["gdps", "GEM"]];
const calls = (values: number[], run = "2026102500") =>
  MODELS.map(([id, name], k) => ({ id, name, run, high: values[k], call: values[k], ground: 1650, lead: 22 }));

const puzzle = (date: string, number: number, c: typeof DEN, lock: string) => ({
  v: 1, game: "beat", date, number, made: "2026-10-25T10:30:00Z",
  credit: { text: "NOAA, ECMWF, DWD, ECCC; NWS via IEM", url: "https://mesonet.agron.iastate.edu/" },
  city: c, lock, day: [lock, lock], map: "2026102700", models: MODELS.map(([id, name]) => ({ id, name })),
  context: [{ date: "2026-10-23", high: 64, normal: 61 }, { date: "2026-10-24", high: 70, normal: 60 }],
  spread: 8.2, rules: { points: 100, per_degree: 20, bust: 5 }, recent: [],
});
const open = puzzle("2026-10-26", 3, DEN, "2026-10-26T06:00:00Z");
const locked = { v: 1, game: "beat", date: "2026-10-25", number: 2, made: "2026-10-25T10:30:00Z", city: MSP,
  lock: "2026-10-25T05:00:00Z", models: calls([55, 54, 51, 57, 52]) };
const verdict = { v: 1, game: "beat", date: "2026-10-24", number: 1, made: "2026-10-25T10:30:00Z", city: ATL,
  lock: "2026-10-24T04:00:00Z", high: 73, void: false, models: calls([70, 72, 75, 66, 73], "2026102318") };

async function serve(page: Page, files: Record<string, unknown>): Promise<void> {
  // Routes run newest first: anything not served below is missing
  await page.route("**/games/beat/**", (route) => route.fulfill({ status: 404, body: "not found" }));
  for (const [name, json] of Object.entries(files)) {
    await page.route(`**/games/beat/${name}`, (route) => route.fulfill({ json }));
  }
}

const FILES = { "latest.json": open, "2026-10-25.models.json": locked, "2026-10-24.result.json": verdict };

test("Beat the Models: yesterday's verdict, today's locked call beside the models', and tomorrow's call", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.clock.setFixedTime(new Date("2026-10-25T14:00:00Z"));
  await serve(page, FILES);
  // Calls made before each day's lock: 71 for Atlanta (it hit 73), 56 for Minneapolis
  await page.addInitScript(() => {
    if (!localStorage.getItem("rtr:game:beat")) {
      localStorage.setItem("rtr:game:beat", JSON.stringify({
        "2026-10-24": { call: 71, at: "2026-10-23T20:00:00Z" },
        "2026-10-25": { call: 56, at: "2026-10-24T20:00:00Z" },
      }));
    }
  });
  await page.goto("./play/beat/");
  await expect(page.locator(".btm-day")).toHaveCount(3);
  expect(await page.locator(".btm-day").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.state)))
    .toEqual(["verdict", "locked", "open"]);
  await expect(page.locator("#number")).toHaveText("#3");

  // The verdict: Atlanta hit 73; 71 is 2 off, 60 points; GEM (0) and GEFS (−1) were closer, ECMWF (+2) tied
  const v = page.locator('.btm-day[data-state="verdict"]');
  await expect(v.locator(".btm-city-name")).toHaveText("Atlanta, GA");
  await expect(v.locator(".readout-value")).toHaveText("73°");
  await expect(v.locator(".stamp")).toHaveText("Beat 2 of 5");
  await expect(v.locator(".tile-total .tile-num")).toHaveText("60");
  await expect(v.locator(".btm-board tbody tr")).toHaveText([/GEM.*73°.*0/, /GEFS mean.*72°.*−1/, /You.*Your call.*71°.*−2/,
    /ECMWF.*75°.*\+2/, /GFS.*70°.*−3/, /ICON.*66°.*−7/]);
  await v.getByRole("button", { name: "Share result" }).click();
  await expect(v.locator(".share-note")).toHaveText("Copied. Paste it anywhere.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Beat 2 of 5 models 🟩🟥🟨🟩🟥");

  // Today: locked, with the models' calls
  const l = page.locator('.btm-day[data-state="locked"]');
  await expect(l.locator(".btm-city-name")).toHaveText("Minneapolis, MN");
  await expect(l.locator(".btm-yours")).toContainText("56°F");
  await expect(l.locator(".btm-model-call")).toHaveText(["55°", "54°", "51°", "57°", "52°"]);
  await expect(l).toContainText("Verdict: Monday about 6:30 a.m. Eastern.");

  // Tomorrow: a call, locked in before Denver's midnight
  const o = page.locator('.btm-day[data-state="open"]');
  await expect(o.locator(".btm-context")).toHaveText("Recent highs: Fri 64°F · Sat 70°F · normal about 60°F");
  await expect(page.locator("#status")).toHaveText("Locks at midnight in Denver (2 a.m. Eastern), in 16 h 0 min.");
  await expect(page.locator("#lock")).toBeDisabled();
  await expect(o.locator(".map-link")).toHaveAttribute("href", /\?m=gfs&r=southwest&v=t2m&var=temp&t=2026102700&mode=fcst$/);
  await page.locator("#call").fill("63");
  await page.locator("#call").press("Enter");
  await expect(page.locator("#hud-call")).toHaveText("63°");
  await expect(page.locator("#status")).toContainText("Your call is 63°F. You can change it until midnight in Denver");
  await expect(page.locator("#lock")).toHaveText("Change call ▶");
  // The buttons step from the call
  await page.getByRole("button", { name: "One degree higher" }).click();
  await page.locator("#lock").click();
  await expect(page.locator("#hud-call")).toHaveText("64°");

  // Kept in this browser, and the landing page counts it
  await page.reload();
  await expect(page.locator("#hud-call")).toHaveText("64°");
  await page.goto("./play/");
  await expect(page.locator('.hub-card[data-game="beat"]')).toContainText("Called 64°F");

  // After Denver's midnight the call is locked, and the next city isn't out yet
  await page.clock.setFixedTime(new Date("2026-10-26T06:30:00Z"));
  await page.goto("./play/beat/");
  await expect(page.locator('.btm-day[data-state="open"]')).toHaveCount(0);
  await expect(page.locator(".btm-day").last()).toContainText("Your call 64°F");
  await expect(page.locator(".btm-next")).toHaveText("The next city is posted about 6:30 a.m. Eastern.");
  expect(errors).toEqual([]);
});

test("Beat the Models: a verdict without your call, a void day, and no puzzle yet", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-25T14:00:00Z"));
  await serve(page, FILES);
  await page.goto("./play/beat/");
  const v = page.locator('.btm-day[data-state="verdict"]');
  await expect(v.locator(".btm-yours")).toHaveText("You didn't call this one. Here's how the models did.");
  await expect(v.locator(".btm-board tbody tr")).toHaveCount(5);
  await expect(v.getByRole("button", { name: "Share result" })).toHaveCount(0);
  await expect(page.locator('.btm-day[data-state="locked"] .btm-yours')).toHaveText("You didn't call this one.");

  await page.unrouteAll();
  await serve(page, { ...FILES, "2026-10-24.result.json": { ...verdict, high: null, void: true } });
  await page.reload();
  await expect(page.locator('.btm-day[data-state="verdict"]')).toContainText("No climate report came in for Atlanta");

  await page.unrouteAll();
  await serve(page, {});
  await page.reload();
  await expect(page.locator("#banner")).toHaveText("Today's city isn't posted yet. Check back soon.");
});

test("Beat the Models: a verdict that came a day late still shows once, for a day this browser called", async ({ page }) => {
  // Oct 26, after the run: Oct 27 open, Oct 26 locked, Oct 25's verdict, and Oct 24's, whose report came late
  await page.clock.setFixedTime(new Date("2026-10-26T14:00:00Z"));
  await serve(page, {
    "latest.json": { ...open, date: "2026-10-27", number: 4, lock: "2026-10-27T06:00:00Z" },
    "2026-10-26.models.json": { ...locked, date: "2026-10-26", number: 3, lock: "2026-10-26T05:00:00Z" },
    "2026-10-25.result.json": { ...verdict, date: "2026-10-25", number: 2, city: MSP, lock: "2026-10-25T05:00:00Z", high: 54 },
    "2026-10-24.result.json": verdict,
  });
  await page.addInitScript(() => {
    if (!localStorage.getItem("rtr:game:beat")) {
      localStorage.setItem("rtr:game:beat", JSON.stringify({ "2026-10-24": { call: 71, at: "2026-10-23T20:00:00Z" } }));
    }
  });
  await page.goto("./play/beat/");
  expect(await page.locator(".btm-day").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.state)))
    .toEqual(["verdict", "verdict", "locked", "open"]);
  await expect(page.locator(".btm-day").first().locator(".stamp")).toHaveText("Beat 2 of 5");
  // Seen once, it's saved; next time only the newest verdict shows
  await page.reload();
  await expect(page.locator(".btm-day")).toHaveCount(3);
  await expect(page.locator('.btm-day[data-state="verdict"] .btm-city-name')).toHaveText("Minneapolis, MN");
});

test("Beat the Models fits a phone without scrolling sideways", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.clock.setFixedTime(new Date("2026-10-25T14:00:00Z"));
  await serve(page, FILES);
  await page.goto("./play/beat/");
  await expect(page.locator(".btm-day")).toHaveCount(3);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
});
