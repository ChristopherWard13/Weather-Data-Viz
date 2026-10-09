# 250 mb Wind Trend

An in-browser viewer for how the **GFS 250 mb wind speed forecast changes between model runs**,
in the spirit of the "trend" overlays on Tropical Tidbits but for jet-level wind instead of 500 mb
height.

![Viewer showing Δ|V| shading and isotachs over North America](docs/screenshot.png)

The shading is

> Δ|V| = |V|(current run) − |V|(older run), both valid at the same time

where |V| = √(u² + v²) × 1.94384 kt. **Red** means the current run is faster than the older run
for that valid time, and **blue** means it is slower. Black contours are the current run's isotachs.

Once GitHub Pages is set up (see [below](#github-pages-and-actions-setup)), the site is published at
**https://christopherward13.github.io/Weather-Data-Viz/**.

## How the comparison lines up

For a current run initialized at **T0** and viewed at forecast hour **f**, the valid time is
**T0 + f**. With lag **L**, the comparison frame is the run initialized at **T0 − L**, at forecast hour
**f + L**, which is valid at the same instant. For example, at the default 48 h lag:

| Current run | Hour | Valid | Compared with | Hour |
|---|---|---|---|---|
| 2026-10-08 18Z | F000 | 2026-10-08 18Z | 2026-10-06 18Z | F048 |
| 2026-10-08 18Z | F240 | 2026-10-18 18Z | 2026-10-06 18Z | F288 |

That second row is why every run is fetched out to **F288** (`fhr_max + max lag`) even though only
F000–F240 are displayed. If the older run or the needed hour isn't available, the map shows a
**"comparison unavailable"** state naming exactly what is missing. It never falls back to another
lag.

## Repository layout

```
config.json            every parameter (model, domain, hours, lags, isotachs, colorbar, projection)
pipeline/              Python pipeline (uv): Herbie + cfgrib → uint8 frames + manifest.json
  src/wxtrend/         alignment, fields, cycles, fetch, store, manifest, update, cli
  schema/              JSON Schema for manifest.json
  tests/               pytest
web/                   static frontend (Vite + TypeScript + d3)
  src/                 map rendering, controls, frame loading
  scripts/             one-off Natural Earth → TopoJSON basemap builder
  tests/               vitest unit tests
  e2e/                 Playwright tests against the production build and real data
shared/test-vectors/   alignment and Δ cases checked by BOTH pytest and vitest
.github/workflows/     update.yml (cron → pipeline → deploy), ci.yml (tests on push/PR)
data/                  pipeline output (git-ignored)
```

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

`make dev` processes the latest complete GFS cycle plus the older runs needed for the longest lag
(9 runs × 49 hours, about 1.2 MB downloaded per hour, roughly 1–2 minutes the first time). It then
serves the site at http://localhost:5173. Later runs only fetch what's new. `make dev QUICK=1`
fetches just the 5 runs the newest run is compared against. If the fetch fails (for example when
offline) but data already exists, the site is served anyway.

Other targets:

| Command | What it does |
|---|---|
| `make data` | Run the pipeline once (`wxtrend update`) |
| `make test` | pytest + vitest |
| `make e2e` | Build, serve, and run the Playwright tests against `data/` |
| `make build` | Build the static site with data into `web/dist/` |
| `make verify` | Validate `manifest.json` against the schema and check every frame's size |

### Pipeline CLI

```bash
cd pipeline
uv run wxtrend update                        # latest complete cycle + retention window; no-op if done
uv run wxtrend update --cycle 2026100818     # treat a specific cycle as latest
uv run wxtrend fetch --cycle latest --hours 0 --data-dir /tmp/dry   # one-hour dry run
uv run wxtrend verify                        # schema + frame sizes
uv run wxtrend inspect --fhr 120 --lag 48    # print the pair and Δ statistics for one frame
```

**Latest complete cycle:** `update` steps back from the current 6-hourly cycle. It sends HEAD
requests for the `.idx` file of every forecast hour it needs (F000–F288) on
`noaa-gfs-bdp-pds`, checking the last hour first. The first cycle with all of them published is
used.

**Fetching and retention:** if that cycle and its retention window are already on disk, the command
exits as a no-op. Otherwise it fetches the missing frames with about 8 parallel downloads and
retries. It then deletes runs outside the window and rewrites the manifest. Herbie downloads only
the `UGRD`/`VGRD` 250 mb messages using HTTP range requests from the `.idx` inventory. Decoding
goes through a lock because ecCodes isn't guaranteed to be thread-safe.

## GitHub Pages and Actions setup

Do these once in the repository on GitHub:

1. **Settings → Pages → Build and deployment → Source:** choose **GitHub Actions**.
2. **Settings → Actions → General:** make sure Actions are allowed. The workflows declare their own
   permissions, so the default read-only token setting is fine.
3. **Actions → "Update data and deploy" → Run workflow**, with **force_deploy** checked, for the
   first deploy. The first run has no cache, so it backfills all 9 runs (a few minutes).
4. That's it. The schedule then takes over.

What the workflow does (`.github/workflows/update.yml`):

- **Schedule:** it runs at `05:05, 11:05, 17:05, 23:05 UTC`, about T0 + 5:05 for the 00/06/12/18Z
  cycles. A retry runs at T0 + 5:50. On 2026-10-08, F240 reached AWS at about T0 + 4:40 and F288 at
  about T0 + 4:52, so a run at T0 + 4:30 would always find the cycle incomplete. The retry is a cheap
  no-op when the first run already succeeded. GitHub's cron often starts late, which only adds
  margin.
- **Persistence:** processed runs are kept between workflow runs with `actions/cache`. Each save
  gets a unique key (`gfs-data-<run_id>-<attempt>`) and the restore takes the newest one by prefix, so each
  cycle downloads only the new run. Correctness doesn't depend on the cache. If GitHub evicts it (7
  days unused, or the 10 GB repository limit), the pipeline simply backfills the missing runs from
  AWS. Data is never committed to git.
- **Build and deploy:** it builds `web/`, runs the Playwright smoke test against the new data, then
  copies `data/` into the site and deploys it with `actions/deploy-pages`. When nothing changed, it
  skips the cache save, build, and deploy.

Things to know:

- GitHub **disables scheduled workflows in public repositories after 60 days without repository
  activity**. If updates stop, re-enable the workflow from the Actions tab (or push any commit).
- To force a full refetch, delete the `gfs-data-*` entries under **Actions → Caches**.
- `ci.yml` runs pytest, vitest, and a production build on pushes to `main` and on pull requests.

## Data format

Everything the site reads lives under `data/` (served at `<site>/data/`).

### Frames: `runs/<YYYYMMDDHH>/f<FFF>.bin.gz`

- **Values:** one byte per grid point, wind speed in **knots**: `uint8`, rounded to the nearest kt
  and clipped to 0–255. There is no missing-value sentinel; the pipeline refuses to encode NaNs.
- **Layout:** `ny × nx` bytes, row-major. **Row 0 is the northern edge (70°N)** and rows go south;
  columns go west (170°W) to east (50°W).
- **Size:** for the default domain, 221 × 481 = **106,301 bytes** decompressed, about 50 KB gzipped.
- **Compression:** gzip (`.bin.gz`). The browser decompresses it with `DecompressionStream('gzip')`.
  If a server has already removed the gzip layer, the frontend detects the missing gzip magic bytes
  and uses the bytes as they are.

The value at row `j`, column `i` is at latitude `lat0 + j·dlat` and longitude `lon0 + i·dlon`. Grid
points are the native GFS 0.25° points; there is no regridding.

### `manifest.json`

The manifest is validated against `pipeline/schema/manifest.schema.json` and built from the files
actually on disk, so it never lists a frame that doesn't exist. Runs are listed newest first.

```json
{
  "schema_version": 1,
  "generated_at": "2026-10-09T03:47:24Z",
  "model": { "name": "gfs", "product": "pgrb2.0p25", "level": "250 mb", "field": "wind speed" },
  "encoding": { "dtype": "uint8", "units": "kt", "scale": 1.0, "offset": 0.0,
                "valid_min": 0, "valid_max": 255, "rounding": "nearest",
                "compression": "gzip", "layout": "row_major", "frame_bytes": 106301 },
  "grid": { "nx": 481, "ny": 221, "lon0": -170.0, "lat0": 70.0, "dlon": 0.25, "dlat": -0.25,
            "row_order": "north_to_south", "col_order": "west_to_east",
            "lat_min": 15.0, "lat_max": 70.0, "lon_min": -170.0, "lon_max": -50.0 },
  "path_template": "runs/{run}/f{fhr:03d}.bin.gz",
  "cycle_interval_hours": 6,
  "display_hours": [0, 6, 12, "…", 240],
  "latest": "2026100818",
  "runs": [
    { "id": "2026100818", "init": "2026-10-08T18:00:00Z", "hours": [0, 6, "…", 288], "complete": true }
  ]
}
```

`complete` is `false` when some hours failed to fetch. Those hours are retried on the next run.

Reading a frame in Python:

```python
import gzip, json, numpy as np
m = json.load(open("data/manifest.json"))
g = m["grid"]
raw = gzip.decompress(open("data/runs/2026100818/f120.bin.gz", "rb").read())
speed_kt = np.frombuffer(raw, np.uint8).reshape(g["ny"], g["nx"])  # row 0 = 70°N
```

## Configuration

All parameters live in `config.json`. The pipeline reads it, and Vite bundles it into the frontend.

| Key | Default | Notes |
|---|---|---|
| `model.*` | GFS `pgrb2.0p25` on AWS, `:(?:UGRD\|VGRD):250 mb:` | Herbie search regex selects the GRIB messages |
| `domain` | 15–70°N, 170–50°W at 0.25° | Must sit on the 0.25° grid |
| `forecast_hours` | 0–240 every 6 h | Displayed hours |
| `lags_hours` / `default_lag_hours` | 6, 12, 24, 48 / 48 | Retention = 1 + max lag / 6 runs (9) |
| `isotachs_kt` | 70–190 every 10, default [100] | |
| `colorbar` | ±60 kt fixed; auto rounds max\|Δ\| up to 10 kt | |
| `projection` | Lambert conformal, central meridian 110°W, parallels 30°/60° | |
| `pipeline` | lookback 8 cycles, 8 parallel downloads, 3 attempts | |

## Rendering notes

- **Projection:** d3-geo Lambert conformal conic, fit to the domain. Each canvas pixel is
  inverse-projected once per canvas size into a cached lookup (grid cell and bilinear weights). After
  that, a new frame only costs Δ, bilinear sampling, and a 256-entry RdBu-reversed color table.
  Stepping between preloaded hours takes tens of milliseconds.
- **Shading and lines:** shading is computed at CSS-pixel resolution, since the data are about
  25 km apart. Vector layers are drawn at device resolution.
- **Isotachs:** d3-contour runs on the native grid of the current run, and the contour vertices are
  projected. Frames are stored to the nearest knot, which makes contours staircase in flat areas.
  Before contouring, the field gets one 3×3 1-2-1 smoothing pass, finer than the GFS's effective
  resolution. Shading, the hover readout, and the stats use the raw values.
- **Basemap:** Natural Earth 50m coastlines, country borders, states/provinces, and large lakes.
  They're bundled as a 108 KB TopoJSON (`web/src/assets/basemap-50m.topo.json`), regenerated with
  `npm run basemap`. Lines outside the data domain are faded.
- **Hover readout:** shows the cursor's lat/lon and the nearest grid point's current |V|, older |V|,
  and Δ.
- **Preloading:** the two hours either side are preloaded for both runs.
- **URL:** the full view is kept in the URL (`?run=&lag=&f=&iso=&lim=`). A shared link pins its run.
  If a newer run has arrived since, the page offers to switch to it. If the linked run has been
  pruned, it falls back to the latest and says so.

## Tests

- **pytest** (`pipeline/tests`):
  - valid-time alignment for every lag, including year, month and leap-day boundaries
  - Δ sign convention, including uint8 wraparound
  - kt conversion and rounding/clipping
  - domain cropping and row order, for both latitude orders, both longitude conventions, and a
    domain across the prime meridian
  - manifest schema
  - cycle detection, retention, retry, and no-op behavior
- **vitest** (`web/tests`):
  - the same shared alignment and Δ vectors
  - colormap direction and symmetry
  - the gzip and already-decompressed paths
  - the frame cache
  - the isotach coordinate convention
  - the projection lookup's registration
  - URL state
- **Playwright** (`web/e2e`), against the production build and real pipeline output:
  - zero console errors or failed requests
  - non-blank red and blue shading on the canvas
  - the header format, the requested and preloaded frames, and the controls
  - the unavailable state, the hover readout, pinned links, and phone width
  - writes `docs/screenshot.png`

## Credits

Model data: NOAA Global Forecast System via the NOAA Open Data Dissemination program on AWS
(public domain). Basemap: [Natural Earth](https://www.naturalearthdata.com/) (public domain).
GRIB access: [Herbie](https://herbie.readthedocs.io/) and
[cfgrib](https://github.com/ecmwf/cfgrib).
