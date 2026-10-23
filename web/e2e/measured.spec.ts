import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Modeled or Measured (build plan G2) reads its puzzle from the data bucket.
// These tests serve a small puzzle of their own; MM_PUZZLE=<path> also plays a
// real one (from `wxtrend game measured`) and saves screenshots to MM_SHOTS.

const grid = { lat0: 51, lon0: -126, dlat: -14, dlon: 30, ny: 3, nx: 3 };
const fill = (byte: number) => Buffer.from(new Array(9).fill(byte)).toString("base64");
/** Every cell different: rows 51, 37 and 23 N; columns 126, 96 and 66 W. Cell k is byte `first + k`. */
const ramp = (first: number) => Buffer.from(Array.from({ length: 9 }, (_, k) => first + k)).toString("base64");

const round = (over: Record<string, unknown>) => ({
  kind: "afternoon", title: "Afternoon temperature", field: "t2m", unit: "°F", decimals: 0,
  valid: "2026-10-21T21:00Z", scale: 1, offset: -60, nodata: 255,
  maps: [ramp(100), ramp(120)], answer: 1,
  measured: "Measured: NOAA's URMA, station observations analysed onto a 2.5 km grid",
  model: { id: "gfs", name: "GFS", run: "2026101712", lead: 105 },
  miss: { score: 0.5, rms: 4.2, bias: -4 }, ...over,
});

const puzzle = {
  v: 1, game: "measured", date: "2026-10-21", number: 1, made: "2026-10-22T10:30:00Z", credit: [],
  area: { id: "us", label: "Mainland US", lat: [23, 51], lon: [-126, -66] }, grid,
  rounds: [
    round({}),
    round({
      kind: "gust", title: "Afternoon wind gusts", field: "gust", unit: "kt", scale: 0.5, offset: 0,
      maps: [fill(60), fill(70)], answer: 0, miss: { score: 1, rms: 6, bias: 5 }, shift: 5,
    }),
  ],
};

test("Modeled or Measured: pick a map, see which was which, and a score to share", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/games/measured/latest.json", (route) => route.fulfill({ json: puzzle }));
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./play/measured/");
  await expect(page.locator("#round-count")).toHaveText("Round 1/2");
  await expect(page.locator("#round-label")).toHaveText("Afternoon temperature");
  await expect(page.locator("#prompt")).toHaveText("5 PM ET");
  await expect(page.locator("#detail")).toHaveText("Temperature");
  await expect(page.locator("#rule")).toHaveText("2 PM PT");
  await expect(page.locator("#result")).toHaveText("Which map was measured?");
  await expect(page.locator("#hud-score")).toHaveText("0/2");

  // The readout compares both maps under the pointer, cell by cell: near the top middle is
  // the northern row's middle column (cell 1), the west middle the middle row's first (cell 3)
  const box = (await page.locator("#map-0").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.15);
  await expect(page.locator("#readout .mm-chip")).toHaveText(["A41 °F", "B61 °F"]);
  await page.mouse.move(box.x + box.width * 0.18, box.y + box.height * 0.5);
  await expect(page.locator("#readout .mm-chip")).toHaveText(["A43 °F", "B63 °F"]);
  // The other map reads the same spot
  const other = (await page.locator("#map-1").boundingBox())!;
  await page.mouse.move(other.x + other.width / 2, other.y + other.height * 0.15);
  await expect(page.locator("#readout .mm-chip")).toHaveText(["A41 °F", "B61 °F"]);

  // Round 1: B was measured; pick A
  await page.locator("#pick-0").click();
  // The reveal: the verdict, which was measured, and the forecast's model, lead and bias as tiles
  await expect(page.locator("#result .stamp")).toHaveText("Wrong!");
  await expect(page.locator(".mm-answer")).toHaveText("B was measured");
  await expect(page.locator(".tile-model")).toContainText("GFS");
  await expect(page.locator(".tile-model")).toContainText("Sat 12Z run");
  await expect(page.locator(".tile-lead")).toContainText("4½");
  await expect(page.locator(".tile-bias")).toContainText("−4.0 °F");
  await expect(page.locator(".tile-bias")).toContainText("too cold");
  await expect(page.locator("#chips button").first()).toHaveAttribute("data-result", "wrong");
  await expect(page.locator("#badge-1")).toHaveText("Measured");
  await expect(page.locator("#badge-0")).toHaveText("GFS forecast");
  await expect(page.locator("#pick-0")).toBeHidden();

  // Round 2: A was measured; pick A. Gusts read in mph for a first-time player
  await page.locator("#next").click();
  await expect(page.locator("#round-count")).toHaveText("Round 2/2");
  await expect(page.locator("#round-label")).toHaveText("Afternoon wind gusts");
  await page.locator("#pick-0").click();
  await expect(page.locator("#result .stamp")).toHaveText("Correct!");
  await expect(page.locator(".mm-answer")).toHaveText("A was measured");
  await expect(page.locator(".tile-bias")).toContainText("+5.8 mph");
  await expect(page.locator("#result")).toContainText(
    "The forecast map was moved 5.8 mph calmer to match the measured average, so the average alone wouldn't give it away.");
  await expect(page.locator("#hud-score")).toHaveText("1/2");
  await expect(page.locator("#next")).toHaveText("Final score ▶");
  await page.locator("#next").click();
  await expect(page.locator("#total")).toHaveText("1 / 2");
  await expect(page.locator("#summary-rounds tr")).toHaveCount(2);
  await expect(page.locator("#summary-rounds tr").first()).toContainText("Afternoon temperature");
  await page.locator("#share").click();
  await expect(page.locator("#share-note")).toHaveText("Copied. Paste it anywhere.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^Modeled or Measured #1: 1\/2\n🟥🟩\n/);

  // Picks are kept: a reload opens on the summary
  await page.reload();
  await expect(page.locator("#total")).toHaveText("1 / 2");
  expect(errors).toEqual([]);
});

