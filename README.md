# Run to Run Wx

**[runtorunwx.com](https://runtorunwx.com)** maps **GFS, ECMWF (IFS) and AIFS forecasts, how
each has changed between model runs, and how the models differ**. It started as a 250 mb
wind-speed version of the Tropical Tidbits "trend" overlays (as the GFS Trend Viewer). It now has
eight fields, each with **Forecast**, **Trend** and **Compare** modes, across each model's full
forecast range (GFS 16 days, ECMWF and AIFS 15 days), for North America or a focused region.

![Jet stream trend: Δ|V| shading with isotachs and flow arrows](docs/screenshot.png)

| Temperature | Wind | Precipitation |
|---|---|---|
| ![2 m temperature with the freezing line](docs/screenshot-temperature.png) | ![10 m wind with barbs, isobars and pressure centers](docs/screenshot-wind.png) | ![6-hour precipitation by type with isobars](docs/screenshot-precip.png) |

| 500 mb, GFS | 500 mb, ECMWF | 500 mb, AIFS | 850 mb | Phone |
|---|---|---|---|---|
| ![GFS 500 mb vorticity and heights](docs/screenshot-500mb.png) | ![ECMWF 500 mb vorticity and heights](docs/screenshot-ecmwf.png) | ![AIFS 500 mb vorticity and heights](docs/screenshot-aifs.png) | ![850 mb temperature with the 0 °C line](docs/screenshot-850mb.png) | ![The 375 px phone layout](docs/screenshot-mobile.png) |

| Field | Forecast | Trend (current − older run, same valid time) | Overlays |
|---|---|---|---|
| **Jet stream** (250 mb) | wind speed (kt) | Δ\|V\|: red faster, blue slower | isotachs 50–190 kt with flow arrows, wind barbs, the older run's isotachs (dashed violet) |
| **Temperature**, **Dew point** (2 m) | °F | Δ: red warmer, blue colder | 32 °F line, 10 °F contours, the older run's 32 °F line |
| **Wind** (10 m sustained), **Gusts** | kt | Δ: red windier, blue calmer | wind barbs, isobars every 4 hPa, H/L centers |
| **Precipitation** | 6-hour total by dominant type: rain, snow, sleet, freezing rain | Δ 6-h total: green wetter, brown drier | isobars, H/L centers |
| **500 mb** | absolute vorticity (10⁻⁵ s⁻¹) | Δ height (m): red higher, blue lower | heights every 6 dam, the older run's heights |
| **850 mb** | temperature (°C) | Δ: red warmer, blue colder | 0 °C line, 5 °C contours, the older run's 0 °C line |

The page has a **model bar** across the top (grouped Global · AI), a **Fields** sidebar on the
left, the options on the right, and a **valid-time scrubber** under the map:

- **Models:** switching keeps the field and the valid time. The bar shows only models that output
  the selected field, each with its latest run ("18Z"), and says who's missing ("Not shown: AIFS
  (no gust output)"). Picking a field the current model lacks switches to another model with a
  banner ("AIFS doesn't output gusts, so this shows GFS.").
- **Regions:** hover a US region to outline it, click to zoom (or use the region menu); the
  breadcrumb or <kbd>Esc</kbd> zooms back out. Zooming refits the map: no frames are fetched again.
  Stats cover the region in view.
- **Compare:** this model and another side by side at the same valid time, or their difference
  (A − B) when both are on the same grid.
- **Phones:** the model bar scrolls, Fields and Options are bottom sheets, and the scrubber is
  pinned to the bottom. Tap a region to zoom.

In trend mode the shading is, for example,

> Δ|V| = |V|(current run) − |V|(older run), both valid at the same time

and the same rule applies to every field. The jet opens in trend mode; the others open in
forecast mode. Surface wind is at 10 m, the standard height. Gusts are each model's own: GFS's is
instantaneous, ECMWF's is the maximum over the last 1, 3 or 6 hours (by forecast range).

The site is published at **https://runtorunwx.com** (GitHub Pages with a custom domain; see
[below](#github-pages-r2-and-actions-setup)). Its data lives in a Cloudflare R2 bucket served at
`https://data.runtorunwx.com`, which the pipeline updates directly, so data updates never
redeploy the site.

## How the comparison lines up

For a current run initialized at **T0** and viewed at forecast hour **f**, the valid time is
**T0 + f**. With lag **L**, the comparison frame is the run initialized at **T0 − L**, at forecast hour
**f + L**, which is valid at the same instant. For example, at the default 48 h lag:

| Current run | Hour | Valid | Compared with | Hour |
|---|---|---|---|---|
| 2026-10-08 18Z | F000 | 2026-10-08 18Z | 2026-10-06 18Z | F048 |
| 2026-10-08 18Z | F360 | 2026-10-23 18Z | 2026-10-06 18Z | F408 |

Each model is shown across its full range, so in that second row the older run has no F408 (GFS
stops at F384). Runs are fetched to `min(display max + max lag, model max)`, which is the model's
last hour. If the older run or the needed hour isn't available, the map shows a
**"comparison unavailable"** state naming exactly what is missing. It never falls back to another
lag. Precipitation is a 6-hour total, so it starts at F006, and F000 says so (so does ECMWF's
gust, a maximum since the previous output). ECMWF runs only at 00/12Z, so it has no 6-hour lag.

## Repository layout

```
config/                every parameter, shared by the pipeline and the frontend (see Configuration)
pipeline/              Python pipeline (uv): Herbie / ECMWF index + cfgrib → compact frames + manifest.json
  src/wxtrend/         alignment, fields, catalog (per-model GRIB recipes), cycles, fetch (source
                       adapters), net (backoff), store, manifest, update, cli
  schema/              JSON Schema for manifest.json
  tests/               pytest
web/                   static frontend (Vite + TypeScript + d3)
  src/views/           one module per view: what to load, how to shade, overlays, stats,
                       readout; index.ts lists the Fields sidebar
  src/                 map rendering, contours, barbs, pressure centers, palettes, frame loading
  scripts/             one-off Natural Earth → TopoJSON basemap builder (lines and region hit areas)
  tests/               vitest unit tests
  e2e/                 Playwright tests against the production build and real data
shared/test-vectors/   alignment, Δ, and frame-encoding cases checked by BOTH pytest and vitest
docs/                  screenshots, adding-a-field.md (how to add the next data type), build-plan.md
infra/                 r2-cors.json: the R2 bucket's CORS rules
.github/workflows/     gfs.yml, ecmwf.yml, aifs.yml → product.yml (cron → pipeline → R2),
                       pages.yml (deploy on code changes), ci.yml (tests on push/PR)
data/                  pipeline output, one directory per product, e.g. data/gfs/ (git-ignored)
```

Adding another field (CAPE, …) or model is a short recipe:
**[docs/adding-a-field.md](docs/adding-a-field.md)**, which also collects the GRIB, ECMWF, storage,
and rendering gotchas. The multi-model roadmap is [docs/build-plan.md](docs/build-plan.md).

## Local setup

Prerequisites (all free): [uv](https://docs.astral.sh/uv/) (`brew install uv`) and Node.js 22+.
uv installs a suitable Python (3.11+) on its own, and the `eccodes` wheel bundles the ecCodes
library, so nothing else needs to be installed.

```bash
make setup
```

```bash
make dev
```

`make dev` processes each product's latest complete cycle plus the older runs needed for the
longest lag (GFS 9 runs × 65 hours, ECMWF 5 × 61, AIFS 9 × 61), then serves the site at
http://localhost:5173. Later runs only fetch what's new. `make dev QUICK=1`
fetches just the runs the newest one is compared against (5 for GFS and AIFS, 4 for ECMWF). If the fetch fails (for example when
offline) but data already exists, the site is served anyway.

Other targets:

| Command | What it does |
|---|---|
| `make data` | Run the pipeline once for every product (`wxtrend update --product …`) into `data/<product>/` |
| `make test` | pytest + vitest |
| `make e2e` | Build, serve, and run the Playwright tests against `data/`, which needs all three products (also writes the screenshots) |
| `make e2e-data` | Build the small dataset CI runs the e2e on (each product's pinned cycle and lag runs, F000–F060) into `e2e-data/`; test with `WXTREND_DATA_DIR=$PWD/e2e-data make e2e` |
| `make build` | Build the static site into `web/dist/` (production reads data from R2) |
| `make verify` | Validate each product's `manifest.json` against the schema and check every frame's size |
| `make r2-cors R2_BUCKET=<name>` | Apply `infra/r2-cors.json` to the bucket with wrangler (run `npx wrangler@4 login` first) |

### Pipeline CLI

```bash
cd pipeline
uv run wxtrend update                        # latest complete cycle + retention window; no-op if done
uv run wxtrend update --cycle 2026100818     # treat a specific cycle as latest
uv run wxtrend --data-dir /tmp/dry fetch --cycle latest --hours 0       # one-hour dry run into /tmp/dry/gfs/
uv run wxtrend --data-dir /tmp/dry fetch --product ecmwf --cycle latest --hours 0,96,150   # ECMWF dry run
uv run wxtrend fetch --cycle latest --hours 0-24 --fields t2m,mslp      # selected fields
uv run wxtrend verify                        # schema + frame sizes
uv run wxtrend inspect --fhr 120 --lag 48 --field t2m --band temp       # Δ statistics for one pair
uv run wxtrend update --remote               # what CI runs: R2's manifest decides what's missing
uv run wxtrend verify --remote               # frames not on disk must be listed in R2
uv run wxtrend sync                          # publish to R2: new frames, then the manifest, then prune
```

Every command takes `--product` (`gfs`, the default, `ecmwf` or `aifs`), e.g.
`uv run wxtrend update --product ecmwf`. Each product is stored in `<data-dir>/<product>/` (e.g.
`data/gfs/`), the same layout as the bucket. The R2 commands read `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` from the environment.

**Latest complete cycle:** `update` steps back from the current cycle (6-hourly; 12-hourly for
ECMWF). It sends HEAD requests for the index file of every forecast hour it needs (the model's
`index_url`), checking the last hour first. The first cycle with all of them published is used.

**Fetching:** for each (run, hour) with any missing field, only the needed GRIB messages are
downloaded, with HTTP range requests from the index: through Herbie for GFS (`.idx`, about 9 MB
per hour), and directly from ECMWF's eccodes `.index` for IFS and AIFS (Google Cloud mirror; about
14 and 8 MB per hour, including the f−6 running totals that 6-hour precipitation needs). Each
field is then computed, encoded, and gzipped in a pool of worker processes, with retries; HTTP
requests back off on throttling.

**Pruning and the manifest:** runs outside the window are deleted, and the manifest is rebuilt from
what is on disk (plus, with `--remote`, what R2's manifest lists). When a field is added to a
model's file in `config/models/`, the next update fetches just that field for every retained run.

## GitHub Pages, R2 and Actions setup

Do these once:

1. **Settings → Pages → Build and deployment → Source:** choose **GitHub Actions**.
2. **Settings → Actions → General:** make sure Actions are allowed. The workflows declare their own
   permissions, so the default read-only token setting is fine.
3. **Cloudflare R2:** a bucket, an API token with object read/write on that bucket only, and the
   repository secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET`.
   Apply the CORS rules with `make r2-cors R2_BUCKET=<name>` (or paste the same origins into the
   bucket's **Settings → CORS policy**).
4. **Domains:** `runtorunwx.com`'s DNS is on Cloudflare. The bucket's custom domain is
   `data.runtorunwx.com`. **Settings → Pages → Custom domain** is `runtorunwx.com`, with GitHub's
   apex A/AAAA records and a `www` CNAME to `christopherward13.github.io` in Cloudflare, all
   **DNS only** (grey cloud) so GitHub can issue the certificate. No `CNAME` file is needed: GitHub
   ignores it for Actions deploys.
5. **Actions → GFS / ECMWF / AIFS → Run workflow** for the first data. With an empty bucket each
   backfills its whole window. The schedules then take over.
6. **Actions → Deploy site → Run workflow** for the first deploy. Later deploys happen on their own
   when code changes.

What the workflows do:

- **`gfs.yml`, `ecmwf.yml`, `aifs.yml`** (one small caller per product) set the schedule and
  `concurrency: product-<id>`, and run the reusable **`product.yml`**:
  1. `wxtrend update --product <id> --remote` reads the product's manifest from R2, fetches only the
     frames it doesn't list, and writes a new manifest listing R2's frames plus the new ones.
  2. `wxtrend verify --remote` validates the manifest: every frame it lists is on disk (checked) or
     already in R2.
  3. `wxtrend sync` uploads the new frames, then the manifest, then deletes runs the manifest no
     longer lists. A failure stops before the next step, so R2's manifest only ever lists frames
     that are there.

  Nothing is cached between runs and nothing is deployed: R2's manifest is the source of truth. When
  nothing changed, verify and sync are skipped.
- **Schedules** come from measured posting times (object timestamps, 2026-10-07 to 10-11): each
  fires 15 minutes after the last needed hour usually lands, with a retry 45 minutes later.

  | Product | Complete after T0 | Runs at | Retry |
  |---|---|---|---|
  | GFS 00/06/12/18Z, F000–F384 | 5:12–5:31 | T0 + 5:47 | T0 + 6:32 |
  | ECMWF 00/12Z, F000–F360 | 7:34–7:36 (all at once) | T0 + 7:52 | T0 + 8:37 |
  | AIFS 00/06/12/18Z, F000–F360 | 5:23–5:39 | T0 + 5:55 | T0 + 6:40 |

  The retry is a cheap no-op when the first run already succeeded. GitHub can start scheduled runs
  hours late (3–5.5 h on 2026-10-11); a late run still takes the latest complete cycle and fills in
  whatever the window is missing, so lateness costs freshness, never data.
- **`pages.yml`** deploys the site when `web/`, `config/` or `shared/` change. It first builds a small
  real dataset (for each product a pinned cycle and its lag runs, F000–F060, from the sources,
  never R2) and runs the Playwright tests on it, then builds the production site, which reads its data from
  `VITE_DATA_BASE` in `web/.env.production` (`https://data.runtorunwx.com/`).
- **`ci.yml`** runs pytest, vitest, and a production build on pushes to `main` and on pull requests.

Things to know:

- **Caching:** frames are uploaded with `Cache-Control: public, max-age=31536000, immutable` and the
  manifest with `max-age=60`. A written frame never changes, so **an encoding change needs a new
  field id**; never overwrite frames in place.
- GitHub **disables scheduled workflows in public repositories after 60 days without repository
  activity**. If updates stop, re-enable the workflow from the Actions tab (or push any commit).
- To refetch a product, delete `<product>/manifest.json` from the bucket. The next run treats it
  as empty.

## Data format (manifest schema 3, frame format v3)

Each product's data lives in its own directory: `gfs/manifest.json` and `gfs/runs/…` in the R2
bucket, and `data/gfs/` locally (served at `/data/gfs/` by the dev server). The site finds it at
`VITE_DATA_BASE` + `<product>/`.

### Frames: `runs/<YYYYMMDDHH>/<field>/f<FFF>.bin.gz`

- **Fields:** one file per (run, field, hour). A field is a group of **bands**, stored back to back
  in config order. Most fields have one band; precipitation has two (amount and type).
- **Band layout:** each band is `ny × nx` samples, row-major. **Row 0 is the northern edge (70°N)**
  and rows go south; columns go west (170°W) to east (50°W). `uint16` samples are little-endian.
- **Row-delta filter:** each row stores its first sample, then the difference from the previous
  sample modulo 2^bits. Decoding is a running sum per row. This makes gzip about 20% smaller.
- **Values:** `value = stored × scale + offset`, in the band's `units`. Values are rounded to the
  nearest step and clipped to the dtype's range. Wrapped bands (directions, `wrap: 360`) are stored
  modulo instead.
- **Missing data (v3):** a band may declare `"nodata"`, which must be the dtype's top value (255 or
  65535). Missing samples (NaN) are stored as that value, valid values are clipped to one below it,
  and decoders return NaN for it. A band without `nodata` can't hold missing data: the pipeline
  refuses to encode NaNs into it. Only `vort500` declares it (its edge rows and columns have no
  centred difference); the original nine fields are byte-for-byte the same as in v2. Adding
  `nodata` to an existing band would be an encoding change, which needs a new field id.
- **Compression:** gzip. The browser decompresses with `DecompressionStream('gzip')`, and passes
  bytes through if a server already removed the gzip layer.

| Field | Bands | Encoding |
|---|---|---|
| `wspd250` | speed | uint8, 1 kt |
| `wdir250` | dir (from) | uint8, 360/256°, wraps |
| `t2m` | temp | uint8, 1 °F, offset −80 |
| `d2m` | dewpt | uint8, 1 °F, offset −80 |
| `wspd10` | speed | uint8, 1 kt |
| `wdir10` | dir (from) | uint8, 360/256°, wraps |
| `gust` | gust | uint8, 1 kt |
| `mslp` | mslp (GFS MSLET; ECMWF and AIFS `msl`) | uint16, 0.1 hPa |
| `precip` | qpf (6-h total, liquid equivalent); ptype (0 none, 1 rain, 2 snow, 3 sleet, 4 freezing rain) | uint16, 0.01 in; uint8 category |
| `hgt500` | hgt (500 mb geopotential height) | uint16, 1 m |
| `vort500` | vort (500 mb absolute vorticity) | uint8, 10⁻⁵ s⁻¹, offset −50, nodata 255 |
| `t850` | temp (850 mb) | uint8, 0.5 °C, offset −60 |

Precipitation type is the dominant type over the same 6 hours as the total, with ties going to the
more impactful type. GFS's comes from its 6-hour-averaged categorical fields. ECMWF's is snow when
snowfall is at least half the total, else rain, overridden by freezing rain or sleet where its
instantaneous type at f or f−3 says so. AIFS has only rain and snow. ECMWF and AIFS totals are the
difference of running totals (f minus f−6). Vorticity is computed from each model's 500 mb winds on
the display grid, the same way for every model.

### `manifest.json`

The manifest is validated against `pipeline/schema/manifest.schema.json` and built from the frames
that exist (on disk, plus those already in R2), so it never lists a frame that doesn't exist. Runs
are listed newest first.

```json
{
  "schema_version": 3,
  "generated_at": "2026-10-09T05:35:00Z",
  "product": "gfs",
  "model": { "id": "gfs", "name": "GFS" },
  "grid": { "id": "na025", "nx": 481, "ny": 221, "lon0": -170.0, "lat0": 70.0, "dlon": 0.25, "dlat": -0.25,
            "row_order": "north_to_south", "col_order": "west_to_east",
            "lat_min": 15.0, "lat_max": 70.0, "lon_min": -170.0, "lon_max": -50.0 },
  "compression": "gzip",
  "layout": "bands_concatenated_row_major_little_endian",
  "filter": "row_delta",
  "fields": {
    "t2m": { "label": "2 m temperature", "min_fhr": 0, "frame_bytes": 106301,
             "bands": [{ "name": "temp", "units": "F", "dtype": "uint8", "scale": 1.0, "offset": -80.0 }] },
    "precip": { "label": "6-hour precipitation and type", "min_fhr": 6, "frame_bytes": 318903, "bands": ["…"] }
  },
  "path_template": "runs/{run}/{field}/f{fhr:03d}.bin.gz",
  "cycle_interval_hours": 6,
  "display_hours": [0, 6, "…", 384],
  "latest": "2026100900",
  "runs": [
    { "id": "2026100900", "init": "2026-10-09T00:00:00Z",
      "hours": { "wspd250": [0, 6, "…", 384], "precip": [6, 12, "…", 384], "…": [] }, "complete": true }
  ]
}
```

`product` is a model on one display grid. `grid.id` names a grid in `config/grids.json`. `fields`
lists only the fields the model provides, and bands that declare `nodata` carry it here.
`complete` is `false` when some (field, hour) failed to fetch; those are retried on the next run.

Reading a frame in Python:

```python
import gzip, json, numpy as np
m = json.load(open("data/gfs/manifest.json"))
g, f = m["grid"], m["fields"]["t2m"]
raw = gzip.decompress(open("data/gfs/runs/2026100900/t2m/f120.bin.gz", "rb").read())
d = np.frombuffer(raw, np.uint8, count=g["nx"] * g["ny"]).reshape(g["ny"], g["nx"])
stored = np.cumsum(d.astype(np.int64), axis=1) % 256       # undo the row-delta filter
temp_f = stored * f["bands"][0]["scale"] + f["bands"][0]["offset"]   # row 0 = 70°N
```

## Configuration

All parameters live in `config/`. The pipeline reads it (`wxtrend --config <dir>` or
`$WXTREND_CONFIG` to use another copy), and Vite bundles `site.json`, `grids.json`, `regions.json`
and the model files into the frontend.

| File | Key | Default | Notes |
|---|---|---|---|
| `site.json` | `views.jet.isotachs_kt` | 50–190 every 10, default [100] | |
| | `views.<id>.trend_limit` / `auto_round` | jet ±60 kt, temperature ±20 °F, wind ±20 kt, precipitation ±0.5 in, 500 mb ±60 m, 850 mb ±8 °C | Fixed trend scale; auto rounds max\|Δ\| up |
| | `model_bar` | Global: gfs, ecmwf · AI: aifs | Model-bar groups and their products, in order; the first product is the default and the last-resort fallback |
| | `projection` | Lambert conformal, central meridian 110°W, parallels 30°/60° | |
| | `pipeline` | lookback 8 cycles, 6 worker processes, 3 attempts | |
| `fields.json` | `<id>` | see the table above | The canonical catalog: label, bands and encodings, the same for every model |
| `grids.json` | `na025` | 15–70°N, 170–50°W at 0.25° | Display grids. Must sit on the source's 0.25° grid |
| `regions.json` | `regions` | North America (`na025`), Mainland US, 8 US regions, Hawaii | Zoom boxes, `parent` (breadcrumb and <kbd>Esc</kbd>), `states` merged into click targets by `npm run basemap`; `"hit": "box"` makes the whole box the target (Hawaii's islands are too small) |
| `models/<id>.json` | `name`, `source` | GFS: Herbie, `pgrb2.0p25` on AWS. ECMWF/AIFS: `ecmwf_opendata` on Google Cloud, 4 connections | `source.index_url` templates one hour's index |
| | `forecast_hours` | GFS 0–384, ECMWF/AIFS 0–360, every 6 h | Displayed hours; `model_max` caps the fetch range |
| | `cycle_interval_hours` | GFS/AIFS 6, ECMWF 12 | |
| | `lags_hours` / `default_lag_hours` | GFS/AIFS 6, 12, 24, 48; ECMWF 12, 24, 48 / 48 | Retention = 1 + max lag / interval runs (9, or 5 for ECMWF) |
| | `fields.<id>` | all twelve (AIFS: no gust) | The catalog fields this model provides: for Herbie a `search` regex (with `{f}`/`{a}` for buckets); `min_fhr` |
| | `products.<id>` | `gfs`, `ecmwf`, `aifs` on `na025` | A product is the model on one display grid; its id names the manifest |

## Rendering notes

- **Projection:** d3-geo Lambert conformal conic, fit to the domain. Each canvas pixel is
  inverse-projected once per canvas size into a cached lookup (grid cell and bilinear weights). After
  that, a new frame only costs bilinear sampling and a color lookup table.
- **Shading:** continuous fields are sampled bilinearly. A pixel with a nodata corner (vorticity's
  outermost grid points) is transparent. Precipitation type is a category, so it is never
  interpolated: each pixel takes the nearest grid point's type (or the wettest neighbour's at the
  edge of a precipitation area).
- **Contours** (isotachs, the freezing and 0 °C lines, isobars, 500 mb heights): d3-contour runs
  on the native grid, and the contour vertices are projected. Contours use a lightly smoothed copy
  of the field (one 1-2-1 pass; three for isobars) to remove quantization staircases. Shading, readouts and stats use raw values.
- **Flow arrows and barbs:** both use the stored wind direction and the local direction of north on
  the conic projection (`screenBearing`), which tilts away from the central meridian. Barbs follow
  the Northern Hemisphere convention: pennant 50 kt, barb 10 kt, half barb 5 kt. The jet view draws
  barbs only at 40 kt and above.
- **Pressure centers:** strict local extrema of heavily smoothed sea-level pressure within a 4° window, with at
  least 3 hPa of prominence, away from the domain edge. Only the strongest of each kind nearby is
  kept.
- **Basemap:** Natural Earth 50m coastlines, borders, states/provinces and large lakes, plus US
  state polygons merged into region click targets, as a bundled 118 KB TopoJSON. Lines outside the
  data domain are faded.
- **Regions:** focusing a region refits the projection to its box and rebuilds the pixel lookup; the
  canvas keeps its size and the decoded frames are redrawn as they are, so nothing is fetched or
  decoded again. Barb spacing and label density are in screen pixels, so they adapt to the zoom.
  The region under the pointer comes from a planar point-in-polygon test on lon/lat.
- **Frame loading:** each field loads only what it needs. A trend loads only the shaded field
  for the older run. The two hours either side are preloaded, for both maps in compare mode.
- **Models:** every product's manifest is loaded at startup, so the model bar can show only the
  models that output the field. Switching keeps the field and the valid time: the new model's
  latest run at the matching hour, clamped (with a banner) when its range doesn't reach. Lags and
  the scrubber's range follow the product. A product whose manifest can't be loaded is left out
  of the bar ("data couldn't be loaded").
- **Compare:** the other model shows its newest run that reaches the valid time. The difference map
  reuses each view's trend scene, with the other model in the "older" slot and the readouts and
  captions naming the models.
- **URL:** the full view is in the URL (`?m=&r=&v=&mode=&var=&run=&lag=&t=&iso=&ov=&lim=&c=&cv=`;
  `t` is the valid time, YYYYMMDDHH). Old links still open: without `m` on GFS, without `v` on the
  jet trend, and a forecast hour `f` (before `t`) from the link's run; the URL is then rewritten
  with `t`. A shared link pins its run, and offers the latest one if a newer run has arrived.
- **Keyboard:** <kbd>←</kbd>/<kbd>→</kbd> step 6 h, <kbd>1</kbd>–<kbd>8</kbd> pick a field,
  <kbd>Space</kbd> plays, <kbd>Home</kbd>/<kbd>End</kbd> jump to the first and last hour,
  <kbd>Esc</kbd> zooms out a level (or closes a sheet).

## Tests

- **pytest** (`pipeline/tests`):
  - valid-time alignment for every lag, including year, month and leap-day boundaries
  - Δ sign convention
  - unit conversions (kt, °F, hPa, in) and wind direction
  - band encoding: rounding, clipping, scale/offset, wrapped directions, nodata, NaN refusal
  - precipitation-type classification (GFS fractions, ECMWF snow share and type overrides)
  - absolute vorticity (solid-body rotation, a meridional-wind case, a hand-computed grid, nodata
    edges), accumulation differences and water units
  - per-hour search strings (6-hour buckets; nothing before F006) and which messages each recipe
    reads at each hour (ECMWF's f−6 totals, f−3 type, `10fg`/`10fg3`)
  - both source adapters end to end on synthetic GRIB (ECMWF index parsing and byte ranges, Herbie
    with levels merged by cfgrib), and backoff on `503 SlowDown`
  - GRIB-attribute matching
  - domain cropping and row order
  - row-delta frames
  - the split config, products, and the manifest schema
  - cycle detection, retention, retry, fetching only missing fields, clearing the old layout, and
    no-op behavior
  - the R2 sync, against an in-memory S3 client (no test can reach the real bucket): the remote
    manifest deciding what to fetch, upload order (frames, manifest, prune), cache headers, and
    refusing to publish a manifest that lists a missing frame
- **vitest** (`web/tests`):
  - the shared alignment and Δ vectors
  - decoding the shared Python-encoded frame fixture
  - palettes and tick steps
  - barb geometry and local north
  - pressure centers (including plateaus and double maxima)
  - precipitation shading without interpolating type
  - every view in every mode and variable, built from synthetic fields, and the Fields sidebar list
  - URL state, including old links (no `m`, no `v`, Phase 1's `f`)
  - regions: the config, one hit area per state, point-in-region lookups, region-limited stats
- **Playwright** (`web/e2e`), against the production build and real pipeline output (in CI, the
  small dataset from `make e2e-data`):
  - zero console errors or failed requests
  - non-blank shading in every field and mode
  - the header format, and which frames are loaded and preloaded
  - every view for ECMWF and AIFS; switching models keeps the field and valid time; picking gusts
    on AIFS hides its chip and falls back to GFS with a banner
  - old links rewritten with a valid time
  - clicking a region and zooming out with <kbd>Esc</kbd>, with no frame requests or re-render
  - compare mode, side by side and as a difference
  - the unavailable states, the hover readout, pinned links, field switching, and the older-run
    overlay
  - a 375 px phone: no overflow, bottom sheets, the pinned scrubber, tap-to-focus (screenshot)
  - writes the screenshots in `docs/`

## Credits

Model data: NOAA Global Forecast System via the NOAA Open Data Dissemination program on AWS
(public domain). ECMWF IFS and AIFS open data © ECMWF, under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), via the Google Cloud mirror. Basemap: [Natural Earth](https://www.naturalearthdata.com/) (public domain).
GRIB access: [Herbie](https://herbie.readthedocs.io/) and
[cfgrib](https://github.com/ecmwf/cfgrib).
