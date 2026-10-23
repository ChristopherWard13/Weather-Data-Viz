import { expect, test } from "@playwright/test";

// Station ID (build plan G3) reads its puzzle from the data bucket. These tests
// serve a small puzzle of their own, so they don't depend on a day's reports.

const cities = [
  ["KAVL", "Asheville", "NC", "ASHEVILLE MUNICIPAL", 35.432, -82.537],
  ["KCOS", "Colorado Springs", "CO", "COLORADO SPRINGS", 38.81, -104.69],
  ["KATL", "Atlanta", "GA", "ATLANTA INTL ARPT", 33.63, -84.44],
  ["KSEA", "Seattle", "WA", "SEATTLE-TACOMA INTL", 47.44, -122.31],
];
const puzzle = {
  v: 1, game: "station", date: "2026-10-22", number: 1, made: "2026-10-23T10:30:00Z",
  credit: { text: "NWS daily climate reports and ASOS observations via the Iowa Environmental Mesonet", url: "https://mesonet.agron.iastate.edu/" },
  area: { id: "us", label: "Mainland US", lat: [23, 51], lon: [-126, -66] },
  guesses: 6, bands: [200, 500, 1000], spot: ["low", "gust", "rain", "dew", "change"],
  cities, answer: 0,
  cards: [
    { id: "clock", items: ["high_time", "low_time", "sky"] },
    { id: "wind", items: ["wind"] },
    { id: "humid", items: ["humid"] },
    { id: "dew", items: ["dew_max", "dew_min"] },
    { id: "normals", items: ["normal_high", "normal_low", "rain_year", "rain_year_normal"] },
    { id: "records", items: ["record_high", "record_high_year", "record_low", "record_low_year", "elev"] },
  ],
  values: {
    high_time: [923, 780, 943, 900], low_time: [338, 1436, 418, 360], sky: [0, 0.9, 0, null],
    wind: [6.4, 10, 6.4, 8], humid: [29, 36, 28, 60], dew_max: [39, 50, 47, 52], dew_min: [35, 40, 39, 45],
    normal_high: [68, 62, 72, 60], normal_low: [44, 34, 52, 45], rain_year: [40.2, 8.45, 35.3, 30],
    rain_year_normal: [40.77, 15.13, 40.94, 28], record_high: [82, 83, 88, 75], record_high_year: [1931, 2016, 1941, 1991],
    record_low: [23, 15, 33, 30], record_low_year: [1952, 1996, 1976, 1949], elev: [661, 1881, 315, 132],
  },
};

test.beforeEach(async ({ page }) => {
  await page.route("**/games/station/latest.json", (route) => route.fulfill({ json: puzzle }));
});

test("Station ID: a clue a guess, each miss compared, then the answer and a result to share", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // After the 10:30Z publish on Oct 23: the test puzzle (Oct 22) is the newest
  await page.clock.setFixedTime(new Date("2026-10-23T12:00:00Z"));
  await page.goto("./play/station/");
  await expect(page.locator("#hud-score")).toHaveText("1/6");
  await expect(page.locator(".sid-card-row")).toHaveText(["The day's clock"]);
  await expect(page.locator("#leftout")).toContainText("leave out the low, gusts, rain, dew point and the day-to-day change");
  await expect(page.locator("#board")).toContainText("3:23 pm");

  // A wrong guess by name: its values beside the mystery station's, its band, and the next clue
  const search = page.locator("#search");
  await search.fill("seattle");
  await search.press("Enter");
  await expect(page.locator("#guess")).toHaveText("Guess Seattle ▶");
  await search.press("Enter");
  await expect(page.locator("#hud-score")).toHaveText("2/6");
  await expect(page.locator(".sid-card-row")).toHaveText(["The day's clock", "Wind"]);
  await expect(page.locator(".sid-guess")).toHaveText([/Seattle, WA.*SEATTLE-TACOMA INTL.*Over 1,000 mi/s]);
  await expect(page.locator("#board tbody tr").filter({ hasText: "Average wind" })).toContainText("8 mph▼");

  // A name picked from the list
  await search.fill("Atlanta, GA · ATLANTA INTL ARPT");
  await expect(page.locator("#chosen")).toContainText("Atlanta, GA");
  await page.locator("#guess").click();
  await expect(page.locator(".sid-guess").nth(1)).toContainText("Under 200 mi");

  await search.fill("Asheville, NC · ASHEVILLE MUNICIPAL");
  await page.locator("#guess").click();
  await expect(page.locator("#summary")).toBeVisible();
  await expect(page.locator("#kicker")).toHaveText("Found in 3");
  await expect(page.locator("#answer")).toHaveText("Asheville, NC");
  await expect(page.locator("#squares")).toHaveText("⬛🟨🟩");
  // Every clue shows at the end, and the bar to guess with is gone
  await expect(page.locator(".sid-card-row")).toHaveCount(6);
  await expect(page.locator("#bar")).toBeHidden();
  await expect(page.locator("#board")).toContainText("2,169 ft");

  // Kept in this browser: a reload shows the finished game, and the landing page counts it
  await page.reload();
  await expect(page.locator("#kicker")).toHaveText("Found in 3");
  await page.goto("./play/");
  await expect(page.locator('.hub-card[data-game="station"]')).toContainText("3/6");
  expect(errors).toEqual([]);
});

test("Station ID fits a phone without scrolling sideways", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.clock.setFixedTime(new Date("2026-10-23T12:00:00Z"));
  await page.goto("./play/station/");
  await expect(page.locator("#hud-score")).toHaveText("1/6");
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
});
