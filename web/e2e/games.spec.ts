import { expect, test } from "@playwright/test";

// The daily games (build plan Phase G) read their puzzle from the data bucket.
// These tests serve a small puzzle of their own, so they don't depend on a
// day's real observations.

/** A 3 x 3 map over the Lower 48's box, every point 80 °F (byte 140 at offset -60). */
const map = {
  label: "GFS analysis: the warmer of 18Z and 00Z",
  grid: { lat0: 51, lon0: -126, dlat: -14, dlon: 30, ny: 3, nx: 3 },
  scale: 1, offset: -60, nodata: 255,
  data: Buffer.from(new Array(9).fill(140)).toString("base64"),
  link: { m: "gfs", v: "t2m", var: "temp", run: "2026102100", t: "2026102100" },
};

const puzzle = {
  v: 2, game: "spot", date: "2026-10-20", number: 20, made: "2026-10-21T10:30:00Z",
  credit: { text: "NWS ASOS observations via the Iowa Environmental Mesonet", url: "https://mesonet.agron.iastate.edu/" },
  area: { id: "us", label: "Mainland US", lat: [23, 51], lon: [-126, -66] },
  scoring: { value: 600, distance: 400, full_km: 25, scale_km: 250, reach_km: 150 },
  stations: [
    ["PHP", "Philip", "SD", 44.05, -101.6],
    ["PIR", "Pierre", "SD", 44.38, -100.29],
    ["RAP", "Rapid City", "SD", 44.05, -103.05],
    ["BIS", "Bismarck", "ND", 46.77, -100.75],
    ["LNK", "Lincoln", "NE", 40.85, -96.76],
  ],
  rounds: [
    {
      kind: "hottest", title: "Hottest high", unit: "°F", decimals: 0, best: 81, floor: 79,
      top: [0], i: [0, 1, 2, 3, 4], v: [81, 80, 79, 70, 75], map,
    },
    {
      kind: "gust", title: "Highest wind gust", unit: "kt", decimals: 0, best: 41, floor: 33,
      top: [3], i: [0, 1, 3, 4], v: [35, 33, 41, 20],
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/games/spot/latest.json", (route) => route.fulfill({ json: puzzle }));
  // The model maps still have the run the first round's map links to
  await page.route("**/gfs/manifest.json", async (route) => {
    try {
      const m = await (await route.fetch()).json();
      m.runs.push({ ...m.runs[0], id: "2026102100" });
      await route.fulfill({ json: m });
    } catch {
      // The page moved on before the manifest arrived (a test clicking through to another page)
    }
  });
});

test("Wx Marks the Spot: drop pins, lock them in, see the answers and a score to share", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // After the 10:30Z publish on Oct 21: the test puzzle (Oct 20) is the newest
  await page.clock.setFixedTime(new Date("2026-10-21T12:00:00Z"));
  await page.goto("./play/spot/");
  await expect(page.locator("#round-count")).toHaveText("Round 1/2");
  await expect(page.locator("#round-label")).toHaveText("Hot spot");
  await expect(page.locator("#prompt")).toHaveText("81 °F");
  await expect(page.locator("#detail")).toHaveText("Highest high");
  await expect(page.locator("#hud-score")).toHaveText("0");
  await expect(page.locator("#lock")).toBeDisabled();
  // The viewer's stylesheet also styles .chip: a hovered round button keeps the kit's look
  await page.locator("#chips button").nth(1).hover();
  expect(await page.locator("#chips button").nth(1).evaluate((b) => getComputedStyle(b).backgroundImage)).toContain("gradient");

  // A pin in the middle of the map (Kansas), then lock it in
  const map_ = page.locator("#map");
  const box = (await map_.boundingBox())!;
  await map_.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(page.locator("#lock")).toBeEnabled();
  await page.locator("#lock").click();
  // The tally: the top spot and the station nearest the pin, and both scores out of their maximums
  await expect(page.locator(".fact").first()).toContainText("Philip, SD");
  await expect(page.locator(".fact").first()).toContainText("81 °F");
  await expect(page.locator(".tile-weather")).toContainText("/600");
  await expect(page.locator(".tile-distance")).toContainText("/400");
  await expect(page.locator(".stamp")).toBeVisible();
  // The stamp pops and the tiles drop in, and a render afterwards (the buttons under the map changed) doesn't cut them short
  await page.waitForTimeout(250);
  await expect(page.locator("#result")).toHaveClass(/\bfresh\b/);
  const first = Number((await page.locator(".tile-total b").getAttribute("data-count"))!);
  await expect(page.locator(".tile-total b")).toHaveText(first.toLocaleString("en-US"));
  await expect(page.locator("#hud-score")).toHaveText(first.toLocaleString("en-US"));
  await expect(page.locator("#legend")).toContainText("Shading: GFS analysis");
  await expect(page.locator(".map-link")).toHaveCount(1);
  await expect(page.locator(".map-link")).toHaveAttribute("href", /[?&]run=2026102100(&|$)/);
  await expect(page.locator("#chips button").first()).toHaveAttribute("data-tier", /[0-3]/);

  await page.locator("#next").click();
  await expect(page.locator("#prompt")).toHaveText("47 mph");
  await map_.click({ position: { x: box.width / 2, y: box.height / 3 } });
  await page.locator("#lock").click();
  // Gusts are stored in knots; a first-time player reads mph
  await expect(page.locator(".fact").first()).toContainText("Bismarck, ND");
  await expect(page.locator(".fact").first()).toContainText("47 mph");
  await expect(page.locator("#legend")).toBeHidden();
  await expect(page.locator("#next")).toHaveText("Final score ▶");
  await page.locator("#next").click();
  await expect(page.locator("#summary")).toBeVisible();
  await expect(page.locator("#total")).toContainText("/ 2,000");
  await expect(page.locator("#summary-rounds tr")).toHaveCount(2);
  await expect(page.locator("#summary-rounds tr").nth(1)).toContainText("47 mph");
  // The day's score is saved, out of its maximum, for the Weather Games page
  const total = Number((await page.locator("#total b").getAttribute("data-count"))!);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("rtr:game:spot")!));
  expect(saved["2026-10-20"]).toMatchObject({ score: total, max: 2000 });
  // A round in the scoreboard opens that round again
  await page.locator(".board-round").first().click();
  await expect(page.locator("#prompt")).toHaveText("81 °F");

  // Pins are remembered: a reload opens on the finished game
  await page.reload();
  await expect(page.locator("#summary")).toBeVisible();
  await expect(page.locator("#lock")).toBeHidden();
  // ...and the Weather Games page shows it done
  await page.goto("./play/");
  await expect(page.locator('.hub-card[data-game="spot"] .hub-done')).toBeVisible();
  await expect(page.locator('.hub-card[data-game="spot"] .hub-score')).toHaveText(`${total.toLocaleString("en-US")} / 2,000`);
  expect(errors).toEqual([]);
});

