# Creator review: building a week-ahead CONUS video on Run to Run Wx

Reviewed 2026-10-12, 16:00–16:50Z, on the live site (`runtorunwx.com`). The latest runs were GFS
06Z, AIFS 06Z, AIGFS 06Z, the 06Z ensemble means, and ECMWF from 2026-10-11 12Z (see
[Q1](#q1-ecmwf-isnt-updating-and-nothing-says-so)).

**Point of view:** a meteorologist who makes model-breakdown videos for a broad YouTube audience,
prepping the week of Oct 12–19 for the continental US. The test was whether the full
video can be built on this site: synoptic → surface → mesoscale → confidence.

**How it was tested:** every field, mode and model was clicked through in a browser; 19
captures were taken at 1920×1080 (a typical screen-record size) and at 390 px on a phone; two
frames were downscaled to 480p JPEG to mimic YouTube on a phone; loop playback was timed; text
contrast and palette color distances (CIELAB ΔE, plus a deuteranopia simulation) were measured.
Numbers are in the [appendix](#appendix-measurements).

## Verdict

The site is fast, honest and well labelled, and it already does the one thing most model
sites don't: **run-to-run trend and same-grid model difference maps**. That is a real hook for
a channel built around model disagreement.

It isn't yet a place to *produce* a week-ahead video. Three things block that:

1. **Capture.** The map takes up 31% of a 1080p screen. The title, valid time and color bar sit
   outside the map, so cropping in an editor loses them. At 480p the contour labels and state
   lines disappear, and there are no cities to point at.
2. **The fields a week-ahead story runs on are missing:** height anomalies, precipitation
   totals, ensemble spread, and any severe or winter-hazard field.
3. **Freshness.** ECMWF hasn't updated since its manual run. The site was showing a 28-hour-old
   ECMWF as "12Z", next to today's GFS 06Z, and compare mode paired them without a warning.

Acts 1 and 2 of the video can be made today, with cropping in post and the numbers read
aloud. Act 3 can't be made here at all. Act 4 is half there.

## What already works (keep it)

- **Switching model keeps the valid time.** Flipping GFS → ECMWF → AIFS at Sat 00Z is one
  click, and the title updates. This is the core move of a model-comparison video.
- **Trend mode** (current run minus a 6/12/24/48 h older run, same valid time) and the
  **difference map** (GFS − ECMWF on the same grid) are the most distinctive things on the
  site. Red/blue diverging scales with clipped-end arrows read well and are safe for colour-blind viewers.
- **It says when a model can't show something:** "Not shown: AIFS, AIGFS, GEFS mean… (no gust
  output)", the per-model gust notes, and "this model doesn't output type". Viewers who know
  models will trust this.
- **H/L centers with pressures**, the 32 °F and 0 °C lines, flow chevrons on isotachs, and the
  hover readout that names the grid point.
- **Speed.** Frames are about 30 KB, cached at the CDN edge (miss 0.54 s, hit 0.18 s);
  manifests are about 1.3 KB compressed. No console errors on any of the 18 views tested.
- Keyboard shortcuts (←/→, Space, 1–8, Esc), URL state for every view, and the region
  breadcrumb.

## The video I tried to build

| Act | What the story needs | On the site | Gap |
|---|---|---|---|
| 1. Pattern | 250 mb jet + streaks; 500 mb heights, **anomalies**, shortwaves; how the pattern trended | Jet speed with isotachs and flow chevrons; 500 mb heights + vorticity; trend mode | No anomalies (A1). Vorticity is speckled (Q10). No 500 mb winds, 250 mb heights or divergence (A4) |
| 2. Surface | MSLP + fronts/thickness + QPF; temperatures vs normal; wind | MSLP isobars, H/L and 6-h precip by type; 2 m T/Td; 10 m wind/gust (kt) | No precip totals (Q3). No 1000–500 thickness, temperature anomalies or daily max/min (A1, A4). Units in kt (Q14) |
| 3. Threats | CAPE/shear/SRH, simulated reflectivity, snowfall, PWAT/IVT, soundings | Nothing | All of A4 and A5 |
| 4. Confidence | Model roundup, ensemble spread and probabilities, how runs trended | 2-up compare + difference; three ensemble means; trend | Ensemble means only, with no spread (A2). Compare silently pairs runs of different ages (Q1, Q8). 2-panel limit (A6) |

---

## Backlog

**High Impact / Quick Win:** front-end or config work on data already in R2, roughly a day or
two each. **Major Architectural Gap:** needs new data, new pipeline products, or a new
rendering or export subsystem.

Effort: XS < ½ day · S ≈ 1 day · M ≈ 2–4 days · L = a phase. Dimensions: **WF** workflow and
storytelling · **DATA** meteorological data and fields · **VIS** visuals, color, map ·
**UX** UI/UX and accessibility.

### High Impact / Quick Wins (ranked)

| # | Item | Dim. | Effort |
|---|---|---|---|
| Q1 | ECMWF isn't updating, and nothing says so | DATA · UX | S |
| Q2 | Presentation mode for clean capture | WF · VIS | S–M |
| Q3 | Precipitation totals from the 6-h frames already stored | DATA · WF | M |
| Q4 | US local time next to Z | WF · UX | S |
| Q5 | Loop controls: speed, range, preload | WF | S |
| Q6 | Legibility at 480p–720p | VIS | S |
| Q7 | City and state labels | VIS | S–M |
| Q8 | Fair model comparisons (run age, compare run picker) | DATA · WF | S |
| Q9 | Fix the precipitation-type palette | VIS · UX | S |
| Q10 | Smooth 500 mb vorticity | DATA · VIS | S |
| Q11 | Give ensemble-mean 500 mb something to shade | DATA · VIS | XS |
| Q12 | Rundown presets for a show | WF | M |
| Q13 | One time axis for every model | UX | S |
| Q14 | mph and °F/°C toggles | UX | XS–S |
| Q15 | Center the projection on the region | VIS | S |
| Q16 | Lead-time-aware trend and difference scales | VIS | S |
| Q17 | Open on a map viewers understand | UX | XS |
| Q18 | Bugs and copy fixes | UX | XS each |

#### Q1. ECMWF isn't updating, and nothing says so

- **Found:** the ECMWF manifest was generated 2026-10-12 02:49Z by a manual run. The scheduled
  runs at 07:52Z and 08:37Z never started: `gh run list --workflow ecmwf.yml` shows only that
  manual dispatch. At 16:40Z the chip read "ECMWF 12Z", meaning 2026-10-11 12Z, 28 h old,
  though today's 00Z run had posted around 07:36Z. The GFS and AIFS schedules did fire. The
  workflow comment already notes GitHub starting scheduled runs 3–5.5 h late; this is now over 8 h.
- **Why it matters:** ECMWF is the model viewers ask about most. A video that says "the Euro
  disagrees" while showing yesterday's Euro is wrong, and the comments will say so.
- **Fix:** (a) on each chip, show the run's day when it isn't today ("Sun 12Z"), and turn the
  chip amber when the run is more than one cycle plus normal latency old. (b) Use a trigger
  GitHub can't drop. For example, a Cloudflare Worker Cron Trigger that calls `workflow_dispatch`
  for each product, or an hourly catch-up schedule (an update with nothing to do is already a
  quick no-op). Until then, dispatch ECMWF by hand.

#### Q2. Presentation mode for clean capture

- **Found:** at 1920×1080 the map is about 1088×594 px, **31% of the frame** (see
  [image](img/h500-us-1080p.jpg)). The title, valid time and color bar are HTML outside the
  canvas, so cropping to the map loses them. The hover tooltip floats over the map. **Any click
  on the map zooms into a region**, which hijacks the click a creator uses to point or annotate
  during a live stream.
- **Why it matters:** every map in a video is screen-recorded. A full-frame map that carries its
  own title means no cropping in post. Viewers who screenshot it keep the model, valid time and
  attribution.
- **Fix:** `P` or `?present=1` hides the sidebars, model bar and footer; the map fills a 16:9
  frame. Draw onto the canvas a title strip (model · run · valid time in local and Z · F-hour ·
  "Day 3"), the color bar, and a small `runtorunwx.com` mark. Hide the tooltip and turn off
  click-to-zoom (keep the selector and Esc). Add a 9:16 option for Shorts.

#### Q3. Precipitation totals from the 6-h frames already stored

- **Found:** only 6-hour precipitation. There are no 24, 48 or 72 h, Days 1–7, or run totals.
- **Why it matters:** "How much rain this week?" is the question viewers ask most. GFS vs
  ECMWF 7-day QPF is also the clearest model-disagreement chart there is.
- **Fix:** sum the 6-h `qpf` frames in the browser over a chosen window. A 7-day total is 28
  frames of about 30 KB, under 1 MB and already cached at the edge. It works for every model
  and in compare and difference modes unchanged. Types can't be summed, so show liquid, or
  liquid with a "% frozen" overlay. Snowfall is in A4.

#### Q4. US local time next to Z

- **Found:** every time is UTC. The scrubber's "Thu 15 Oct 00Z" is **Wednesday** 8 PM EDT /
  5 PM PDT, and the day ticks (Tue 13, Thu 15, …) are UTC days.
- **Why it matters:** viewers plan around "Wednesday evening". An 00Z frame labelled Thursday
  tells most of the audience the wrong day, and the creator converts in their head on camera.
- **Fix:** show "Wed 8 PM ET · Thu 00Z" with a remembered zone picker (ET, CT, MT, PT, UTC),
  and a lead-day label ("Day 3"). Put the same text in the presentation-mode title.

#### Q5. Loop controls: speed, range, preload

- **Found:** playback is fixed at 700 ms a frame (about 1.4 fps) and always loops over the
  model's whole range. For GFS that's 65 frames, 45 s per loop. On a cold cache the map lagged
  the clock by up to **1.7 s**, with the spinner visible **15% of the time**; the second pass
  was clean (precip and compare views; prefetch covers ±2 steps).
- **Why it matters:** loops are the B-roll of every model video. A creator needs a 7-day loop,
  not 16 days, that runs clean the first time when live.
- **Fix:** a speed control (about 1–8 fps); loop start and end handles with a "Next 7 days"
  preset; a 1–2 s pause on the last frame; a "Preload loop" button with progress (fetch the
  range for every field the view draws); Shift+←/→ to step ±24 h (the same hour each day).

#### Q6. Legibility at 480p–720p

- **Found:** contour labels are a fixed 11 px ([contours.ts:179](../../web/src/contours.ts#L179)),
  500 mb height lines 1.1 px, and state lines thin and light. In a 480p downscale
  ([image](img/h500-us-480p-sim.jpg)) the height and isobar labels and the state lines are gone;
  only the H/L letters survive.
- **Why it matters:** much of a YouTube audience watches on phones at 480p–720p. A label they
  can't read is a number the creator has to say aloud.
- **Fix:** in presentation mode, scale with the canvas: labels 15–16 px with a white halo,
  contours about 2 px, darker state lines, fewer but larger labels.

#### Q7. City and state labels

- **Found:** no cities and no state labels at any zoom.
- **Why it matters:** "the heaviest band sets up over Chicago" needs a Chicago on the map.
  Viewers find themselves first, then listen.
- **Fix:** about 30 metro dots with labels (the largest TV markets), plus state abbreviations
  at region zoom, behind an overlay toggle. Add more cities at region zoom.

#### Q8. Fair model comparisons

- **Found:** compare mode pairs each model's latest run that reaches the valid time. Here that
  was GFS 06Z today against ECMWF 12Z yesterday (F114 vs F132), with the run times only in
  small captions ([image](img/compare-side.jpg)). The other model's run can't be chosen, so a
  same-cycle comparison (00Z vs 00Z) isn't possible.
- **Why it matters:** comparing runs of different ages and calling it disagreement is a classic
  mistake, and model-literate viewers notice. Same-cycle comparisons also show which model
  started from a better analysis.
- **Fix:** a run picker for the compare model, with a "same cycle" option, and a banner when
  the two runs started more than 12 h apart ("ECMWF is 18 h older").

#### Q9. Fix the precipitation-type palette

- **Found:** 40 colors (4 types × 10 bins).
  - Rain 1.5" (`#ec7a2e`) and sleet 0.5" (`#db6d1f`) are **ΔE 5.2** apart: the same color to a
    viewer.
  - With deuteranopia simulated, rain 0.01" and sleet 0.01" are ΔE 5.1 apart, and rain 1.5"
    and sleet 0.25" are 4.0 apart.
  - The lightest snow bin is ΔE 11.9 from the map background, so light snow almost disappears,
    worse after compression.
- **Why it matters:** the type map is where viewers decide whether it's rain or snow where they
  live. If heavy rain and moderate sleet look the same, the map says the wrong thing. About 1
  in 12 men have red-green colour blindness.
- **Fix:** use 5–6 bins per type on typed maps (viewers can't read 40 colors). Move sleet to a
  low-saturation tan or brown family, and keep snow in blues so it doesn't run into freezing
  rain's magentas. Make the lightest bins stand out from the background. Add a check to
  [palettes.test.ts](../../web/tests/palettes.test.ts) that no two type and bin colors fall
  under ΔE 15, with and without deuteranopia simulated.

#### Q10. Smooth 500 mb vorticity

- **Found:** GFS absolute vorticity computed on the 0.25° grid is speckled across the West,
  Mexico and areas of convection. ECMWF's is visibly smoother, so side by side the GFS looks
  noisier than its pattern really is ([image](img/compare-side.jpg)).
- **Why it matters:** shortwaves should read as lobes viewers can follow through a loop.
  After YouTube compression, speckle turns into blocky smudges.
- **Fix:** smooth the same way for every model before shading, in the browser at render time,
  so no stored frame changes. A few passes of a 9-point smoother, or a Gaussian of about 1°,
  would do. Start the shading at about 14–16 ×10⁻⁵ s⁻¹.

#### Q11. Give ensemble-mean 500 mb something to shade

- **Found:** GEFS mean at F162 peaked at 15 ×10⁻⁵ s⁻¹ and the palette is near-white below about
  14, so the map is bare contours ([image](img/gefs-mean-500.jpg)). The vorticity of an ensemble
  mean doesn't mean much anyway.
- **Why it matters:** the ensemble mean is the creator's "most likely pattern" slide, and it's
  currently the least visual map on the site.
- **Fix:** for the three ensemble means, open 500 mb on heights with no vorticity shading, or
  the height trend, until anomalies exist (A1). Then default to the anomaly.

#### Q12. Rundown presets for a show

- **Found:** every URL is rewritten with `run=` pinned, so a list of bookmarks for a weekly show
  goes stale. The 1–8 keys run surface-first, the reverse of a top-down story.
- **Why it matters:** a creator should prepare the show once and run it live from a clicker.
  This turns about 30 clicks into 8 key presses.
- **Fix:** a "Rundown": an ordered list of saved views (field, model, region, mode, and a
  lead time such as +72 h rather than a fixed run). PageDown and PageUp step through it.
  Add a `run=latest` link form. Ship a default rundown: jet → 500 mb → 850 mb → MSLP and precip
  → temperatures → totals.

#### Q13. One time axis for every model

- **Found:** the scrubber spans each model's own run. Switching GFS → ECMWF at the same valid
  time moves the thumb and relabels the axis (GFS: Tue 13…Tue 27; ECMWF: Mon 12…Mon 26).
- **Why it matters:** the model flip is the site's signature move. On a recording, a jumping
  scrubber looks like the time changed.
- **Fix:** one valid-time axis from now to the longest range, shared by every model, with each
  model's coverage shaded, daily ticks, and an optional zoom to Days 1–7.

#### Q14. mph and °F/°C toggles

- **Found:** wind and gusts are in knots only. 850 mb is in °C, with °F only in the hover
  readout. Height differences are in metres while the contours are in decametres.
- **Why it matters:** a US audience thinks in mph. A 40 kt gust is 46 mph, and that conversion
  is friction on air.
- **Fix:** unit toggles, remembered, with mph and °F as the presentation-mode defaults. Show
  height differences in dam.

#### Q15. Center the projection on the region

- **Found:** every region uses a Lambert conic centred on −110°
  ([projection.ts:25](../../web/src/projection.ts#L25)). In Mainland US and the eastern regions
  the East Coast and Florida look rotated clockwise.
- **Why it matters:** viewers know the US shape from TV maps. A tilted Northeast looks wrong to
  them even if they can't say why.
- **Fix:** when focusing a region, centre the projection on its longitude (about −96° for
  Mainland US). The refit code already exists.

#### Q16. Lead-time-aware trend and difference scales

- **Found:** the 500 mb trend and difference scale is fixed at ±60 m. At F114 values reached
  +224 and −224 m, so most of the trough is one saturated color.
- **Why it matters:** a fixed scale is right for loops, since a color means the same thing on
  every frame. But a saturated blob hides where the change is biggest, which is the point of
  the map.
- **Fix:** fixed scales that grow with lead time and stay constant within a loop, e.g. ±60 m
  for days 1–2, ±120 m for days 3–5, ±180 m after that. Apply the same idea to temperature and
  wind.

#### Q17. Open on a map viewers understand

- **Found:** the home page opens on the 250 mb jet *trend* (48 h lag) at F000 over North
  America. At F000 that compares the analysis with a 2-day-old forecast, which makes it the
  most abstract view on the site.
- **Why it matters:** viewers who follow a link from a video description land on an
  unexplained difference map and leave.
- **Fix:** open on the 500 mb forecast for Mainland US, or on the visitor's last view.

#### Q18. Bugs and copy fixes

- **"Max frozen" ignores the zoomed region**
  ([views/precip.ts:51](../../web/src/views/precip.ts#L51) loops over the whole grid). Zoomed into
  the Northeast, it reported 0.81" of snow at 39.3°N 107.0°W, in Colorado
  ([image](img/northeast-precip.jpg)). Use the same region clamp as `extreme()`.
- **The compare-with picker cuts off "HGEFS mean"** as "HGE / me" even at 1920 px wide
  ([image](img/compare-side.jpg)). Use a dropdown, or wrap.
- **The difference legend says "500 mb heights and vorticity minus ECMWF's"**, but only
  heights are differenced ([main.ts:509](../../web/src/main.ts#L509) uses the field item's noun).
- **Untyped precipitation shows the same message twice:**
  [colorbar.ts:153](../../web/src/colorbar.ts#L153) and the caption in
  [views/precip.ts](../../web/src/views/precip.ts#L64).
- **Contrast:** `#64748b` on `#f3f5f8` at 11.5–12 px (field sub-labels, "Click a region to
  zoom") is 4.36:1, just under WCAG AA's 4.5:1. Everything else measured passed.
- **About 800 px wide:** the footer runs under the pinned timeline, and "Tue 27" wraps onto two
  lines.

### Major Architectural Gaps (ranked)

| # | Gap | Dim. | Effort |
|---|---|---|---|
| A1 | Anomalies against a climatology | DATA · WF | L |
| A2 | Ensemble spread, probabilities and spaghetti | DATA | L |
| A3 | Tools for telling run-to-run stories | WF · DATA | M–L |
| A4 | Hazard, mesoscale and level fields | DATA | L |
| A5 | Soundings, meteograms and plumes for cities | DATA · WF | L |
| A6 | Multi-panel views and export | WF · VIS | M–L |
| A7 | Rendering and basemap quality | VIS | M |
| A8 | Showing model bias and initialization | DATA · WF | M |

#### A1. Anomalies against a climatology

- **Gap:** there are no anomalies for 500 mb height, 850 mb temperature or 2 m temperature.
- **Why it matters:** "trough East, ridge West" *is* the week-ahead story, and anomaly shading
  shows it at a glance even to viewers who don't read contours. "15° above normal" is the most
  shareable line in a video.
- **Build:** a static climatology product on `na025`, for example ERA5 1991–2020 means for each
  day of year and cycle hour, smoothed and stored once in R2. Add an "Anomaly" mode beside
  Forecast, Trend and Compare that subtracts it in the browser, so every model, region and
  compare view gets anomalies at once. The anomaly mean of the ensembles then fixes Q11.

#### A2. Ensemble spread, probabilities and spaghetti

- **Gap:** only ensemble *means*. Means smear out features and understate extremes, and they
  can't show agreement.
- **Why it matters:** confidence is the thing viewers most need from a model video. A spread
  map, a probability of more than 1" of rain or 6" of snow, and spaghetti of the 552 and
  570 dam lines turn "models disagree" into a visual.
- **Build:** compute spread and threshold probabilities on the pipeline side from the GEFS
  members (`pgrb2ap5`, 31 members), and store only the derived fields. For ECMWF ENS, verify
  first whether the open-data probability products cover what's needed before downloading 50
  members (the build plan notes the 50× cost). For spaghetti, store one contour field per member
  at a few chosen levels.

#### A3. Tools for telling run-to-run stories

- **Gap:** trend mode compares two runs. The site's namesake story, how the forecast for one
  moment changed run by run, needs more than that.
- **Why it matters:** "watch the GFS shift this low 200 miles west over the last 6 runs" is a
  signature segment, and nothing else on the web makes it easy.
- **Build:**
  - A **run loop**: a fixed valid time animated across all 9 retained runs, with the run in the
    title.
  - **Low tracking:** the H/L detection already exists. Plot low centers across runs and across
    models on one map, colored by run age.
  - **Longer retention** of a few lead times, so a day-5 forecast can be checked against what
    happened (see A8).

#### A4. Hazard, mesoscale and level fields

- **Gap:** for the threats act, nothing. Missing, by priority:
  - **Winter:** 1000–500 mb thickness (the 540 line, as an overlay on precipitation), snowfall
    (10:1 from what's already fetched for type; Kuchera needs column temperatures), snow depth,
    and 925 mb temperature.
  - **Severe:** surface-based and most-unstable CAPE, 0–6 km shear, 0–1 and 0–3 km SRH,
    composite parameters (STP/SCP), and simulated reflectivity (with the Phase 5 regionals).
  - **Moisture:** precipitable water, 850 mb winds and heights (low-level jet), and IVT for
    atmospheric rivers.
  - **Pattern:** 500 mb winds, 250 mb heights and divergence, and 700 mb RH and vertical
    velocity.
  - **Temperatures:** daily max and min (GFS TMAX/TMIN; 6-hourly frames miss the afternoon
    high).
  - **Correctness:** 850 mb temperature is shaded where 850 mb is underground over the
    Intermountain West. Mask it with a surface-pressure or terrain field.
- **Why it matters:** without these the video stops at the pattern. Thickness and snowfall alone
  would carry most winter videos.
- **Build:** each field is the [adding-a-field](../adding-a-field.md) recipe. The AI models lack
  most of them, and the "Not shown" note already handles that honestly. Do thickness and
  snowfall first.

#### A5. Soundings, meteograms and plumes for cities

- **Gap:** no point data. A click on a city can't show a forecast over time or a profile.
- **Why it matters:** "here's the NAM sounding over Oklahoma City" and a meteogram comparing
  models for one city are staples. A GEFS plume is the best one-chart summary of uncertainty.
- **Build:** extend Phase 6's points output (`points/<product>/<run>.json`) to a city list, with
  a time series for every model. Soundings need pressure-level columns, so start with the
  regionals and GFS.

#### A6. Multi-panel views and export

- **Gap:** compare mode shows two panels of about 540×295 px. There's no image or video export.
- **Why it matters:** the "four models, one valid time" grid is the roundup shot. Exporting a
  PNG at 1080p or 4K, or an MP4 loop with its title drawn in, skips screen-recording altogether.
- **Build:** a 2×2 or 3×2 layout using the same region and valid time. Offscreen rendering at a
  fixed resolution, and frame-by-frame export with WebCodecs or MediaRecorder, reusing the
  presentation-mode title strip from Q2.

#### A7. Rendering and basemap quality

- **Gap:** at region zoom the 0.25° precipitation bins show as stair-stepped squares
  ([image](img/northeast-precip.jpg)). There's no terrain, no county lines and no dark theme.
- **Why it matters:** blocky edges look low-budget on a big screen. Terrain explains upslope
  snow and rain shadows without a word.
- **Build:** draw categorical bins as filled contour polygons rather than pixels. Add an
  optional hillshade layer, county lines at region zoom, and a dark basemap. Phase 5's
  `conus005` grid fixes most of the blockiness for the regionals.

#### A8. Showing model bias and initialization

- **Gap:** there's no way to show a model's known tendencies, or how well it started.
- **Why it matters:** "the GFS tends to rush this kind of trough east" and "the AI models
  smooth out extremes" are the commentary that makes a channel worth watching. Showing F000
  differences between models (initialization spread) and checking last week's day-5 forecast
  against reality earn trust.
- **Build:** add known biases to the Phase 6 model cards. Add an F000 compare preset. For
  verification, keep the analysis and selected lead times beyond the 9-run window; today the
  48 h maximum lag can't reach a day-5 forecast.

### Already in the build plan (not repeated above)

GEM and ICON (Phase 4); HRRR, NAM, RRFS, HiResW, RDPS and HRDPS with 3-hourly frames (Phase 5);
model cards, transaction wire and scoreboard (Phase 6). From a creator's point of view,
**Q1–Q9 plus A1 and A3 would do more for the channel than Phase 4**. A video about GFS vs ECMWF
with anomalies and totals beats one with two more models and no anomalies. The regionals in
Phase 5 are what unlock Act 3, together with A4.

---

## Appendix: measurements

**Environment:** Playwright Chromium at 1920×1080 (desktop) and 390×844 @3× (phone), against
the live site, 2026-10-12 16:40–16:50Z.

**Load and caching**

| Item | Result |
|---|---|
| HTML | 7 KB, 0.15 s |
| Manifests (7, loaded at startup) | ~1.3 KB each compressed, 0.25–0.31 s, `max-age=60`, not cached at the edge (`cf-cache-status: DYNAMIC`) |
| Frame (`aigfs` precip F126) | 29.5 KB; first request `MISS` 0.54 s, second `HIT` 0.18 s; `immutable` |
| Data requests per view | 12–27 (single map 12–17; side by side or barbs 27) |
| Console errors and warnings | none on any of the 18 views |

**Loop playback** (15 s from F000; `#fhr-readout` and map pixels sampled every 50 ms)

| View | Pass | Frames shown | Worst lag of map behind clock | Spinner visible |
|---|---|---|---|---|
| GFS precip, Mainland US | cold | 22 | 1.7 s | 15% of samples |
| GFS precip, Mainland US | warm | 22 | 0 | 0% |
| GFS vs ECMWF 500 mb, side by side | cold | 22 | 0.9 s | 15% |
| GFS vs ECMWF 500 mb, side by side | warm | 22 | 0 | 0% |

**Text contrast:** everything passed WCAG AA except `#64748b` on `#f3f5f8` at 11.5–12 px (4.36:1).

**Precipitation-type palette, closest pairs (CIELAB ΔE76; under about 10 is hard to tell
apart, especially after compression)**

| Pair | Normal vision | Deuteranopia |
|---|---|---|
| Rain 1.5" vs sleet 0.5" | 5.2 | 5.2 |
| Rain 1.5" vs sleet 0.25" | 9.4 | 4.0 |
| Rain 0.01" vs sleet 0.01" | 26.8 | 5.1 |
| Rain 2" vs sleet 0.75" | 23.1 | 4.3 |
| Lightest snow bin vs map background | 11.9 | — |

**Freshness at 16:40Z**

| Product | Latest run on site | Scheduled runs that fired |
|---|---|---|
| GFS | 2026-10-12 06Z | 02:40, 13:32, 15:50Z |
| AIFS | 2026-10-12 06Z | 13:34, 16:05Z |
| ECMWF | **2026-10-11 12Z** (28 h old) | **none** (07:52Z and 08:37Z didn't start) |

Images for this review are in [img/](img/): the 500 mb map at 1080p, the same map at a simulated
480p, the Northeast precipitation map, the GEFS mean at 500 mb, and side-by-side compare.
