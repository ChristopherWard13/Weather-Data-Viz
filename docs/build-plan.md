# Build plan: Run to Run Wx

Agreed 2026-10-10. This turns the GFS Trend Viewer into **Run to Run Wx**
(`runtorunwx.com`), a multi-model site that maps every model a fantasy-league player can
pick: **if it's on the map, it's in the league.** Each quirk below comes with a decision, so
builders can execute without re-deciding. Items marked **Verify first** are facts not yet
confirmed, each with a fallback decision. Chris's decisions are recorded in
[Decisions](#decisions).

Read [adding-a-field.md](adding-a-field.md) first. Its conventions (search-regex anchoring,
row-delta frames, split fields by how the viewer loads them, never interpolate categories)
all still apply. It also has the recipe for adding a model.

## Status

| Phase | State |
|---|---|
| 0: Foundations | **Done** 2026-10-11. GFS updates through R2; the site and data are on `runtorunwx.com` |
| 1: ECMWF IFS, AIFS, new fields | **Done** 2026-10-11 (commit `2c7cfaa`): `hgt500`/`vort500`/`t850`, GFS to F384, the `ecmwf` and `aifs` products and workflows. All three products are in R2 (manifests at `data.runtorunwx.com`, checked 2026-10-12) |
| 2: Site organization | **Done** 2026-10-11 (commit `dfbabe6`): Run to Run Wx branding, model bar, Fields sidebar, valid-time scrubber, URL state v2, region focus, compare mode, phone sheets. No workflow changes. See [Phase 2](#phase-2-site-organization-m-can-run-in-parallel-with-phase-1-after-phase-0) for what was decided while building |
| 3: NOAA AI and ensemble means | **Done** 2026-10-12 (commits `f6c2602`, `e196b22`, `9843549`): AIGFS, GEFS mean, AIGEFS mean and HGEFS mean, each across its full range; `regrid.py`; the `nomads` adapter; category 5 "unspecified"; four workflows; the e2e fixture release. All four filled their 9-run windows in R2 on their first Actions runs (GEFS 10 min; AIGEFS 41, HGEFS 27 and AIGFS 41 min, paced against NOMADS). See [Phase 3](#phase-3-noaa-ai-and-ensemble-means-m) |
| 3.5: Creator pass | From the [creator review](reviews/2026-10-12-creator-review.md). **M1 Trust done** 2026-10-12: the scheduler Worker (commit `2372ec3`, live since 19:10Z), then late-run chips, fair comparisons, the 6-bin type palette, 500 mb heights shading, first-visit view, unpinned links and the Q18 fixes. M2 Time and M3 Presentation next, then decide. See [Phase 3.5](#phase-35-creator-pass-m1m3-then-decide) |
| 4–6 | Not started |

## Definition of done

- Every model in the [roster](#model-roster) updates on its own schedule, across its full forecast
  range, and appears in the model bar.
- The [12 canonical fields](#canonical-fields) render for every model that provides them.
  Combinations that don't exist aren't offered, and the model bar says which models are hidden
  and why.
- Global models open on North America; clicking a region focuses it.
- Forecast, trend and compare modes work for every model, aligned by valid time.
- Frames live in Cloudflare R2. Updating data no longer redeploys the site.
- The same pipeline writes venue point forecasts for the league.

## Decisions

Made by Chris on 2026-10-10. Builders treat these as settled.

| # | Question | Decision | Where it lands |
|---|---|---|---|
| 1 | Name and domain | **Run to Run Wx**, `runtorunwx.com` (registered at Namecheap). The site is served at `runtorunwx.com`, the data at `data.runtorunwx.com` | Phase 0, task 5; Phase 2 branding |
| 2 | 750 mb or 850 mb temperature | **850 mb.** ECMWF, ICON and HRRR don't output 750 mb; every model outputs 850 | `t850` (Phase 1) |
| 3 | Regional frame cadence | **3-hourly** for now; hourly later | Phase 5 |
| 4 | Forecast range | **Each model's full output range**, not a common cutoff. See [Forecast range](#forecast-range) | Every phase that adds a model |
| 5 | UKMO and JMA | **Left out of this build** | [Not in this build](#not-in-this-build) |
| 6 | Ensemble means | **Included:** GEFS, AIGEFS and HGEFS means | Phase 3 |
| 7 | Creator review (2026-10-12) | **M1–M3 of the creator pass before Phase 4**, then decide between more creator work and Phase 4 | [Phase 3.5](#phase-35-creator-pass-m1m3-then-decide) |
| 8 | What triggers the data jobs | **A Cloudflare Worker authenticated as a GitHub App**, with the GitHub crons kept as a backup. Chosen over a fine-grained token (App keys don't expire; runs and issues show as the app), a self-restarting workflow, and a server | [M1](#m1-trust) |
| 9 | Presentation frames | **16:9 and 9:16 from the start.** The layout is picked from silhouettes before going full screen, then each slot is filled; designed before it's built. No face-cam space: creators add that in post | [M3](#m3-presentation-mode) |

## Setup only Chris can do

Builders can't create accounts or handle credentials, so these are manual. The Phase 0 steps
are done (2026-10-11).

| Before | Step |
|---|---|
| Phase 0, task 3 | Create a Cloudflare account (free plan) and an R2 bucket. Turn on its `r2.dev` public URL for development |
| Phase 0, task 3 | Create an R2 API token with read/write on that bucket only |
| Phase 0, task 3 | Add GitHub Actions secrets to this repo: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` |
| Phase 0, task 5 | Add `runtorunwx.com` to Cloudflare, then switch the domain's nameservers at Namecheap to the two Cloudflare gives you. R2 custom domains need the domain's DNS to be on Cloudflare |
| Phase 0, task 5 | In the R2 bucket settings, connect the custom domain `data.runtorunwx.com` |
| Phase 0, task 5 | In GitHub, set **Settings → Pages → Custom domain** to `runtorunwx.com`, and add the DNS records GitHub lists in Cloudflare. Leave those records **DNS only** (grey cloud) so GitHub can issue the HTTPS certificate. Then tick **Enforce HTTPS** |
| After the Phase 1 push | ✓ Done: **Actions → ECMWF / AIFS / GFS → Run workflow** once each, so R2 has the new products and GFS's full range before the schedules fire |
| Before the Phase 3 push | ✓ Done 2026-10-12: the e2e fixture release [`e2e-fixtures-2026101200`](https://github.com/ChristopherWard13/Weather-Data-Viz/releases/tag/e2e-fixtures-2026101200) (`e2e-fixtures.tar.gz`, SHA-256 pinned in the `Makefile`). A new bundle means a new release and tag |
| Before the Phase 3 products go live | ✓ Done 2026-10-12: a one-off NOMADS probe passed on a GitHub runner, then was deleted |
| After the Phase 3 push | ✓ Done 2026-10-12: **Actions → AIGFS / GEFS mean / AIGEFS mean / HGEFS mean → Run workflow** once each; all four filled their 9-run windows in R2 |
| Phase 3.5, M1 (scheduler) | Create a **GitHub App** (GitHub → Settings → Developer settings → GitHub Apps → New): any name (e.g. `runtorunwx-scheduler`), homepage `https://runtorunwx.com`, webhook **off**, repository permissions **Actions: read and write** and **Issues: read and write**, installable only on this account. Note its **App ID**, generate a **private key** (a `.pem` downloads), then **Install App** on this repository only |
| Phase 3.5, M1 (scheduler) | In Cloudflare, create an **API token** from the "Edit Cloudflare Workers" template, limited to this account |
| Phase 3.5, M1 (scheduler) | Add GitHub Actions secrets: `CLOUDFLARE_API_TOKEN`, `SCHEDULER_APP_ID`, and `SCHEDULER_APP_KEY` (the whole `.pem`, pasted as downloaded). The account id is the existing `R2_ACCOUNT_ID`. Then **Actions → Scheduler → Run workflow** once to deploy the Worker |
| Phase 6 | Commit and push the `Forecast-Fantasy-League` repo, whose venue list Phase 6 reads |

## Decisions at a glance

| Topic | Decision | Why |
|---|---|---|
| Name and hosts | **Run to Run Wx.** Site at `runtorunwx.com` (GitHub Pages custom domain); data at `data.runtorunwx.com` (R2 custom domain) | Decision 1 |
| Data hosting | Frames and manifests in a **Cloudflare R2** bucket behind `data.runtorunwx.com`. The site's HTML/JS stays on GitHub Pages until the league charges money | The total is about 3.3 GB, over Pages' 1 GB limit. R2 has free egress and 10 GB free |
| Forecast range | Each product shows its model's **full output range** at its frame step. Trend comparisons that would need an hour past the older run's end show "comparison unavailable" (existing behaviour) | Decision 4. Storage stays well inside R2's free tier |
| Deploys | Data jobs write to R2 directly. **The site deploys only when code changes** | Removes the cache-then-redeploy loop and the per-deploy upload of all data |
| Source of truth | Each product's `manifest.json` in R2 lists exactly what exists. Jobs read it, add frames, write it last, then prune | Same rule as today ("never list a frame that isn't there"), moved to R2 |
| Display grids | Three fixed grids: `na025` (today's grid), `conus005`, `hi0025` | Model-agnostic frontend; the same grid makes difference maps and venue points trivial |
| Regridding | **One tool**: barycentric weights from any source points to a display grid, cached per source grid. Nearest neighbour for categories | Covers ICON's icosahedral cells, GDPS 0.15°, Lambert regional grids and later UKMO |
| Missing data | Frame format v3 reserves the dtype's top value (255 / 65535) as **nodata** | Regional grids don't fill a lat/lon box; HRDPS covers only a northern strip |
| Fields | One canonical catalog (same ids, bands, encodings for every model). Models declare which they provide | Views stay model-agnostic |
| Missing fields | **Never synthesize.** Derive only from the model's own fields (vorticity from u/v, dew point from T + RH). Otherwise mark unavailable | Honest comparisons, which matter for a league |
| Upper air | Add `hgt500`, `vort500` (computed from 500 mb u/v on the display grid), `t850` | Universal availability; vorticity computed the same way for every model |
| Precip product | "Previous 6 h" total plus dominant type, for every model at every frame | One unit across models; see [precip type per model](#precipitation-type) |
| Wind direction | Rotate grid-relative u/v to earth-relative before anything else. Prefer the provider's speed/direction fields when they exist (MSC) | Lambert and rotated grids store grid-relative winds |
| Config | `config/site.json`, `config/fields.json`, `config/grids.json`, `config/regions.json`, `config/models/<id>.json` | One file per model keeps additions self-contained |
| Scheduling | One reusable Actions workflow, one caller per product, cron set from **measured** availability. From Phase 3.5, a Cloudflare Worker starts each product's workflow once its next cycle is due; the crons stay as a backup | Products post at different times; one slow model never blocks another. GitHub drops and delays scheduled runs (decision 8) |
| Model bar | Grouped chips (Global · AI · Ensemble mean · Regional). **Only models that output the selected field and cover the current region get a chip**; the rest aren't shown | About 15 models won't fit as tabs, and a bar of only usable choices is easier to scan |
| Regions | Global models open on **North America**. Click a region on the map, or use the selector, to focus. About 8 multi-state regions, plus Mainland US and Hawaii; no state-level zoom | Focusing is just a new map extent: globals reuse the frames they already loaded, and focusing a mainland region reveals the regional models |
| Fields | Left sidebar grouped Surface / Upper air (today's tabs become sidebar items) | The model becomes the top-level choice |
| Time | Scrubber in **valid time**. Switching model keeps the field and valid time | The core scouting move: same moment, different model |

## Model roster

### In this build

| Model | Kind | Source (retention) | Runs | Display hours | Step | Trend lags | Native grid → display | Phase |
|---|---|---|---|---|---|---|---|---|
| GFS | Global | AWS `noaa-gfs-bdp-pds` (years) | 00/06/12/18 | **0–384** | 6 h | 6/12/24/48 | 0.25° → `na025` crop | 0; full range in 1 |
| ECMWF IFS | Global | GCS `ecmwf-open-data` (since 2025; [why not AWS](#ecmwf-open-data-source)) | 00/12 | **0–360** | 6 h | 12/24/48 | 0.25°, lon −180..180 → crop | 1 |
| ECMWF AIFS | AI | same mirror, `aifs-single/` | 00/06/12/18 | **0–360** | 6 h | 6/12/24/48 | 0.25° → crop | 1 |
| NOAA AIGFS | AI | NOMADS `aigfs/` (~11 days; [not on AWS](#noaa-ai-and-ensemble-sources)) | 00/06/12/18 | **0–384** | 6 h | 6/12/24/48 | 0.25° → crop | 3 |
| GEFS mean | Ensemble mean | AWS `noaa-gefs-pds` (since 2017), `geavg` in `pgrb2ap5` | 00/06/12/18 | **0–384** | 6 h | 6/12/24/48 | 0.5° → `na025` regrid | 3 |
| AIGEFS mean | Ensemble mean (AI) | NOMADS `aigefs/` (**2 days**), `ensstat` `avg` files | 00/06/12/18 | **0–384** | 6 h | 6/12/24/48 | 0.25° → crop | 3 |
| HGEFS mean | Ensemble mean (hybrid) | NOMADS `hgefs/` (**2 days**), `ensstat` `avg` files | 00/06/12/18 | 0–240 | 6 h | 6/12/24/48 | 0.25° → crop | 3 |
| GEM (GDPS) | Global | MSC Datamart (~30 days) | 00/12 | 0–240 | 6 h | 12/24/48 | 0.15° → `na025` regrid | 4 |
| ICON | Global | DWD opendata (~24 h) | 00/12 | 0–180 | 6 h | 12/24/48 | icosahedral 13 km → regrid | 4 |
| ARPEGE | Global, daily only | data.gouv.fr packages | 00/06/12/18 | 0–102 | 6 h | 6/12/24 | 0.25° → crop | 4 (optional) |
| HRRR | Regional | AWS `noaa-hrrr-bdp-pds` (since 2014) | 00/06/12/18 (48 h runs) | 0–48 | 3 h | 6/12/24 | 3 km Lambert → `conus005` | 5 |
| NAM 3 km | Regional | AWS `noaa-nam-pds`: `conusnest`, `hawaiinest` | 00/06/12/18 | 0–60 | 3 h | 6/12/24 | → `conus005` / `hi0025` | 5 |
| RRFS | Regional | AWS `noaa-rrfs-ops-pds` (since 2026-08-12) | 00/06/12/18 | 0–84 | 3 h | 6/12/24 | 3 km / 2.5 km → `conus005` / `hi0025` | 5 |
| HiResW | Regional | NOMADS `hiresw/` (2 days) | 00/12 | 0–48 | 3 h | 12/24 | → `conus005` / `hi0025` | 5 |
| RDPS | Regional | MSC Datamart | 00/06/12/18 | 0–84 | 3 h | 6/12/24 | 10 km rotated lat/lon → `conus005` | 5 |
| HRDPS | Regional | MSC Datamart | 00/06/12/18 | 0–48 | 3 h | 6/12/24 | 2.5 km → `conus005` (northern strip; rest nodata) | 5 |

A **product** is a model on one display grid: `gfs`, `nam-conus`, `nam-hi`, `rrfs-hi`, … The UI
shows the model name and picks the product from the region.

### Forecast range

Decision 4: every product shows its model's full output range. The display hours in the
roster are those maximums.

- **Fetch hours equal display hours.** Before Phase 1, GFS fetched past its display range (to
  F288) so that 48-hour comparisons reached F240. With full ranges there's nothing past the end to
  fetch. `fetch_hours` is `min(display_max + max_lag, model_max)` per product
  (`forecast_hours.model_max` in the model's config), which equals the display range for every
  product above. Comparisons that would need an hour past the older run's end show "comparison
  unavailable", as before.
- **Step:** globals stay 6-hourly for their whole range, even where a model posts more often (GFS
  hourly to F120, then 3-hourly; IFS hourly to F090, then 3-hourly to F144). One step keeps the
  trend-lag arithmetic and the scrubber uniform. Regionals are 3-hourly (decision 3).
- **Runs used** are the cycles that reach the full range: ECMWF uses 00/12Z (06/18Z stop at
  144 h) and ICON uses 00/12Z (06/18Z stop at 120 h).
- **ARPEGE:** use whatever the open-data packages contain. Some sources say the 12Z run reaches
  114 h; take the maximum found.
- **Deferred:** the GEFS 00Z run extends to 840 h (35 days), at 6-hourly steps from 246 h. That
  needs a once-a-day product and a different scrubber, so it's under [Later](#later).

### Not in this build

| Model | Why |
|---|---|
| KMA (UM-based) | Retired April 2026: Open-Meteo's archive has nothing after April |
| UKMO global 10 km | Left out by decision 5. On AWS Open Data (NetCDF, 2-year archive), but its licence is listed as CC BY-SA on the registry and non-commercial on a Met Office page |
| JMA GSM | Left out by decision 5. GRIB2 on JMA's own server; resolution and licence unclear |
| CMA GFS, BOM ACCESS-G | Open data mentioned, but access and terms unverified |
| NAVGEM / NEPTUNE | NOMADS `navgem/` is empty; no public NEPTUNE data |
| ECMWF ensemble mean | Open data publishes members only. A mean means downloading about 50× the data |

## Canonical fields

Encodings for existing fields are unchanged.

| id | Label | Bands (dtype, scale, offset) | New |
|---|---|---|---|
| `wspd250` / `wdir250` | 250 mb wind | speed uint8 1 kt · dir uint8 360/256°, wrap | |
| `t2m` | 2 m temperature | uint8 1 °F, −80 | |
| `d2m` | 2 m dew point | uint8 1 °F, −80 | |
| `wspd10` / `wdir10` | 10 m wind | as 250 mb | |
| `gust` | Wind gust | uint8 1 kt | |
| `mslp` | Sea-level pressure | uint16 0.1 hPa | |
| `precip` | 6-h precipitation and type | qpf uint16 0.01 in · ptype uint8 categories | ✓ Phase 3: category 5 "unspecified" (AIGFS, AIGEFS, HGEFS). Appending a label changes no frame's bytes; manifests pick it up on their next rewrite |
| `hgt500` | 500 mb height | uint16 1 m, 0 | ✓ Phase 1 |
| `vort500` | 500 mb absolute vorticity | uint8 1×10⁻⁵ s⁻¹, −50, nodata 255 (edges) | ✓ Phase 1 |
| `t850` | 850 mb temperature | uint8 0.5 °C, −60 | ✓ Phase 1 |

Per-hour storage on `na025` went from about 350 KB to 466 KB for GFS and ECMWF (measured); AIFS
fields are smoother and come to 299 KB.

### Availability

✓ native · D derived from the model's own fields · ✗ not output · ? verify first

| Model | Jet | T2m | Td2m | Wind10 | Gust | MSLP | Precip | Type | Hgt500 | Vort500 | T850 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| GFS | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ MSLET | ✓ | ✓ | ✓ | D | ✓ |
| ECMWF IFS | ✓ | ✓ | ✓ | ✓ | ✓ period max (1/3/6 h) | ✓ msl | D (Δtp) | D | ✓ gh | D | ✓ |
| ECMWF AIFS | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | D (Δtp) | D rain/snow | ✓ gh | D | ✓ |
| NOAA AIGFS | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ PRMSL | ✓ 6 h | ✗ (5) | ✓ | D | ✓ |
| GEFS mean | ✓ | ✓ | D (T + RH) | ✓ | ✗ | ✓ PRMSL | ✓ 6 h | D (member-mean 6-h fractions) | ✓ | D | ✓ |
| AIGEFS mean | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ PRMSL | ✓ 6 h | ✗ (5) | ✓ | D | ✓ |
| HGEFS mean | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ PRMSL | ✓ 6 h | ✗ (5) | ✓ | D | ✓ |
| GEM (GDPS) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ 6 h | D | ✓ | D | ✓ |
| ICON | ✓ | ✓ | ✓ | ✓ | ✓ vmax_10m | ✓ pmsl | D (Δtot_prec) | D rain/snow | ✓ fi/g | D | ✓ |
| HRRR | ✓ | ✓ | ✓ | ✓ rotate | ✓ | ✓ MSLMA | ✓ | D | ✓ | D | ✓ |
| NAM 3 km | ✓ | ✓ | ✓ | ✓ rotate | ✓ | ✓ MSLET | ✓ | D | ✓ | D | ✓ |
| RRFS | ✗ | ✓ | ✓ | ? | ✓ | ✓ MSLET | ✓ | D | ✗ | ✗ | ✗ |
| HiResW, RDPS, HRDPS, ARPEGE | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |

Verified so far: GFS; ECMWF and AIFS inventories (2026-10-09), then every field decoded and
built into frames across F000–F360 (2026-10-11); GEFS mean `pgrb2ap5` inventory and ranges; HRRR
`wrfsfc` and NAM `conusnest` inventories; RRFS `2dfld`, which has no pressure levels; ICON
pressure levels.

**Phase 3 checks (2026-10-12, cycles 2026-10-10 to 10-12):** AIGFS, AIGEFS mean and HGEFS mean
share one inventory. Their `sfc` file has only 10 m u/v, 2 m T, PRMSL and the 6-h APCP bucket
(none at F000; AIGFS also lists the running total, and at F006 both are `0-6 hour acc`). Their
`pres` file has HGT, SPFH, TMP, UGRD, VGRD and VVEL on 13 levels (50–1000 mb). So no dew point
(and no 2 m humidity to derive it from), no gust and no type. Ranges: AIGFS and AIGEFS 0–384,
HGEFS 0–240, all 6-hourly, as the roster says. HGEFS's F000 equals GEFS's (the hybrid starts
from the GEFS analysis). GEFS `pgrb2ap5` `geavg`: 3-hourly to F240, then 6-hourly to F384 (F840
on 00Z); RH, not DPT; PRMSL, no MSLET or gust; at every 6-hourly step CRAIN/CSNOW/CICEP/CFRZR
are `a-f hour ave`, i.e. 6-hour averages like GFS's. Every field of all four was then decoded
and built into frames across the full range.

## Architecture

### Display grids (`config/grids.json`)

| id | Extent | Spacing | Size | Used by |
|---|---|---|---|---|
| `na025` | 15–70°N, 170–50°W | 0.25° | 481 × 221 | all globals (covers Hawaii) |
| `conus005` | 22–52°N, 126–66°W | 0.05° | 1201 × 601 | mainland regionals |
| `hi0025` | 18.5–22.5°N, 161–154.5°W | 0.025° | 261 × 161 | Hawaii regionals |

All grids are regular lat/lon, north-to-south rows, as today. The renderer's lookup
(inverse-project each canvas pixel to lat/lon, then bilinear) works unchanged.

### Regridding (`pipeline/src/wxtrend/regrid.py`)

Built in Phase 3 for GEFS's 0.5° (2026-10-12). Weights for GEFS → `na025` take 1.0 s to build
and 1 ms to apply per field, and are 6 MB; they're cached in `.cache/regrid/`
(`$WXTREND_REGRID_CACHE`). The cache matters little at 0.5° but will for ICON's 2.9M cells.

- Input: the source's point lat/lons. For GRIB grids, cfgrib gives 2-D `latitude`/`longitude`.
  For ICON, use the `clat`/`clon` files from the same DWD directory.
- Build once per source grid: a Delaunay triangulation of the source points, then for every
  target point its 3 source indices and barycentric weights, plus its nearest source index.
  Target points outside the hull get nodata.
- Cache the weights as `.npz`, keyed by a hash of the source grid definition. Store them in the
  Actions cache and rebuild on a miss: they're derived, never a source of truth.
- Apply: continuous fields use the weighted sum; categorical bands use the nearest index.
- Regular 0.25° lat/lon sources skip all of this and use the existing `crop_to_domain`.

### Winds

- If `GRIB_uvRelativeToGrid` (or the resolution-and-component flag) says grid-relative, rotate u/v
  to earth-relative using an angle computed once per source grid and cached with the weights.
  This affects HRRR, NAM, RRFS and HiResW (Lambert) and MSC rotated grids.
- For MSC products, prefer the published `WindSpeed`/`WindDir` files over rotating `WindU`/`WindV`.
- `vort500` is computed after regridding, from earth-relative 500 mb u/v on the display grid:
  ζ + f with spherical metric terms (dx = R cos φ Δλ). Edges and nodata neighbours become nodata.

### Accumulations

- **Run totals** (ECMWF `tp`/`sf`, AIFS `tp`/`sf`, ICON `tot_prec`, `snow_*`, `rain_*`, HRRR/NAM/RRFS
  `APCP 0-f`): the 6-h amount is total(f) − total(f−6). Hour f's job fetches the f−6 messages too,
  so jobs never depend on each other. Clip small negative differences (packing noise) to 0.
- **Buckets** (GFS and GEFS-mean 6-h `APCP`, GDPS `Precip-Accum6h`): use as is. Like GFS, GEFS
  carries 3-hour buckets at odd 3-hour steps, so stay on multiples of 6.
- Units differ per model, so the pipeline converts water amounts to mm from each message's GRIB
  `units` and refuses units it doesn't know (`fetch.WATER_TO_MM`). Seen so far: IFS `tp` in m and
  `sf` in "m of water equivalent"; **AIFS `tp` and `sf` in kg m⁻² (= mm)**, not metres (checked
  2026-10-11); NCEP in kg m⁻². ICON is expected in kg m⁻².

### Precipitation type

Codes: 0 none, 1 rain, 2 snow, 3 sleet, 4 freezing rain, 5 unspecified. Ties go to the more
impactful type (existing rule).

| Model | Rule |
|---|---|
| GFS | 6-h averaged CRAIN/CSNOW/CICEP/CFRZR fractions (existing) |
| ECMWF IFS | Snow if Δsf/Δtp ≥ 0.5, else rain. Override with freezing rain (ptype 3, 12) or sleet (ptype 8) if instantaneous `ptype` at f, or at f−3 where that step exists, says so |
| AIFS, ICON | Snow if the snow share of the 6-h amount ≥ 0.5, else rain (no sleet or freezing rain) |
| GEFS mean | GFS's rule, at f only: the member-mean CRAIN/CSNOW/CICEP/CFRZR at each 6-hourly step are already 6-hour averages (`6-12 hour ave`), so they are the share of members and of the window with each type. Changed 2026-10-12 from "largest at f, adding f−3", which assumed instantaneous flags: f−3's 3-hour average would double-weight the window's first half |
| AIGFS, AIGEFS, HGEFS | No type output: 5 "unspecified" wherever the 6-h amount is measurable |
| GEM, RDPS, HRDPS | The largest of Rain/Snow/IcePellets/FreezingRain-Accum6h |
| HRRR, NAM, RRFS, HiResW | Majority of the instantaneous flags at f and f−3, weighted by each 3-h amount |
| Models with no type information | 5 "unspecified": neutral ramp, and the legend says type isn't available (built in Phase 3) |

### Model-specific decisions

- **Heights:** convert geopotential (m² s⁻²: ICON `fi`) to metres by dividing by 9.80665. IFS and
  AIFS both publish `gh` in gpm (checked 2026-10-11), so they use it directly.
  **Verify first:** GDPS height units. MSC has historically used decametres; check the GRIB
  `units` attribute and scale to metres.
- **Sea-level pressure:** use each model's standard reduction (MSLET, MSLMA, msl, pmsl,
  `Pressure_MSL`) and name it on the model card. Don't recompute.
- **Gust:** each model's native gust (instantaneous or period maximum), labelled on the model card.
  Don't harmonize.
- **ECMWF:** only use the 00/12Z runs, which reach 360 h (06/18Z stop at 144 h). IFS posts hourly
  to 90 h, 3-hourly to 144 h, then 6-hourly; frames are 6-hourly throughout. Fetch with retries and
  backoff on 503/429 and at most 4 concurrent requests. The index is eccodes-style (JSON lines with
  byte offsets); the `ecmwf_opendata` adapter reads it directly.
  - **Gust** (`10fg`) is the maximum since the previous output step, so its window follows the
    step: the last hour to F090, then `10fg3` (last 3 h) for F093–F144, then `10fg` again with a
    6-hour window (stepRange `144-150`). It is 0 everywhere at F000, so ECMWF gust starts at F006.
    Shown as is, labelled "period max" (don't harmonize).

- **GEFS mean:** use the 0.5° `pgrb2ap5` files for every field and hour, regridded to `na025`.
  - The 0.25° `pgrb2sp25` files stop at 240 h and have no upper-air fields. Mixing the two
    would make the map visibly change resolution at F246, and ensemble means are smooth anyway.
  - `pgrb2ap5` has no gust or 2 m dew point: gust is unavailable, and dew point is derived from
    2 m T and RH (Magnus formula, unit-tested).
  - Sea-level pressure is PRMSL; MSLET is only in `pgrb2sp25`.
  - Precipitation type: GFS's rule on the 6-hour averaged member-mean flags at f (see
    [Precipitation type](#precipitation-type)).
  - Fetched with Herbie's `gefs` template (`atmos.5`, member `avg`) from AWS, then regridded
    (`"regrid": true` on the product).
- **GDPS, RDPS, HRDPS:** one file per variable per hour and no `.idx`, so jobs download whole files.
  The MSC Datamart path is dated (`/{YYYYMMDD}/WXO-DD/model_gdps/15km/…`); Herbie's `gdps` template
  takes `variable=` and `level=`.
- **ICON:** files are bz2-compressed and kept about 24 h. The job must run every cycle; a missed
  cycle is gone for good. `vmax_10m` is the maximum since the previous output step.
- **RRFS:** only `2dfld` files are on AWS, so RRFS shows surface fields only. **Verify first:** look
  for a pressure-level product on NOMADS (`rrfs/v1.0/`). If found, add the upper-air fields.
- **HiResW:** NOMADS keeps 2 days, so there's no backfill after an outage. **Verify first:** product
  names and fields for the `conus` and `hi` domains.
- **NOMADS** (AIGFS, AIGEFS, HGEFS; later HiResW): see [below](#noaa-ai-and-ensemble-sources).
- **Latency:** measure each product's posting time for 3 days before setting its cron, the way GFS
  was measured (see the comment in `.github/workflows/gfs.yml`). Cron = T0 + last needed hour + 15 min, with a
  retry 45 min later.

#### NOAA AI and ensemble sources

Checked 2026-10-12, decided with Chris.

- **Only on NOMADS.** None of AIGFS, AIGEFS or HGEFS is on AWS Open Data. `noaa-hgefs-pds`
  exists but is empty. `noaa-nws-graphcastgfs-pds` has `aigfs.YYYYMMDD/` folders (from
  2026-04-16) with the same file names as NOMADS, but it isn't operational AIGFS: its `sfc` file
  has 12 messages to NOMADS's 6 (it adds DPT, 100 m wind, surface T and P), its 2 m T at F006
  differed by up to 4.7 K (mean 0.25 K) for the same cycle, and it posts about 3 hours later.
  The registry describes the bucket only as experimental GraphCastGFS, so treat it as a
  development run.
- **Retention:** AIGFS about 11 days; **AIGEFS and HGEFS 2 days** (8 cycles), not the 10 the
  plan assumed. The retention window needs 9 runs, so their first backfill is one run short, and
  an outage longer than ~2 days loses runs for good (as with ICON). Hours the source no longer
  has (HTTP 404) aren't retried (`fetch.NotPublished`; only where the adapter sees the 404 itself,
  since Herbie reads AWS throttling as "not found"). An older run the source no longer has is
  skipped after one check (`update.skip_unpublished_runs`), and gone hours don't fail the job, so a
  retry pass with nothing else to do stays green while those runs age out of the window.
- **"Empty bodies" explained:** over HTTP/2, NOMADS sends `content-length` with trailing spaces
  (`2977        `), which curl's HTTP/2 parser rejects, so curl printed nothing. Over HTTP/1.1
  curl works, and so does Python `requests` (HTTP/1.1 only), which the pipeline uses. From the
  dev machine every request worked, and so did a GitHub runner (a one-off probe workflow,
  2026-10-12 14:07Z, runner IP 52.161.45.224): curl over HTTP/2 got 0 bytes as here, while
  HTTP/1.1, every `.idx` and every multi-range GET (`206 multipart/byteranges`) worked for all
  three products. The probe workflow was then deleted.
- **Usage limit:** NCEP's published policy is **120 requests a minute per IP**, summed across
  NOMADS and NCEP's FTP sites, with over-limit IPs blocked ([SCN 21-32](https://www.weather.gov/media/notification/pdf2/scn21-32nomad_changes.pdf),
  2021; nothing newer found). The products are paced to **60 a minute** each, half the limit,
  which leaves room for other tenants of a shared runner IP.
- **Own adapter, not Herbie** (decided with Chris): Herbie makes about 7 requests per file (a
  HEAD on the GRIB, an index check, the index, then a GET per contiguous group of messages) and
  doesn't back off, about 14 per AIGFS hour, and the completeness check would add a HEAD per
  hour and file (130 per AIGFS cycle). NOMADS answers multi-range requests with one
  `multipart/byteranges` response, so the `nomads` adapter reads each file in two requests: its
  `.idx`, then every needed message in one GET. An hour is 4 requests; completeness is one
  directory listing per cycle. A full AIGFS backfill (585 hours) is about 2,350 requests instead
  of about 8,200.
- **Posting times** (NOMADS listings): AIGFS complete at T0+4:12–4:32 (36 cycles, 2026-10-03 to
  10-11); AIGEFS mean T0+4:32–4:48 and HGEFS mean T0+6:40–6:46 (9 cycles each, 2026-10-10 00Z to
  10-12 00Z: NOMADS keeps only 2 days, so these were read on 10-12 at 03:45Z and 06:50Z). GEFS mean on AWS: T0+6:29–6:39, 18Z up to 7:33 (16 cycles,
  2026-10-08 to 10-11).

#### ECMWF open-data source

Checked 2026-10-11, decided with Chris: fetch IFS and AIFS from the **Google Cloud mirror**
(`https://storage.googleapis.com/ecmwf-open-data/`), not AWS.

- AWS `ecmwf-forecasts` throttled hard: with one sequential connection, 22 of 40 index requests
  returned `503 SlowDown`, and one forecast hour still failed after about 7 minutes of backoff. A
  full IFS window (5 runs × 61 hours × ~15 requests) wouldn't fit in a 60-minute job.
- GCS served 40 of 40 sequential requests and about 65 parallel ones with no throttling.
- The files are byte-identical: MD5s and sizes matched AWS for IFS F006/F150 and AIFS F360,
  GRIB2 and index. GCS is one of ECMWF's own distribution points (`ecmwf-opendata` has
  `source="google"`); the licence is the same CC BY 4.0.
- Posting is within 2 minutes of AWS: IFS 00/12Z complete at T0+7:36, AIFS at T0+5:23–5:39
  (2026-10-08 to 10-11).
- Downsides: the GCS archive starts around 2025-01-01 (AWS has 2023 on), which matters only for
  backtests; and it's one more mirror that could go away. Switching back is a one-line `index_url`
  change in `config/models/ecmwf.json` and `aifs.json`.

### Frame format v3 and storage layout

- Frame bytes are unchanged (bands concatenated, row-delta, gzip). New: a band may declare
  `"nodata": <max stored value>`, and encoding clips valid values to `max − 1`. The renderer draws
  transparent where any bilinear corner is nodata (built in Phase 1, for `vort500`'s edges).
  Contours are drawn, then clipped to the valid-data mask (Phase 5; no contoured field has
  nodata yet).
- Manifest schema 3 adds `product`, `model`, `grid` (an id from `grids.json` plus its definition),
  per-band `nodata`, and `fields` limited to what the model provides.
- R2 keys: `<product>/manifest.json`, `<product>/runs/<YYYYMMDDHH>/<field>/f<FFF>.bin.gz`, and
  `points/<product>/<run>.json` (league).
- Cache headers: frames `public, max-age=31536000, immutable` (a written frame never changes);
  manifests `max-age=60`. Because browsers and the CDN keep frames forever, **an encoding change
  must use a new field id** (e.g. `t850v2`). Never overwrite frames in place.
- Bucket CORS (`infra/r2-cors.json`, applied with `make r2-cors`): allow GET from
  `https://runtorunwx.com`, `https://www.runtorunwx.com`, and `http://localhost:5173` / `:4173`
  (dev and preview; R2 origins can't wildcard a port). `christopherward13.github.io` was allowed
  until the custom domain went live; it now redirects to `runtorunwx.com`.
- Public access goes through the custom domain. The `r2.dev` URL is rate-limited and for
  development only.

### Pipeline changes (Python, `pipeline/`)

- `config.py` loads the split config. A `Product` replaces the old single `Config` model block, and
  every function that takes `cfg` takes a product (Phase 0). Each model names its source
  `adapter` and an `index_url` template; an index existing means the hour is posted, which is how
  cycle completeness is checked.
- `fetch.py` holds source adapters behind one interface,
  `fetch_hour(product, init, fhr, field_ids, work_dir) -> {field: {band: values}}`:
  - `herbie` (built): GFS and GEFS mean (Herbie's `member`, `avg`). Planned for HRRR, NAM and
    RRFS (AWS). Herbie reads one step per hour, so recipes on this adapter can't use offsets (it
    raises if one does).
  - `nomads` (built, Phase 3): AIGFS, AIGEFS and HGEFS means, later HiResW. Each field names its
    file (`sfc` or `pres`: the NOAA AI products split an hour across two) and a search regex
    against the wgrib2 `.idx`. Two requests per file, paced to the model's
    `requests_per_minute` ([why](#noaa-ai-and-ensemble-sources)). Herbie's `aigfs`, `aigefs` and
    `hgefs` templates exist but cost about 3.5 times the requests.
  - `ecmwf_opendata` (built): IFS and AIFS. Reads the eccodes `.index` itself, so it controls
    retries and byte ranges: it merges ranges less than 1 MB apart and backs off on throttling
    (`net.py`). It reads other steps of the run when a recipe asks (f−6 totals, f−3 type).
  - `msc_files`: GDPS, RDPS, HRDPS.
  - `dwd_icon`: bz2 plus icosahedral grid.
  - `arpege_package`: optional.
- `catalog.py` has per-model recipes (`RECIPES[model][field]`): the GRIB inputs (`Need`s, which can
  read another step or apply only at some hours) and a compute function of the inputs and the
  display grid. Shared helpers in `fields.py`: accumulation differences, precip type (GFS
  fractions, snow share, ECMWF overrides) and vorticity; rotation comes in Phase 5. Water amounts
  are converted to mm as they're read.
- `store.py` gains an R2 sync:
  1. Read the product's remote manifest.
  2. Compute the missing jobs.
  3. Write frames locally, then upload them.
  4. Upload the new manifest.
  5. Delete pruned runs.

  Use boto3 against R2's S3 endpoint. Credentials go in Actions secrets: `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
- Retention stays derived: `1 + max_lag / cycle_interval` runs per product.
- A manifest whose model, fields, bands or hours differ from the config is rewritten, and
  `wxtrend verify` reports the difference (`manifest.config_drift`).
- `fetch_hours` is `min(display_max + max_lag, model_max)` (see [Forecast range](#forecast-range)).

### Workflows

- `.github/workflows/product.yml` is reusable (`workflow_call`, inputs `product`, `regrid`,
  `timeout_minutes`):
  1. Restore the regrid-weights cache (`regrid: true`; built in Phase 3 for GEFS. The 0.25°
     products need none).
  2. Run `wxtrend update --product X --remote`.
  3. Validate the manifest (`verify --remote`).
  4. Sync to R2.
- One small caller workflow per product sets the cron and `concurrency: product-X`: `gfs.yml`,
  `ecmwf.yml`, `aifs.yml`, and from Phase 3 `aigfs.yml`, `gefs.yml`, `aigefs.yml`,
  `hgefs.yml`. Their comments record the measured posting times behind each cron. The NOMADS
  products have a longer timeout: their paced first backfill takes up to ~40 minutes.
- `ci.yml` and the Pages deploy run on code changes only. Playwright e2e runs against a
  fixture-sized local dataset built in CI (`make e2e-data`): a pinned cycle and its lag runs,
  F000–F060, for every product (one regional product joins in Phase 5). Products whose source
  keeps an archive (GFS, ECMWF, AIFS, GEFS) are rebuilt from it. NOMADS-only products
  (AIGFS, AIGEFS, HGEFS) can't be, since a pinned cycle expires in days, so they come from a
  frozen bundle (a cycle and its 12-h lag run) on a GitHub release, pinned by SHA-256 in the
  `Makefile` and checked against `config/` by `wxtrend verify` (decided with Chris 2026-10-12:
  hermetic and reproducible, no binaries in git, and a loud failure when the config moves on).
- The repo stays public: free Actions minutes, and the cron schedules depend on it.

## Site organization

```
Top bar:     Run to Run Wx  Maps · Models · Scoreboard · About     [region ▾]  updated 12:41Z
Model bar:   Global: GFS ECMWF GEM ICON ARPEGE | AI: AIFS AIGFS | Ens: GEFS AIGEFS HGEFS  (North America view;
             Regional: HRRR NAM RRFS … join once a US region is in focus)
┌ Fields ──────┐ ┌───────────────────── map ─────────────────────┐ ┌ Options ───────────┐
│ Surface      │ │                                               │ │ Forecast/Trend/    │
│  Temperature │ │                                               │ │   Compare          │
│  Dew point   │ │                                               │ │ Run ▾   Lag ▾      │
│  Wind · Gust │ │                                               │ │ Overlays           │
│  Precip      │ │                                               │ │ Color scale        │
│  Pressure    │ │                                               │ │ Stats              │
│ Upper air    │ │                                               │ │                    │
│  850 mb temp │ └───────────────────────────────────────────────┘ └────────────────────┘
│  500 mb      │  ◀ ▶  ───●──────────────────────────  Sat 18Z (F030)   ▶ play
│  250 mb jet  │
└──────────────┘
```

- **Maps** is the visualizer.
- **Models** has one "player card" per model: who runs it, resolution, run times, horizon, fields,
  data latency, licence, and the **transaction wire** (upgrades, retirements, outages).
- **Scoreboard** shows daily model accuracy at the venues, from the point forecasts. It's content
  before the league exists and becomes the league section later.
- **Model chips: only usable ones are shown.**
  - A chip appears only if its model outputs the selected field and has data for the current
    region. Each chip shows its latest run ("12Z").
  - Group and model order are fixed, so changing field makes chips appear and disappear but never
    reshuffle. A group with no visible models collapses.
  - At the end of the bar, a one-line note (not chips) says what's missing, e.g.
    "Not shown: AIFS, AIGFS (no gust output)", so nobody wonders where a favourite model went.
  - The fields sidebar always lists every field. You pick what to see, and the model bar narrows
    to whose forecast.
- **When the current model drops out** (you pick a field it lacks, focus a region it doesn't
  cover, or open a link that asks for an impossible combination):
  - Keep the field and region, and switch to the first visible model in the same group,
    otherwise GFS.
  - Say so in the banner: "AIFS doesn't output gusts, so this shows ECMWF."
  - The compare-mode picker uses the same filter.
- **Switching model keeps field and valid time.** If the new model's run doesn't reach that time,
  clamp to its last frame and say so in the banner (existing notice system).
- **Region focus:**
  - Global models open on North America.
  - Hovering the map outlines a region; clicking it zooms there. A breadcrumb
    ("North America › Northeast") and `Esc` go back. The region selector lists the same regions.
  - Focusing changes only the map extent: the projection refits to the region box. Global frames
    are reused, so there's no new download and it's instant.
  - Inside Mainland US and its sub-regions, regional products join the model bar (they use
    `conus005` frames). Hawaii shows the Hawaii products.
  - No state-level zoom.
  - Overlay density (barbs, arrows, labels) is set in screen pixels, so it adapts. Check that H/L
    minimum separation still looks right at region zoom.
  - Hit areas are state polygons merged by region. Add Natural Earth
    `ne_50m_admin_1_states_provinces` polygons and a state→region table to
    `web/scripts/build-basemap.mjs`. The zoom extent is the region's box below.

  | Region | Zoom box (lat, lon) | States (hit area) |
  |---|---|---|
  | North America (default) | the `na025` grid | — |
  | Mainland US | 23–51°N, 126–66°W | all 48 |
  | Northwest | 40–50°N, 126–109°W | WA, OR, ID |
  | Southwest | 30–42.5°N, 125–102°W | CA, NV, AZ, UT, NM, CO |
  | Northern Plains | 40–50°N, 117–94°W | MT, WY, ND, SD, NE |
  | Southern Plains | 25–40°N, 107–88°W | KS, OK, TX, AR, LA |
  | Midwest | 36–50°N, 98–79°W | MN, IA, MO, WI, IL, IN, MI, OH |
  | Southeast | 24–37.5°N, 92–75°W | MS, AL, GA, FL, SC, NC, TN, KY |
  | Northeast | 37–48°N, 83–66°W | PA, NY, NJ, MD, DE, DC, VA, WV, New England |
  | Hawaii | the `hi0025` grid | HI |

  Boxes overlap on purpose, so a region shows some context around it. Each state belongs to
  exactly one hit area.
- **Compare mode:** two products side by side, synchronized by valid time. Show a difference map
  (A − B) only when both are on the same grid.
- **URL state** gains `m` (model), `r` (region) and `t` (valid time, replacing `f`). Old links
  (`?v=jet&f=…`) still open on GFS. As built: `t` is `YYYYMMDDHH`; compare mode adds `c` (the
  other model) and `cv` (`side` or `diff`); a link's `f` counts from its run, and the URL is
  rewritten with `t`.
- **Mobile:** the model bar scrolls horizontally, Fields and Options become bottom sheets, and the
  scrubber stays pinned to the bottom.
- **Performance:** a regional frame is about 260 KB per field. Prefetch ±1 frame, keep an LRU cache
  capped by bytes, and decode in a Web Worker if scrubbing stutters on mid-range phones.

## Storage and cost budget

Estimated from today's measured sizes (about 39 KB per field-frame on `na025`). A
`conus005` frame has 6.8× the points.

| Group | Estimate |
|---|---|
| Globals and AI at full range (GFS 384 h, ECMWF 360 h, AIFS 360 h, AIGFS 384 h, GEM, ICON, ARPEGE) | ~1.1 GB |
| Ensemble means (GEFS 384 h, AIGEFS 384 h, HGEFS 240 h) | ~0.6 GB |
| Regionals, 3-hourly (HRRR, NAM, RRFS, HiResW, RDPS, HRDPS) | ~1.6 GB |
| Hawaii products | < 0.1 GB |
| **Total** | **~3.3 GB** (about 5.3 GB with hourly regionals) |

- **R2:** 10 GB storage free, then 1.5¢/GB-month; egress free; 1M Class A operations a month free
  (deletes are free).
- **Writes:** about 25k frames a day, roughly 750k a month, which is under the 1M free writes a
  month. Backfills add a one-off burst. If writes approach the limit, bundle each hour's fields
  into one object per product.
- **Measured after Phase 1** (2026-10-11, sizes from real frames): a GFS hour is 466 KB (12
  fields), ECMWF 466 KB (12), AIFS 299 KB (11). Stored windows: GFS 9 runs × 65 hours ≈ 273 MB,
  ECMWF 5 × 61 ≈ 142 MB, AIFS 9 × 61 ≈ 164 MB, **about 0.58 GB** together. Class A operations
  (frame PUTs, the manifest, listings; deletes are free): about 7,300 a day, **about 220k a
  month**. The one-off first fill is about 3,050 new GFS frames (new hours and fields for runs
  already in R2), 3,650 ECMWF and 6,030 AIFS.
- **Measured after Phase 3** (2026-10-12, full local backfills of the real windows):

  | Product | Fields | Hours × runs | Per hour | Window | Frames per run | Full backfill |
  |---|---|---|---|---|---|---|
  | AIGFS | 10 | 65 × 9 | 377 KB | 221 MB | 649 | 39 min (NOMADS, paced) |
  | GEFS mean | 11 | 65 × 9 | 243 KB | 142 MB | 714 | 8.5 min (AWS, 6 workers) |
  | AIGEFS mean | 10 | 65 × 9 | 236 KB | 138 MB | 649 | 39 min (NOMADS, paced) |
  | HGEFS mean | 10 | 41 × 9 | 230 KB | 85 MB | 409 | 25 min (NOMADS, paced) |

  The ensemble means are smooth, so they compress like AIFS; AIGFS is noisier than GFS at small
  scales (its 500 mb heights are 56 KB a frame to GFS's 34). The four add **about 0.59 GB**,
  for **about 1.15 GB** in all with GFS, ECMWF and AIFS. The three ensemble means measure 0.37 GB
  against the 0.6 GB estimated above. Class A operations: the four add about 9,700 frame PUTs a day (649 × 4 + 714 × 4
  + 649 × 4 + 409 × 4), so all seven products come to **about 17,000 a day, about 510k a month**,
  half the free million. The one-off first fill is about 21,800 PUTs (5,841 AIGFS, 6,426 GEFS,
  5,841 AIGEFS and 3,681 HGEFS, if NOMADS still has all 9 runs). The NOMADS backfills are bound
  by the 60-a-minute pace, not by decoding; a routine update (one new run) is about 260
  requests, under 5 minutes.
- **Compute:** free on public-repo Actions (a few runner-hours a day).
- **Guardrail:** `wxtrend verify` reports bytes per product and fails CI above a configurable
  budget (start at 8 GB).

## Phases

Each phase ends deployable. Sizes: S ≈ days, M ≈ a week or two, L ≈ several weeks.

### Phase 0: Foundations (M)

1. Split the config; introduce `Product`; GFS becomes the `gfs` product. All tests still pass.
2. Frame format v3 (nodata) and manifest schema 3. Regenerate `shared/test-vectors/frames.json`;
   pytest and vitest both pass.
3. Create the R2 bucket, CORS and secrets. Add the store sync and the reusable `product.yml`.
   Run GFS through it.
4. Frontend reads `VITE_DATA_BASE`: `https://data.runtorunwx.com/` in production (the `r2.dev`
   URL until task 5 is done), local `../data` in dev. Remove the data copy and deploy steps from
   the GFS workflow.
5. Domains, after the [setup steps](#setup-only-chris-can-do): `data.runtorunwx.com` serves R2,
   and `runtorunwx.com` serves the site through GitHub Pages. No `CNAME` file: GitHub ignores it
   for sites deployed by an Actions workflow, and the Pages setting keeps the custom domain.
   Switch `VITE_DATA_BASE` to the custom domain and update CORS.

**Done when** GFS updates through R2, the site loads data from `data.runtorunwx.com` at
`https://runtorunwx.com`, and no deploy happens on data updates.

### Phase 1: ECMWF IFS and AIFS, new fields (M)

1. ✓ Add `hgt500`, `vort500` and `t850` for GFS: recipes, the vorticity helper, and its unit tests
   (solid-body rotation, a meridional-wind case and a hand-computed 3×3 grid). The site gained
   500 mb (vorticity shading, heights; the trend compares heights) and 850 mb tabs.
2. ✓ Extend GFS to its full range (0–384 h), with `fetch_hours` per [Forecast range](#forecast-range).
   GFS posts hourly to F120 and 3-hourly after, so the frames stay 6-hourly and use the 6-hour
   `APCP` buckets.
3. ✓ ECMWF IFS adapter (eccodes index, 00/12Z, 0–360 h, Δtp, the precip-type rule, throttling
   backoff). It fetches from the Google Cloud mirror ([why](#ecmwf-open-data-source)).
4. ✓ AIFS (0–360 h, Δtp, rain/snow type, no gust).
5. ✓ Measure latency; set crons. Measured from object timestamps, 2026-10-07 to 10-11: GFS
   F000–F384 complete at T0+5:12–5:31; ECMWF 00/12Z at T0+7:34 (AWS) / 7:36 (GCS), all hours at
   once; AIFS at T0+5:23–5:39. Crons: GFS T0+5:47, ECMWF T0+7:52, AIFS T0+5:55, each with a
   retry 45 minutes later.

**Done when** all three models show all their fields across their full ranges in forecast and
trend mode, and the e2e covers each. Met locally on 2026-10-11 against a full backfill of all
three; R2 fills on the first workflow runs after the push.

The site needed a way to pick a model before Phase 2's model bar exists, so Phase 1 added a
stopgap (replaced by the model bar in Phase 2):
- A **Model** control (GFS, ECMWF, AIFS, in `config/site.json`'s `products` order) and the URL
  parameter `m`.
- Switching keeps the tab and valid time, clamping with a banner when the new run doesn't reach
  it.
- The time slider follows each product's manifest (`display_hours`). A model's tabs and variables
  are limited to the fields its manifest lists.

### Phase 2: Site organization (M, can run in parallel with Phase 1 after Phase 0)

1. ✓ Rebrand to **Run to Run Wx**: page title, header, meta description, favicon if desired, and a
   footer that credits each data source (NOAA; ECMWF CC BY 4.0; DWD; ECCC; Météo-France
   Licence Ouverte) as models are added. The favicon is unchanged.
2. ✓ Model bar, field sidebar, valid-time scrubber, URL state v2 with old links still working. The
   scrubber spans the selected model's own range (up to 16 days). The bar replaces Phase 1's
   Model control. `m` already exists; links without it open GFS.
3. ✓ Model-bar filtering from the manifests' field lists: only usable chips, the "Not shown" note,
   and the drop-out fallback with its banner. Phase 1 handles a missing field the other way
   round: it keeps the model and changes the variable ("AIFS doesn't output gusts, so this shows
   sustained wind"). Replace that with the model fallback here.
4. ✓ Region focus: the selector, click-to-focus hit areas (basemap build gains the merged state
   polygons), breadcrumb and `Esc`, and refitting the projection without refetching frames.
   Regional chips appear once Phase 5 products exist.
5. ✓ Compare mode (side by side; difference on the same grid). Both panels share the region.
6. ✓ Mobile bottom sheets. Tapping a region focuses it.

Decided while building (2026-10-11):
- **Config.** The model bar's groups and order are `model_bar` in `config/site.json` (it replaces
  `products`; the first product is the default and the last-resort fallback). Regions live in
  `config/regions.json`: zoom box, `parent`, and `states` for the click target.
- **Fields sidebar** items are views plus their variables, so Temperature and Dew point, and Wind
  and Gusts, are separate items (8 in all; number keys follow them). A model must output what the
  item shades in every mode (500 mb: vorticity and heights). The sketch's "Pressure" item isn't
  built: sea-level pressure is an overlay on Wind and Precipitation, and a pressure view would be
  new work, not organization.
- **Fallback:** the first visible model in the same group, otherwise GFS. AIFS is alone in the AI
  group, so "AIFS doesn't output gusts, so this shows GFS."
- **Manifests** for every product load at startup, so the bar can filter and show each latest run.
  A product whose manifest fails is hidden, with "data couldn't be loaded" in the note.
- **Region tree:** North America › Mainland US › the 8 regions, and North America › Hawaii. From
  North America a click goes straight to a region (one click to the Northeast); the breadcrumb shows
  the full path and `Esc` goes up one level. Hawaii's click target is its whole box: at continental
  zoom the simplified islands are a few pixels wide (`"hit": "box"`).
- **Focusing** refits the projection and rebuilds the pixel lookup on the same canvas size; frames
  are redrawn, not re-requested or re-decoded (the e2e checks there are no requests and no new
  render). Stats (max, min, largest change) cover the focused box. H/L centers keep their 4°
  separation in grid space, which reads fine at region zoom.
- **Compare:** a "Compare" mode beside Forecast and Trend, a "Compare with" picker (same filter as
  the bar), and Side by side / Difference. The other model shows its newest run that reaches the
  valid time. The difference reuses each view's trend scene with the other model as the "older"
  side, so the scale, overlays ("ECMWF's 32 °F line") and readouts work unchanged; captions and
  readouts name the models. Compare carries across fields. Stat labels still use trend wording
  ("Most warming" means "GFS warmest relative to ECMWF").
- **Phones** (≤ 760 px): Fields and Options are bottom sheets opened from a pinned bar under the
  scrubber; side-by-side maps stack. Between 761 and 1180 px the sidebar becomes a row of pills
  above the map and the options go below it.

**Done when** e2e covers:
- model switching with time preserved;
- a field change that hides the current model and falls back, with the banner;
- clicking a region and returning with `Esc`, with no new frame requests for globals;
- compare mode;
- an old-link redirect;
- a 375 px layout screenshot.

### Phase 3: NOAA AI and ensemble means (M)

1. ✓ Verify first: the AIGFS (`sfc` + `pres`), AIGEFS and HGEFS inventories and forecast ranges
   (2026-10-12). Availability rows filled; the roster's display hours stand.
2. ✓ Confirm NOMADS works from GitHub runners (2026-10-12, a one-off probe workflow; the
   "empty bodies" were curl rejecting an HTTP/2 header). Retention is ~11 days for AIGFS but
   only about 2 for AIGEFS and HGEFS, so a first run backfills only what's there.
3. ✓ AIGFS, 0–384 h, through the new `nomads` adapter rather than Herbie's `aigfs` template
   ([why](#noaa-ai-and-ensemble-sources)).
4. ✓ GEFS mean from `pgrb2ap5` (0.5° → `na025`, 0–384 h, dew point from RH, PRMSL, no gust),
   with `regrid.py` (moved up from Phase 4).
5. ✓ AIGEFS mean (0–384 h) and HGEFS mean (0–240 h) from the `ensstat` `avg` files, through the
   `nomads` adapter.

**Done when** four new chips are live (AIGFS and three ensemble means) across their full
ranges, and fields they lack aren't offered.

Decided while building (2026-10-12, with Chris where noted):
- **Verify first** found the plan wrong in three places, settled with Chris: GEFS's type flags
  are 6-hour averages, so GEFS uses GFS's rule at f (no f−3); AIGEFS and HGEFS keep 2 days on
  NOMADS, not 10; and Herbie costs too many requests against NOMADS's per-IP limit, so the NOAA
  AI products use a new `nomads` adapter ([details](#noaa-ai-and-ensemble-sources)).
- **Names:** the models are "AIGFS", "GEFS mean", "AIGEFS mean" and "HGEFS mean" (banners and
  titles say "mean"); the bar's groups are AI (AIFS, AIGFS) and Ensemble mean (GEFS, AIGEFS,
  HGEFS).
- **Untyped precipitation:** the NOAA AI products write category 5 wherever the 6-h amount is
  measurable, and their model files say `"precip_type": false`. The legend becomes one neutral
  row with "Precipitation type isn't available", the readout says "not available", and the "Max
  frozen" stat ignores 5. Side by side with a typed model, the legend shows the types plus a grey
  row named for the untyped model (from the post-push review, 2026-10-12).
- **e2e for NOMADS products:** a frozen fixture bundle on a GitHub release (Chris chose it over
  committing the bundle, building from the live cycle, or synthetic frames). See
  [Workflows](#workflows).
- **Manifests follow the config:** an update rewrites a manifest whose fields or bands differ
  from the config, so GFS, ECMWF and AIFS manifests gain the "unspecified" label on their next
  run (no frame changes).

### Phase 3.5: Creator pass (M1–M3, then decide)

Added 2026-10-12 from the [creator review](reviews/2026-10-12-creator-review.md): a meteorologist
building a week-ahead model-breakdown video for a broad YouTube audience on the live site.
Item ids (Q1–Q18, A1–A8) are the review's. Chris's call (decision 7): M1–M3 before Phase 4, then
decide between M4–M5 and Phase 4. Each milestone ends deployable.

#### M1: Trust

The site mustn't say wrong or misleading things.

1. **Scheduler (Q1).** GitHub drops and delays scheduled runs. On 2026-10-12, between 02:47Z
   and 16:57Z, 4 of 12 scheduled starts ran, each 1–3.5 h late; ECMWF's first scheduled start
   came 9 h late, so the site showed a 28-hour-old ECMWF next to the day's GFS. A Cloudflare
   Worker (`scheduler/`) becomes the trigger, and the GitHub crons stay as a backup.
   - **Every 10 minutes** (one Cron Trigger; the free plan allows 5 per account), the Worker
     reads each product's manifest from `data.runtorunwx.com` and works out the newest cycle
     that should be posted: cycles every `cycle_interval_hours`, posted `latency_minutes` after
     init. `latency_minutes` is a new key in `config/models/<id>.json`, the latest posting time
     measured so far (now in the workflow comments; see
     [NOAA AI and ensemble sources](#noaa-ai-and-ensemble-sources) and Phase 1, task 5).
   - **Behind** means the manifest's `latest` is older than that cycle. If a product is behind and
     its workflow has no run queued, running, or started in the last 30 minutes, the Worker
     dispatches `<product>.yml`. A dispatch with nothing new to do is a quick no-op, as now.
   - **Alerts:** a product still behind 3 h after its cycle was due gets an issue labelled
     `stale-data` (GitHub emails Chris). The Worker closes it with a comment once the product
     catches up. One open issue per product.
   - **Auth (decision 8):** a GitHub App with Actions and Issues read/write on this repo only. On
     each tick the Worker signs a JWT with the App's key, looks up the installation, and gets a
     1-hour installation token. The key is stored as downloaded (PKCS#1 PEM); the Worker wraps it
     as PKCS#8 for WebCrypto.
   - **Deploys** from `.github/workflows/scheduler.yml` on changes under `scheduler/`, with
     `cloudflare/wrangler-action`, which also uploads the App id and key from Actions secrets as
     Worker secrets.
   - **Watchdog:** a daily scheduled `freshness.yml` fails when any product is more than 12 h past
     due, so a dead Worker still gets noticed: GitHub emails on a failed scheduled run. A late
     GitHub start doesn't matter for a daily check.
   - Unit tests (vitest) for the due-cycle arithmetic, the dispatch, back-off and alert decisions,
     and the key wrapping.
2. **Staleness on the chips (Q1a).** A chip shows its run's day when that isn't today (UTC until
   M2 adds time zones): "Sun 12Z". It turns amber when the next cycle is overdue: the same
   `latency_minutes`, plus 90 minutes for the job to run. Its tooltip says which run is late.
3. **Fair comparisons (Q8).** Compare mode gets a run picker for the other model: "Latest that
   reaches this time" (today's behaviour, the default), "Same cycle" (the other model's run with
   the same init, when it has one), or any retained run. URL `crun`: `latest`, `same` or a run
   id. When the two runs started more than 12 h apart, the banner says so ("ECMWF's run is 18 h
   older than GFS's"). The compare-with picker becomes a dropdown, which also fixes the clipped
   "HGEFS mean" (Q18).
4. **Precipitation-type palette (Q9).** About 6 bins per type instead of 10 (viewers can't read
   40 colors; the hover readout still gives the amount). Sleet moves to low-saturation tans and
   browns, snow stays in blues, freezing rain in pinks and magentas, and each type's lightest bin
   stands clear of the map background. `palettes.test.ts` checks every pair of colors from
   different types: at least ΔE 15 (CIELAB ΔE76) with normal vision, and as high as four ramps
   allow under simulated deuteranopia (Machado 2009; target 10, pinned at the value reached).
5. **Ensemble-mean 500 mb (Q11).** 500 mb gains a second shading, heights (a sequential palette
   on 500 mb height), chosen in Options beside vorticity. The three ensemble means open on it:
   their vorticity is nearly flat and means little. Anomalies (A1) replace it later.
6. **Open on a map viewers understand (Q17).** A bare `runtorunwx.com` opens the visitor's last
   view (model, field, region and mode; kept in `localStorage`), or on a first visit the 500 mb
   forecast over Mainland US. Links with parameters open as before; old links without `v` still
   open the jet trend.
7. **Links follow the latest run (from Q12).** URLs stop pinning `run` unless a past run is
   picked, so a bookmark opens the newest run at its valid time. `run=latest` is accepted, and a
   hand-made link's `f` counts from the newest run.
8. **Bugs and copy (Q18).** "Max frozen" honours the focused region, like the other stats. The
   difference legend names only what's differenced ("500 mb heights", not "heights and
   vorticity"). Untyped precipitation's note shows once, not in both the legend and the caption.
   Sub-labels and "Click a region to zoom" reach 4.5:1 contrast. At about 800 px the footer clears
   the pinned timeline and the day ticks don't wrap.

**Done when** the Worker has dispatched each product on its own and opened and closed a test
issue; the chips show day and lateness (e2e with a fixed clock); compare offers the run picker
and the age banner (e2e); the palette test passes; and the default view, links and bug fixes are
covered by tests.

Decided while building (2026-10-12):
- **Scheduler.** Cloudflare needs a `workers.dev` subdomain on the account before a Worker can
  have a cron (opening **Workers & Pages** once creates it), though this Worker has no public URL.
  The deploy runs `wrangler deploy` and then `wrangler secret bulk` (values over stdin), with no
  third-party action. Its first tick (19:10Z) dispatched GFS, AIFS, AIGFS, AIGEFS and HGEFS,
  each behind because its cron hadn't fired. A tick uses about 15 ms of CPU against the free
  plan's 10 ms: allowed so far. If the log shows "Exceeded CPU", keep the installation token in
  KV so the App key is signed once an hour, not every tick. The issue path is tested with a fake
  GitHub, not yet live (no product has been 3 h late since).
- **Chips** recheck every minute, so a page left open turns amber. "Today" is UTC until M2.
- **Compare run picker** is a second dropdown ("Its run"): newest that reaches the time, same
  cycle, or any retained run. A picked run resets to newest when the compared model changes;
  "same cycle" carries over. The age banner gives way to any other banner.
- **Palette:** bins 0.01, 0.1, 0.25, 0.5, 1, 2 in for every type (and the untyped grey ramp).
  Sleet became a grey taupe: tans collided with rain's greens under deuteranopia. Measured:
  closest pair of types ΔE 21.1 (was 5.2), 12.2 with deuteranopia (was 4.0), lightest bin 20.2 off
  the dry color. The test pins 15, 12 and 20, and 10 between a type's neighbouring bins.
- **500 mb shading** is a "Shading" control in Options (Vorticity · Heights), stored as the view's
  `var`. Until the viewer picks one, ensemble means open on heights and other models on
  vorticity; once picked (or named in a link) it sticks across models and fields.
- **First visit:** the last view is kept without its run and time (`rtr:last-view`), so a bare
  visit opens on the newest data.
- **About 800 px:** neither problem reproduced with the current runs. The fixes are general: tick
  labels never wrap, and on phones the page reserves the pinned timeline's and dock's measured
  height instead of a fixed 140 px.
- **Contrast:** `--muted` is `#5f6f86` (4.7:1 on the page background) everywhere.

#### M2: Time

1. **Local time (Q4).** "Wed 8 PM ET · Thu 00Z" wherever a valid time is shown, with a remembered
   zone picker (ET, CT, MT, PT, AKT, HT, UTC; first visit takes the browser's zone if it's one of
   these, otherwise UTC). Day ticks follow the zone. A lead-day label ("Day 3"); whether Day 1 is
   the calendar day in the chosen zone or the first 24 h after init is decided while building.
2. **One time axis (Q13).** The scrubber spans valid time from the earliest init among the
   latest runs to the longest range, the same for every model, with each model's coverage
   shaded. Switching model never moves the thumb. Optional zoom to Days 1–7.
3. **Loop controls (Q5).** Speed (about 1–8 frames a second), start and end handles with a "Next 7
   days" preset, a 1–2 s hold on the last frame, a "Preload loop" button with progress (every
   field the view draws, over the loop's range), and Shift+←/→ to step ±24 h.
4. **Units (Q14).** mph or kt, °F or °C, remembered. Height differences in dam, like the contours.

**Done when** switching model at a valid time leaves the scrubber still, a 7-day loop runs at a
chosen speed after preloading with no spinner, and times read in the chosen zone (e2e).

#### M3: Presentation mode

Chris's idea, to be designed before it's built: choosing presentation mode first offers layout
silhouettes, like an OS's window-snapping layouts, in 16:9 or 9:16. The window then goes full
screen, and each slot is filled by choosing its model, field, mode and region.

**Settled:**
- **Silhouettes:** 16:9 single, two side by side, 2×2; 9:16 single and two stacked. Three stacked
  (1,794 of 1,920 px) leaves no room for titles.
- **Geometry** (measured with the site's projection, centered on each region per Q15):
  Mainland US is 1.81:1 against 16:9's 1.78; the regions run from 1.08 (Midwest) to 1.67
  (Northern Plains). Two US maps stacked take 1,196 of 1,920 px, leaving about 720 for the title,
  color bar and the platform's own buttons. Four fill a 2×2 at 1080p (960×530 each).
- **Fill the frame.** A region sets each slot's center and the smallest box it must show, and the
  extent grows to the slot's shape instead of leaving bars; global frames cover far more than any
  region.
- **Drawn onto the canvas:** a title strip (model, run, valid time local and Z, F-hour, Day N),
  the color bar, and a `runtorunwx.com` mark, so a crop or screenshot keeps them. No tooltip;
  clicks don't zoom (the selector and `Esc` still work).
- **Legibility (Q6):** labels scale with the canvas (15–16 px with a halo at 1080p), contours about
  2 px, darker state lines, fewer and larger labels. The normal view gets heavier lines too.
- **Cities and states (Q7):** about 30 metro dots with labels (the largest TV markets), plus state
  abbreviations at region zoom, as an overlay. More cities at region zoom.
- **Projection centered on the region (Q15).**
- **PNG export** at the exact frame size (1920×1080 or 1080×1920): the composed frame is one
  canvas, so this is small. A 9:16 frame doesn't fit a landscape monitor; on a Retina screen a
  540×960 window still records at 1080×1920.
- **No face-cam space:** creators add it in post (decision 9).

**To design first:** what the slots share (valid time surely; region and field by default?); one
title strip or one per slot; a shared color bar or one per slot; picking slots by keyboard or
clicker; a safe-area guide for Shorts' overlays (measured, togglable); saving a filled layout
(it becomes M5's rundown); and whether MP4 export has to come with M3, since creators who edit in
post need a file, most of all in 9:16.

**Done when** each silhouette can be filled and captured cleanly in both orientations, PNG export
matches the frame size exactly, and labels stay readable in a 480p downscale of a 1080p frame.

#### Then decide

- **M4, browser-derived (front end only):** precipitation totals over a fixed valid-time window
  (liquid only until a snowfall field exists; a window shared by both models in compare and
  difference, never each model's own run total) (Q3); vorticity smoothing (Q10); trend and
  difference scales that grow with lead time, fixed for a whole loop (Q16); a run loop and low
  tracking across the retained runs (A3).
- **M5, show tools:** rundowns stepped with PageUp and PageDown (Q12), and MP4 loop export (A6).
- **Pipeline, after those:** thickness and snowfall (A4), anomalies (A1; climatology research is a
  separate task), GEFS spread (A2; **verify first** that `gespr` files sit beside `geavg`).
- A5, A7 and A8 fold into Phases 5 and 6.

### Phase 4: GEM, ICON (L), ARPEGE (optional)

1. Extend `regrid.py` (built in Phase 3) to curvilinear and unstructured sources, with tests on a
   synthetic analytic field (error bound at the target points). It already takes 2-D coordinate
   arrays (tested), so this is mostly reading ICON's `clat`/`clon` and testing a non-rectangular
   point set.
2. GDPS via `msc_files` (regrid 0.15°).
3. ICON via `dwd_icon` (bz2, clat/clon, Δtot_prec, rain/snow type).
4. ARPEGE only if the package download size is reasonable. Measure first.

**Done when** GEM and ICON are live and their regridded fields match the native values at sample
points within tolerance.

### Phase 5: Regionals (L)

1. `conus005` and `hi0025` grids, nodata rendering and contour clipping, and the region selector
   wired to products.
2. Wind rotation with tests (a known Lambert grid angle).
3. HRRR, then NAM (conus and Hawaii), then RRFS (surface only unless the verify step finds levels),
   then HiResW, RDPS and HRDPS.
4. 3-hourly frames and "previous 6 h" precipitation.

**Done when** each regional product renders in its region, its edges are transparent, and
switching between globals and regionals keeps the valid time.

### Phase 6: League readiness (M)

1. Venue point forecasts written per product run (`points/<product>/<run>.json`) from the decoded
   fields: the inputs to the league categories (temperature, dew point, wind, 6-h precipitation).
   The venue list is copied from `Forecast-Fantasy-League/league.json`.
2. Models section with player cards.
3. Transaction wire v1: a hand-curated `content/model-news.yaml` (date, model, headline, link).
   v2: ingest NWS Service Change Notices, ECMWF implementation news and the MSC `dd_info` list.
4. Scoreboard: daily venue accuracy from points plus observations (logic from the league repo).

**Done when** points are written for every product and the Scoreboard shows yesterday's results.

### Later

- Hourly regionals.
- GEFS 00Z extended range to 840 h (35 days, 0.5°). It needs a once-a-day product, and a scrubber
  that handles weeks.
- ECMWF 06/18Z runs (to 144 h) as extra cycles for short-range trend lags.
- UKMO and JMA, if their licences are ever confirmed. Out of this build by decision 5.
- Moving the site to a host that allows commercial use when the league charges money.

## Testing standards

- Every adapter has a fixture-based unit test: a tiny GRIB, NetCDF or bz2 sample → expected bands.
- Every derived quantity (Δ accumulations, precip type, rotation, vorticity, dew point from RH) has
  a unit test with hand-computed values.
- Every product has a dry-run command that fetches 3 hours and prints band ranges, as
  `wxtrend fetch` does today.
- Playwright: one smoke test per product (non-blank shading, zero console errors, screenshot), plus
  the Phase 2 interaction tests. A product whose source keeps only days of data (NOMADS) is tested
  on the frozen fixture bundle, never on live data.
- The cross-language frame contract (`shared/test-vectors`) stays authoritative. Change it only
  with both test suites passing.