test("Wx Marks the Spot says so when there's no puzzle", async ({ page }) => {
  await page.route("**/games/spot/2026-01-01.json", (route) => route.fulfill({ status: 404, body: "not found" }));
  await page.goto("./play/spot/?date=2026-01-01");
  await expect(page.locator("#banner")).toHaveText("There's no puzzle for 2026-01-01.");
  await expect(page.locator("#round")).toBeHidden();
});

test("the viewer links to the game", async ({ page }) => {
  await page.goto("./");
  await page.locator(".site-link", { hasText: "Weather Games" }).click();
  await expect(page).toHaveURL(/\/play\/$/);
  await expect(page.locator("h1")).toContainText("Weather Games");
  await page.locator(".hub-game", { hasText: "Wx Marks the Spot" }).click();
  await expect(page).toHaveURL(/\/play\/spot\/$/);
  await expect(page.locator("h1")).toContainText("Wx Marks the Spot");
});

test("every page links the site's two sections, and marks the one it's in", async ({ page }) => {
  await page.route("**/games/*/latest.json", (route) => route.fulfill({ status: 404, body: "not found" }));
  for (const [path, current] of [["./", "Models"], ["./play/", "Weather Games"], ["./play/spot/", "Weather Games"],
    ["./play/measured/", "Weather Games"]] as const) {
    await page.goto(path);
    // The viewer has loaded its run before the test clicks away
    if (path === "./") await expect(page.locator("#updated")).not.toBeEmpty();
    const links = page.locator(".site-nav .site-link");
    await expect(links).toHaveText(["Models", "Weather Games"]);
    await expect(page.locator('.site-link[aria-current="page"]')).toHaveText(current);
    await links.nth(current === "Models" ? 1 : 0).click();
    const other = current === "Models" ? "Weather Games" : "Models";
    await expect(page.locator('.site-link[aria-current="page"]')).toHaveText(other);
    if (other === "Models") expect(new URL(page.url()).pathname).not.toContain("/play/");
    else await expect(page).toHaveURL(/\/play\/$/);
  }
});

test("the Weather Games page lists the four games, and marks one finished today", async ({ page }) => {
  // 09:00Z on Oct 23, before that day's 10:30Z publish: the newest puzzles are still Oct 21's. A
  // finished Oct 21 Spot counts; a Modeled or Measured saved for Oct 22 isn't out yet, so it doesn't
  await page.clock.setFixedTime(new Date("2026-10-23T09:00:00Z"));
  await page.addInitScript(() => {
    localStorage.setItem("rtr:game:spot", JSON.stringify({ "2026-10-21": { guesses: [], score: 4734, max: 5000 } }));
    localStorage.setItem("rtr:game:measured", JSON.stringify({ "2026-10-22": { picks: [], score: 4, max: 5 } }));
  });
  await page.goto("./play/");
  await expect(page.locator(".hub-card")).toHaveCount(4);
  await expect(page.locator(".hub-card.hub-soon")).toHaveText([/Station ID.*Coming soon/s, /Don't Bust.*Coming soon/s]);
  await expect(page.locator(".hub-soon a")).toHaveCount(0);
  await expect(page.locator('.hub-card[data-game="spot"]')).toContainText("4,734 / 5,000");
  await expect(page.locator('.hub-card[data-game="spot"] .hub-done')).toBeVisible();
  await expect(page.locator('.hub-card[data-game="measured"]')).toContainText("Play");
  await expect(page.locator("#hub-played")).toHaveText("1/2");
  // The production build loads games.css after hub.css: the page's own rules still win (cascade layers)
  const soon = await page.locator(".btn-soon").first().evaluate((b) => getComputedStyle(b).color);
  expect(soon).toBe("rgb(51, 65, 85)");
  expect(await page.locator(".hub-next").evaluate((p) => getComputedStyle(p).marginBottom)).toBe("14px");
});

test("the top bar fits at every width, from phone to desktop", async ({ page }) => {
  await page.route("**/games/*/latest.json", (route) => route.fulfill({ status: 404, body: "not found" }));
  for (const width of [375, 641, 700, 761, 820, 880, 900, 901, 1000, 1001, 1024, 1180, 1360]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["./", "./play/"]) {
      await page.goto(path);
      if (path === "./") await expect(page.locator("#updated")).not.toBeEmpty();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `${path} at ${width} px scrolls sideways by ${over} px`).toBeLessThanOrEqual(0);
    }
  }
});
