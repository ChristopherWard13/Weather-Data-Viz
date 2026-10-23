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
    const m = await (await route.fetch()).json();
    m.runs.push({ ...m.runs[0], id: "2026102100" });
    await route.fulfill({ json: m });
  });
});

test("Wx Marks the Spot: drop pins, lock them in, see the answers and a score to share", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./play/spot/");
  await expect(page.locator("#round-count")).toHaveText("Round 1 of 2 · Hot spot");
  await expect(page.locator("#prompt")).toHaveText("Where did it hit 81 °F?");
  await expect(page.locator("#lock")).toBeDisabled();

  // A pin in the middle of the map (Kansas), then lock it in
  const map_ = page.locator("#map");
  const box = (await map_.boundingBox())!;
  await map_.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(page.locator("#lock")).toBeEnabled();
  await page.locator("#lock").click();
  await expect(page.locator("#result")).toContainText("Philip, SD had it: 81 °F.");
  await expect(page.locator("#result")).toContainText("The weather at your pin");
  await expect(page.locator("#result")).toContainText("Distance to the top spot");
  await expect(page.locator("#legend")).toContainText("Shading: GFS analysis");
  await expect(page.locator(".map-link")).toHaveAttribute("href", /[?&]run=2026102100(&|$)/);
  await expect(page.locator("#chips button").first()).not.toHaveText("1");

  await page.locator("#next").click();
  await expect(page.locator("#prompt")).toHaveText("Where did the wind gust to 47 mph?");
  await map_.click({ position: { x: box.width / 2, y: box.height / 3 } });
  await page.locator("#lock").click();
  // Gusts are stored in knots; a first-time player reads mph
  await expect(page.locator("#result")).toContainText("Bismarck, ND had it: 47 mph.");
  await expect(page.locator("#legend")).not.toContainText("Shading");
  await expect(page.locator("#next")).toHaveText("See my score");
  await page.locator("#next").click();
  await expect(page.locator("#summary")).toBeVisible();
  await expect(page.locator("#total")).toContainText("of 2,000 points");
  await expect(page.locator("#summary-rounds li")).toHaveCount(2);

  // Pins are remembered: a reload opens on the finished game
  await page.reload();
  await expect(page.locator("#summary")).toBeVisible();
  await expect(page.locator("#lock")).toBeHidden();
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
  await page.locator(".play-link").click();
  await expect(page).toHaveURL(/\/play\/$/);
  await expect(page.locator("h1")).toContainText("Daily weather games");
  await page.locator(".hub-game", { hasText: "Wx Marks the Spot" }).click();
  await expect(page).toHaveURL(/\/play\/spot\/$/);
  await expect(page.locator("h1")).toContainText("Wx Marks the Spot");
});
