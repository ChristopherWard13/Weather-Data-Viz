# Build plan: Run to Run Wx

Agreed 2026-10-10. This turns the GFS Trend Viewer into **Run to Run Wx**
(`runtorunwx.com`), a multi-model site that maps every model a fantasy-league player can
pick: **if it's on the map, it's in the league.** Each quirk below comes with a decision, so
builders can execute without re-deciding. Items marked **Verify first** are facts not yet
confirmed, each with a fallback decision. Chris's decisions are recorded in
[Decisions](#decisions).

Read [adding-a-field.md](adding-a-field.md) first. Its conventions (search-regex anchoring,
row-delta frames, split fields by how the viewer loads them, never interpolate categories)
all still apply.

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

## Setup only Chris can do

Builders can't create accounts or handle credentials, so these are manual. Nothing here blocks
Phase 0 tasks 1–2 (config split, frame format v3); start those right away.

| Before | Step |
|---|---|
| Phase 0, task 3 | Create a Cloudflare account (free plan) and an R2 bucket. Turn on its `r2.dev` public URL for development |
| Phase 0, task 3 | Create an R2 API token with read/write on that bucket only |
| Phase 0, task 3 | Add GitHub Actions secrets to this repo: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` |
| Phase 0, task 5 | Add `runtorunwx.com` to Cloudflare, then switch the domain's nameservers at Namecheap to the two Cloudflare gives you. R2 custom domains need the domain's DNS to be on Cloudflare |
| Phase 0, task 5 | In the R2 bucket settings, connect the custom domain `data.runtorunwx.com` |
| Phase 0, task 5 | In GitHub, set **Settings → Pages → Custom domain** to `runtorunwx.com`, and add the DNS records GitHub lists in Cloudflare. Leave those records **DNS only** (grey cloud) so GitHub can issue the HTTPS certificate. Then tick **Enforce HTTPS** |
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
| Config | `config/site.json`, `config/fields.json`, `config/grids.json`, `config/models/<id>.json` | One file per model keeps additions self-contained |
| Scheduling | One reusable Actions workflow, one caller per product, cron set from **measured** availability | Products post at different times; one slow model never blocks another |
| Model bar | Grouped chips (Global · AI · Ensemble mean · Regional). **Only models that output the selected field and cover the current region get a chip**; the rest aren't shown | About 15 models won't fit as tabs, and a bar of only usable choices is easier to scan |
| Regions | Global models open on **North America**. Click a region on the map, or use the selector, to focus. About 8 multi-state regions, plus Mainland US and Hawaii; no state-level zoom | Focusing is just a new map extent: globals reuse the frames they already loaded, and focusing a mainland region reveals the regional models |
| Fields | Left sidebar grouped Surface / Upper air (today's tabs become sidebar items) | The model becomes the top-level choice |
| Time | Scrubber in **valid time**. Switching model keeps the field and valid time | The core scouting move: same moment, different model |

## Model roster

### In this build

| Model | Kind | Source (retention) | Runs | Display hours | Step | Trend lags | Native grid → display | Phase |
|---|---|---|---|---|---|---|---|---|
| GFS | Global | AWS `noaa-gfs-bdp-pds` (years) | 00/06/12/18 | **0–384** | 6 h | 6/12/24/48 | 0.25° → `na025` crop | live (range grows in Phase 1) |
| ECMWF IFS | Global | AWS `ecmwf-forecasts`, eu-central-1 (since 2023) | 00/12 | **0–360** | 6 h | 12/24/48 | 0.25°, lon −180..180 → crop | 1 |
| ECMWF AIFS | AI | same bucket, `aifs-single/` | 00/06/12/18 | **0–360** | 6 h | 6/12/24/48 | 0.25° → crop | 1 |
| NOAA AIGFS | AI | NOMADS `aigfs/` (10 days) | 00/06/12/18 | **0–384** | 6 h | 6/12/24/48 | 0.25° → crop | 3 |
| GEFS mean | Ensemble mean | AWS `noaa-gefs-pds`, `geavg` in `pgrb2ap5` | 00/06/12/18 | **0–384** | 6 h | 6/12/24/48 | 0.5° → `na025` regrid | 3 |
| AIGEFS mean | Ensemble mean (AI) | NOMADS `aigefs/` | 00/06/12/18 | **0–384** | 6 h | 6/12/24/48 | 0.25° → crop | 3 |
| HGEFS mean | Ensemble mean (hybrid) | NOMADS `hgefs/` | 00/06/12/18 | 0–240 | 6 h | 6/12/24/48 | 0.25° → crop | 3 |
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

- **Fetch hours equal display hours.** Today GFS fetches past its display range (to F288) so that
  48-hour comparisons reach F240. With full ranges there's nothing past the end to fetch.
  `fetch_hours` becomes `min(display_max + max_lag, model_max)` per product, which equals the
  display range for every product above. Comparisons that would need an hour past the older
  run's end show "comparison unavailable", as now.
- **Step:** globals stay 6-hourly for their whole range, even where a model posts 3-hourly
  (GFS to F120, ECMWF to F144). One step keeps the trend-lag arithmetic and the scrubber uniform.
  Regionals are 3-hourly (decision 3).
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
| `precip` | 6-h precipitation and type | qpf uint16 0.01 in · ptype uint8 categories | category 5 = "unspecified" |
| `hgt500` | 500 mb height | uint16 1 m, 0 | ✓ |
| `vort500` | 500 mb absolute vorticity | uint8 1×10⁻⁵ s⁻¹, −50 | ✓ |
| `t850` | 850 mb temperature | uint8 0.5 °C, −60 | ✓ |

Per-hour storage on `na025` goes from about 350 KB to about 460 KB.

### Availability

✓ native · D derived from the model's own fields · ✗ not output · ? verify first

| Model | Jet | T2m | Td2m | Wind10 | Gust | MSLP | Precip | Type | Hgt500 | Vort500 | T850 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| GFS | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ MSLET | ✓ | ✓ | ✓ | D | ✓ |
| ECMWF IFS | ✓ | ✓ | ✓ | ✓ | ✓ period max | ✓ msl | D (Δtp) | D | ✓ gh | D | ✓ |
| ECMWF AIFS | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | D (Δtp) | D rain/snow | ✓ | D | ✓ |
| NOAA AIGFS | ? | ? | ? | ? | ✗ | ? | ? | ✗ | ? | D | ? |
| GEFS mean | ✓ | ✓ | D (T + RH) | ✓ | ✗ | ✓ PRMSL | ✓ | D (member-mean flags) | ✓ | D | ✓ |
| AIGEFS mean | ? | ? | ? | ? | ✗ | ? | ? | ✗ | ? | D | ? |
| HGEFS mean | ? | ? | ? | ? | ? | ? | ? | ✗ | ? | D | ? |
| GEM (GDPS) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ 6 h | D | ✓ | D | ✓ |
| ICON | ✓ | ✓ | ✓ | ✓ | ✓ vmax_10m | ✓ pmsl | D (Δtot_prec) | D rain/snow | ✓ fi/g | D | ✓ |
| HRRR | ✓ | ✓ | ✓ | ✓ rotate | ✓ | ✓ MSLMA | ✓ | D | ✓ | D | ✓ |
| NAM 3 km | ✓ | ✓ | ✓ | ✓ rotate | ✓ | ✓ MSLET | ✓ | D | ✓ | D | ✓ |
| RRFS | ✗ | ✓ | ✓ | ? | ✓ | ✓ MSLET | ✓ | D | ✗ | ✗ | ✗ |
| HiResW, RDPS, HRDPS, ARPEGE | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |

Verified so far: GFS; ECMWF and AIFS inventories (2026-10-09); GEFS mean `pgrb2ap5` inventory
and ranges; HRRR `wrfsfc` and NAM `conusnest` inventories; RRFS `2dfld`, which has no pressure
levels; ICON pressure levels.

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
- Units: ECMWF/AIFS `tp` and `sf` are metres of water. ICON and NCEP are kg m⁻² (= mm).

### Precipitation type

Codes: 0 none, 1 rain, 2 snow, 3 sleet, 4 freezing rain, 5 unspecified. Ties go to the more
impactful type (existing rule).

| Model | Rule |
|---|---|
| GFS | 6-h averaged CRAIN/CSNOW/CICEP/CFRZR fractions (existing) |
| ECMWF IFS | Snow if Δsf/Δtp ≥ 0.5, else rain. Override with freezing rain (ptype 3, 12) or sleet (ptype 8) if instantaneous `ptype` at f, or at f−3 where that step exists, says so |
| AIFS, ICON | Snow if the snow share of the 6-h amount ≥ 0.5, else rain (no sleet or freezing rain) |
| GEFS mean | The member-mean CRAIN/CSNOW/CICEP/CFRZR are the fraction of members with each type. Take the largest at f, adding f−3 where that step exists |
| GEM, RDPS, HRDPS | The largest of Rain/Snow/IcePellets/FreezingRain-Accum6h |
| HRRR, NAM, RRFS, HiResW | Majority of the instantaneous flags at f and f−3, weighted by each 3-h amount |
| Models with no type information | 5 "unspecified": neutral ramp, and the legend says type isn't available |

### Model-specific decisions

- **Heights:** convert geopotential (m² s⁻²: AIFS `z`, ICON `fi`) to metres by dividing by 9.80665.
  **Verify first:** GDPS height units. MSC has historically used decametres; check the GRIB
  `units` attribute and scale to metres.
- **Sea-level pressure:** use each model's standard reduction (MSLET, MSLMA, msl, pmsl,
  `Pressure_MSL`) and name it on the model card. Don't recompute.
- **Gust:** each model's native gust (instantaneous or period maximum), labelled on the model card.
  Don't harmonize.
- **ECMWF:** only use the 00/12Z runs, which reach 360 h (06/18Z stop at 144 h). The model posts
  3-hourly to 144 h, then 6-hourly; frames are 6-hourly throughout. The S3 bucket throttles bursts
  with `503 SlowDown` (seen while writing this plan), so use retries with backoff and at most 4
  concurrent requests. The index is eccodes-style (`IDX_STYLE = "eccodes"` in Herbie).
- **GEFS mean:** use the 0.5° `pgrb2ap5` files for every field and hour, regridded to `na025`.
  - The 0.25° `pgrb2sp25` files stop at 240 h and have no upper-air fields. Mixing the two
    would make the map visibly change resolution at F246, and ensemble means are smooth anyway.
  - `pgrb2ap5` has no gust or 2 m dew point: gust is unavailable, and dew point is derived from
    2 m T and RH (Magnus formula, unit-tested).
  - Sea-level pressure is PRMSL; MSLET is only in `pgrb2sp25`.
- **GDPS, RDPS, HRDPS:** one file per variable per hour and no `.idx`, so jobs download whole files.
  The MSC Datamart path is dated (`/{YYYYMMDD}/WXO-DD/model_gdps/15km/…`); Herbie's `gdps` template
  takes `variable=` and `level=`.
- **ICON:** files are bz2-compressed and kept about 24 h. The job must run every cycle; a missed
  cycle is gone for good. `vmax_10m` is the maximum since the previous output step.
- **RRFS:** only `2dfld` files are on AWS, so RRFS shows surface fields only. **Verify first:** look
  for a pressure-level product on NOMADS (`rrfs/v1.0/`). If found, add the upper-air fields.
- **HiResW:** NOMADS keeps 2 days, so there's no backfill after an outage. **Verify first:** product
  names and fields for the `conus` and `hi` domains.
- **NOMADS** returned empty bodies to plain `curl` from the dev sandbox but works from browsers.
  Verify it works from GitHub runners in Phase 3 before relying on it.
- **Latency:** measure each product's posting time for 3 days before setting its cron, the way GFS
  was measured (see the comment in `update.yml`). Cron = T0 + last needed hour + 15 min, with a
  retry 45 min later.

### Frame format v3 and storage layout

- Frame bytes are unchanged (bands concatenated, row-delta, gzip). New: a band may declare
  `"nodata": <max stored value>`, and encoding clips valid values to `max − 1`. The renderer draws
  transparent where any bilinear corner is nodata. Contours are drawn, then clipped to the
  valid-data mask.
- Manifest schema 3 adds `product`, `model`, `grid` (an id from `grids.json` plus its definition),
  per-band `nodata`, and `fields` limited to what the model provides.
- R2 keys: `<product>/manifest.json`, `<product>/runs/<YYYYMMDDHH>/<field>/f<FFF>.bin.gz`, and
  `points/<product>/<run>.json` (league).
- Cache headers: frames `public, max-age=31536000, immutable` (a written frame never changes);
  manifests `max-age=60`. Because browsers and the CDN keep frames forever, **an encoding change
  must use a new field id** (e.g. `t850v2`). Never overwrite frames in place.
- Bucket CORS: allow GET from `https://runtorunwx.com`, `https://www.runtorunwx.com`,
  `https://christopherward13.github.io` (until the custom domain is live) and
  `http://localhost:*` (dev).
- Public access goes through the custom domain. The `r2.dev` URL is rate-limited and for
  development only.

### Pipeline changes (Python, `pipeline/`)

- `config.py` loads the split config. A `Product` replaces today's single `Config` model block, and
  every function that takes `cfg` takes a product.
- `fetch.py` becomes source adapters behind one interface,
  `fetch_hour(product, init, fhr, fields) -> {field: {band: values}}`:
  - `herbie_grib`: GFS, ECMWF, AIFS, GEFS, AIGFS, AIGEFS, HGEFS, HRRR, NAM, RRFS, HiResW. The pinned
    Herbie (2026.9.2) has `aigfs` (products `sfc` and `pres`, NOMADS only), `aigefs` and `hgefs`
    (ensemble statistics under `ensstat/`) templates. AIGFS splits surface and pressure fields
    into two files per hour, so a job downloads from both.
  - `msc_files`: GDPS, RDPS, HRDPS.
  - `dwd_icon`: bz2 plus icosahedral grid.
  - `arpege_package`: optional.
- `catalog.py` gains per-model recipes: GRIB keys and compute functions per (model, field), with
  shared helpers for accumulations, precip type, rotation and vorticity.
- `store.py` gains an R2 sync:
  1. Read the product's remote manifest.
  2. Compute the missing jobs.
  3. Write frames locally, then upload them.
  4. Upload the new manifest.
  5. Delete pruned runs.

  Use boto3 against R2's S3 endpoint. Credentials go in Actions secrets: `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
- Retention stays derived: `1 + max_lag / cycle_interval` runs per product.
- `fetch_hours` becomes `min(display_max + max_lag, model_max)` (see [Forecast range](#forecast-range)).

### Workflows

- `.github/workflows/product.yml` is reusable (`workflow_call`, input `product`):
  1. Restore the regrid-weights cache.
  2. Run `wxtrend update --product X`.
  3. Validate the manifest.
  4. Sync to R2.
- One small caller workflow per product sets the cron and `concurrency: product-X`.
- `ci.yml` and the Pages deploy run on code changes only. Playwright e2e runs against a
  fixture-sized local dataset (a few hours of GFS plus one regional product) built in CI.
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
  (`?v=jet&f=…`) still open on GFS.
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

- **R2:** 10 GB storage free, then 1.5¢/GB-month; egress free.
- **Writes:** about 25k frames a day, roughly 750k a month, which is under the 1M free writes a
  month. Backfills add a one-off burst. If writes approach the limit, bundle each hour's fields
  into one object per product.
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
   and `runtorunwx.com` serves the site through GitHub Pages. Add a `web/public/CNAME` containing
   `runtorunwx.com` so deploys keep the custom domain. Switch `VITE_DATA_BASE` to the custom
   domain and update CORS.

**Done when** GFS updates through R2, the site loads data from `data.runtorunwx.com` at
`https://runtorunwx.com`, and no deploy happens on data updates.

### Phase 1: ECMWF IFS and AIFS, new fields (M)

1. Add `hgt500`, `vort500` and `t850` for GFS: recipes, the vorticity helper, and its unit tests
   (a solid-body rotation field gives the known ζ).
2. Extend GFS to its full range (0–384 h), with `fetch_hours` per [Forecast range](#forecast-range).
   GFS posts 3-hourly from F120, so keep the 6-hourly steps and the 6-hour `APCP` buckets.
3. ECMWF IFS adapter (eccodes index, 00/12Z, 0–360 h, Δtp, the precip-type rule, throttling
   backoff).
4. AIFS (0–360 h, Δtp, rain/snow type, no gust).
5. Measure latency; set crons. ECMWF's 00/12Z runs reached AWS complete at about T0+7:35 on
   2026-10-09; AIFS at about T0+5:25.

**Done when** all three models show all their fields across their full ranges in forecast and
trend mode, and the e2e covers each.

### Phase 2: Site organization (M, can run in parallel with Phase 1 after Phase 0)

1. Rebrand to **Run to Run Wx**: page title, header, meta description, favicon if desired, and a
   footer that credits each data source (NOAA; ECMWF CC BY 4.0; DWD; ECCC; Météo-France
   Licence Ouverte) as models are added.
2. Model bar, field sidebar, valid-time scrubber, URL state v2 with old links still working. The
   scrubber spans the selected model's own range (up to 16 days).
3. Model-bar filtering from the manifests' field lists: only usable chips, the "Not shown" note,
   and the drop-out fallback with its banner.
4. Region focus: the selector, click-to-focus hit areas (basemap build gains the merged state
   polygons), breadcrumb and `Esc`, and refitting the projection without refetching frames.
   Regional chips appear once Phase 5 products exist.
5. Compare mode (side by side; difference on the same grid). Both panels share the region.
6. Mobile bottom sheets. Tapping a region focuses it.

**Done when** e2e covers:
- model switching with time preserved;
- a field change that hides the current model and falls back, with the banner;
- clicking a region and returning with `Esc`, with no new frame requests for globals;
- compare mode;
- an old-link redirect;
- a 375 px layout screenshot.

### Phase 3: NOAA AI and ensemble means (M)

1. Verify first: the AIGFS (`sfc` + `pres`), AIGEFS and HGEFS inventories and forecast ranges.
   Fill in their availability rows and adjust the roster's display hours if needed.
2. Confirm NOMADS works from GitHub runners. It keeps about 10 days, so the first run backfills
   only what's there.
3. AIGFS via Herbie's `aigfs` template, 0–384 h.
4. GEFS mean from `pgrb2ap5` (0.5° → `na025`, 0–384 h, dew point from RH, PRMSL, no gust).
   This needs the regridder, so build `regrid.py` here (it moves up from Phase 4).
5. AIGEFS mean (0–384 h) and HGEFS mean (0–240 h) via Herbie's `aigefs`/`hgefs` templates
   (`ensstat` mean files).

**Done when** four new chips are live (AIGFS and three ensemble means) across their full
ranges, and fields they lack aren't offered.

### Phase 4: GEM, ICON (L), ARPEGE (optional)

1. Extend `regrid.py` (built in Phase 3) to curvilinear and unstructured sources, with tests on a
   synthetic analytic field (error bound at the target points).
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
  the Phase 2 interaction tests.
- The cross-language frame contract (`shared/test-vectors`) stays authoritative. Change it only
  with both test suites passing.