test("Modeled or Measured: a game left halfway picks up where it was, and in °C", async ({ page }) => {
  await page.route("**/games/measured/latest.json", (route) => route.fulfill({ json: puzzle }));
  await page.addInitScript(() => localStorage.setItem("rtr:display", JSON.stringify({ units: { temp: "C", speed: "kt" } })));
  await page.goto("./play/measured/");
  await page.locator("#pick-1").click();
  await expect(page.locator("#result .stamp")).toHaveText("Correct!");
  await expect(page.locator(".tile-bias")).toContainText("−2.2 °C");

  // Back after a reload: round 2 to play, round 1 done
  await page.reload();
  await expect(page.locator("#round-count")).toHaveText("Round 2/2");
  await expect(page.locator("#pick-0")).toBeVisible();
  await expect(page.locator("#chips button").first()).toHaveAttribute("data-result", "right");
  // Round 1 again from its chip: its reveal, then back to round 2
  await page.locator("#chips button").first().click();
  await expect(page.locator("#badge-1")).toHaveText("Measured");
  await expect(page.locator("#pick-0")).toBeHidden();
  const box = (await page.locator("#map-0").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.15);
  await expect(page.locator("#readout .mm-chip")).toHaveText(["GFS5 °C", "Measured16 °C"]);
  await page.locator("#chips button").nth(1).click();
  await expect(page.locator("#pick-0")).toBeVisible();
  await page.locator("#pick-0").click();
  await expect(page.locator(".tile-bias")).toContainText("+5.0 kt");
});

test("Modeled or Measured: a day with no puzzle says so", async ({ page }) => {
  await page.route("**/games/measured/2026-01-01.json", (route) => route.fulfill({ status: 404, body: "not found" }));
  await page.goto("./play/measured/?date=2026-01-01");
  await expect(page.locator("#banner")).toHaveText("There's no puzzle for 2026-01-01.");
  await expect(page.locator("#round")).toBeHidden();
});

test("the games' hub links to each game", async ({ page }) => {
  await page.route("**/games/measured/latest.json", (route) => route.fulfill({ json: puzzle }));
  await page.goto("./play/");
  await page.locator(".hub-game", { hasText: "Modeled or Measured" }).click();
  await expect(page).toHaveURL(/\/play\/measured\/$/);
  await expect(page.locator("h1")).toContainText("Modeled or Measured");
});

test("Modeled or Measured: a real puzzle", async ({ page }) => {
  test.skip(!process.env.MM_PUZZLE, "set MM_PUZZLE to a puzzle file");
  const real = JSON.parse(readFileSync(process.env.MM_PUZZLE!, "utf8"));
  const shots = process.env.MM_SHOTS ?? "test-results";
  await page.route("**/games/measured/latest.json", (route) => route.fulfill({ json: real }));
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const [name, size] of [["desktop", { width: 1360, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    await page.goto("./play/measured/");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator("#round-count")).toHaveText("Round 1/5");
    await page.screenshot({ path: `${shots}/mm-${name}-round1.png`, fullPage: true });
    await page.locator("#pick-0").click();
    const box = (await page.locator("#map-0").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
    await page.screenshot({ path: `${shots}/mm-${name}-reveal1.png`, fullPage: true });
    for (let k = 1; k < 5; k++) {
      await page.locator("#next").click();
      await page.locator("#pick-1").click();
    }
    await page.locator("#next").click();
    await expect(page.locator("#total")).toContainText("/ 5");
    await page.screenshot({ path: `${shots}/mm-${name}-summary.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});
