# Adding a data type

How the jet, temperature, wind, precipitation, 500 mb and 850 mb tabs were
built, written as a recipe for the next field (CAPE, simulated reflectivity, …)
and the next model.
The conventions and gotchas below were learned the hard way, and most of them
are covered by a test.

## The recipe

1. **Find the exact GRIB messages.** Read the inventory for a recent cycle at
   F000, F006 and a long lead (say F120). GFS has a wgrib2 `.idx`; ECMWF has
   an eccodes `.index` (one JSON object per message):

   ```bash
   curl -s https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261009/00/atmos/gfs.t00z.pgrb2.0p25.f120.idx | grep -n ':TMP:'
   curl -s https://storage.googleapis.com/ecmwf-open-data/20261009/00z/ifs/0p25/oper/20261009000000-120h-oper-fc.index | grep '"param": "2t"'
   ```

2. **Declare the field in two places:**
   - `config/fields.json`, the canonical catalog: a `label` and one entry per
     stored band (`dtype`, `scale`, `offset`, `units`, and optionally `wrap`,
     `categories` or `nodata`). Every model shares these. See
     [storage conventions](#storage-conventions) for picking an encoding.
   - each model's file (`config/models/<id>.json`) under `fields`: for Herbie
     sources (GFS) the `search` regex; for ECMWF open data an empty `{}`
     (messages are picked from the recipe). Add `min_fhr` if needed. A
     product gets only the fields its model lists, in catalog order.
3. **Tell the pipeline how to compute it** in
   `pipeline/src/wxtrend/catalog.py`:
   - add the GRIB variables to `GRIB_KEYS` as `(shortName, typeOfLevel, level)`;
   - add a recipe to each model's table in `RECIPES` (shared ones go in
     `UPPER_AND_SURFACE`): the `Need`s it reads and a function of
     `(inputs, grid)` that returns physical values for every band. A `Need`
     can read another step of the run (`Need("tp", -6)`, keyed `"tp@-6"`) or
     apply only at some hours (`when=`); only the ECMWF adapter supports
     offsets.

   `test_catalog.py` fails if a configured field has no recipe or misses a
   band.
4. **Dry-run one hour** and check the decoded ranges look physical:

   ```bash
   cd pipeline && uv run wxtrend --data-dir /tmp/dry fetch --product gfs --cycle latest --hours 0,6,120 --fields yourfield
   ```

   Check the hours where the model changes output step too (ECMWF: F090,
   F096, F144, F150), and the last hour.

   Then run `uv run wxtrend update --product <id>` for each model that has
   it. Existing runs pick up the new field
   automatically, because the update fetches only the fields missing for each
   (run, hour). Nothing else is re-downloaded.
5. **Show it.** Either add an overlay to an existing view, or add a view in
   `web/src/views/` and register it in `views/index.ts`. See
   [frontend conventions](#frontend-conventions).
6. **Test it:**
   - `web/tests/views.test.ts` builds every view, in every mode and variable,
     from synthetic fields; add your field to the `bands()` helper there (with
     NaN where the pipeline writes nodata, as `vort500` has at its edges).
   - Add the tab to the `TABS` list (GFS) and `VIEWS` (every other product)
     in `web/e2e/viewer.spec.ts`, which check real data, zero console
     errors, and non-blank shading, and write screenshots.
   - If a view's variable needs a field some model lacks, give the variable
     its `field` (`VariableDef`): the site hides it for that model and falls
     back with a banner, as AIFS does for gusts.

## Adding a model

1. `config/models/<id>.json`: `source.adapter` (`herbie` or
   `ecmwf_opendata`), `source.index_url` (a template with `{init:%Y%m%d}`,
   `{init:%H}`, `{fhr}` or `{fhr:03d}`; an index existing means the hour is
   posted), `max_connections` if the source throttles, `forecast_hours` with
   `model_max`, lags, fields and products. Add the product to
   `config/site.json`'s `products` (model-bar order).
2. Recipes in `catalog.py` under the model id.
3. Measure posting times from the source's object timestamps before writing
   its workflow (see the comments in `.github/workflows/gfs.yml`), then copy
   `ecmwf.yml` and set the cron and `concurrency: product-<id>`.
4. Add it to `E2E_PRODUCTS` in the `Makefile` and to the product loop in
   `web/e2e/viewer.spec.ts`. Its pinned cycle must stay in the source's
   archive.

## GRIB and GFS gotchas

- **Anchor the level in the regex.** Herbie matches the search regex against
  inventory strings like `:TMP:2 m above ground:120 hour fcst:`. A loose regex
  matches more than you meant: `:TMP:2 m above ground:` is correct, but
  `:TMP:2 ` also matches `:TMP:2 mb:` (stratosphere). Always include the level
  text and the trailing colon.
- **Use `{f}` and `{a}` for accumulations.** Search strings are Python format
  templates: `{f}` is the forecast hour and `{a}` is `f − 6`.
  `:APCP:surface:{a}-{f} hour acc` picks the 6-hour bucket. At every 6-hourly
  step GFS has a 6-hour bucket, alongside a running total (`0-5 day acc`).
  GFS posts hourly to F120 and 3-hourly from there to F384; the hours between
  multiples of 6 carry shorter buckets (1–5 hours, or 3), so stick to
  multiples of 6. Escape literal braces as `{{ }}`;
  config validation catches template errors.
- **F000 has no accumulations or averages**, only analysis (`anl`) messages.
  Set `"min_fhr": 6`. The manifest then lists no F000 for the field, and the UI
  says "starts at F006" instead of showing an error.
- **F006's precipitation message appears twice.** At F006 the 6-hour bucket and
  the running total are both `0-6 hour acc`. The regex matches both; cfgrib
  merges them, and `read_grib_vars` keeps the first match of any duplicate.
- **Identify variables by GRIB attributes, not cfgrib names.** cfgrib's
  variable names (`t2m`, `u10`, `tp`) depend on its heuristics. `GRIB_KEYS`
  matches `GRIB_shortName`, `GRIB_typeOfLevel`, and the level coordinate.
  Observed mappings:

  | idx string | shortName | typeOfLevel | level | stepType | raw units |
  |---|---|---|---|---|---|
  | `UGRD:250 mb` / `VGRD:250 mb` | `u` / `v` | isobaricInhPa | 250 | instant | m s⁻¹ |
  | `UGRD:500 mb` / `VGRD:500 mb` | `u` / `v` | isobaricInhPa | 500 | instant | m s⁻¹ |
  | `HGT:500 mb` | `gh` | isobaricInhPa | 500 | instant | gpm |
  | `TMP:850 mb` | `t` | isobaricInhPa | 850 | instant | K |
  | `TMP:2 m above ground` | `2t` | heightAboveGround | 2 | instant | K |
  | `DPT:2 m above ground` | `2d` | heightAboveGround | 2 | instant | K |
  | `UGRD:10 m above ground` / `VGRD` | `10u` / `10v` | heightAboveGround | 10 | instant | m s⁻¹ |
  | `GUST:surface` | `gust` | surface | — | instant | m s⁻¹ |
  | `MSLET:mean sea level` | `mslet` | meanSea | — | instant | Pa |
  | `PRMSL:mean sea level` | `prmsl` | meanSea | — | instant | Pa |
  | `APCP:surface:a-f hour acc` | `tp` | surface | — | accum | kg m⁻² (= mm) |
  | `CRAIN/CSNOW/CICEP/CFRZR:surface:a-f hour ave` | `crain`… | surface | — | avg | fraction 0–1 |

- **Averaged categorical fields are fractions.** The `… hour ave` versions of
  CRAIN, CSNOW, CICEP and CFRZR are the fraction of the window each type was
  diagnosed. That is the right input for a 6-hour total; the instantaneous
  0/1 flags describe only the valid time.
- **Use MSLET for isobars, not PRMSL.** PRMSL's reduction to sea level is noisy
  over high terrain; with it the Rockies filled with tight contours and fake
  H/L centers. MSLET (NCEP's membrane reduction) is what operational surface
  charts use.
- **GFS has no 2 m wind.** Surface wind is 10 m (`UGRD/VGRD:10 m above
  ground`). Winds on the 0.25° lat/lon grid are earth-relative, so speed and
  direction need no rotation.
- **Hours post out of order.** Mid-cycle on AWS, F108 was missing while
  F114–F144 had already posted. "Complete" therefore means every needed hour's
  `.idx` exists, not just the last hour's.
- **Plan download size and time.** All twelve GFS fields together take about
  9 MB of byte ranges per hour, in one download per hour. A full 9-run
  backfill at full range (585 hours, 7,011 frames) took 13.5 minutes locally
  with 6 worker processes (2026-10-11); decoding is the bottleneck, which is
  why the update uses processes rather than threads. For comparison, ECMWF's
  5-run window (305 hours) took 4.8 minutes and AIFS's 9 runs (549 hours)
  8.5 minutes, at 4 workers each.
- **Keep ecCodes out of the pytest process.** On the Linux CI runner, tests
  that decoded GRIB in-process made the interpreter abort at exit
  (`munmap_chunk(): invalid pointer`, exit 134) after all of them had passed;
  macOS was fine. The pipeline decodes in worker processes, and so do the
  tests: run anything that builds or decodes GRIB, or imports Herbie, through
  `in_worker()` in `tests/test_fetch.py`. `conftest.py` fails the session if
  `eccodes`, `cfgrib` or `herbie` ends up imported in the test process.
- **cfgrib merges levels.** Two messages with the same shortName at
  different levels (u at 250 and 500 mb) come out as one variable with a
  level dimension. `read_grib_vars` splits it, so each level matches its own
  `GRIB_KEYS` entry.
- **Water amounts come in different units.** GFS and AIFS give `tp`/`sf` in
  kg m⁻² (mm); IFS gives `tp` in m and `sf` in "m of water equivalent".
  `read_grib_vars` converts by each message's `GRIB_units` and refuses units
  it doesn't know, so recipes always see mm.

## ECMWF open data gotchas

- **Fetch from Google Cloud, not AWS.** The AWS bucket `ecmwf-forecasts`
  returned `503 SlowDown` on about half of all requests even at one
  connection (2026-10-11); the GCS mirror `ecmwf-open-data` serves the same
  bytes unthrottled. See the build plan's "ECMWF open-data source". The
  session still backs off on 429/5xx, and the products cap at 4 connections.
- **The index is eccodes-style:** one JSON object per message (`param`,
  `levtype` `sfc`/`pl`, `levelist`, `_offset`, `_length`). `param` equals
  the GRIB shortName. The adapter merges ranges less than 1 MB apart (a
  throttled source prefers fewer requests) and keeps only the wanted
  messages' bytes.
- **Accumulations run from T0.** `tp` and `sf` at f are totals since the
  init, so the 6-hour amount reads the f−6 file too (`Need("tp", -6)`).
  Step 0 has them (all zero). Clip negative differences: packing noise.
- **The output step changes:** IFS is hourly to F090, 3-hourly to F144, then
  6-hourly; AIFS is 6-hourly. Anything "since the previous output" changes
  window with it:
  - Gust: `10fg` is the max in the last hour to F090; F093–F144 publish
    `10fg3` (last 3 h) instead; from F150, `10fg` again with a 6-hour window
    (stepRange `144-150`). Expect gusts to jump at F096 and F150. `10fg` is
    0 everywhere at F000, so gust has `min_fhr` 6.
  - Precipitation type: the instantaneous `ptype` at f−3 exists only to
    F144 (`when=` on the need).
- **ptype codes:** 1 rain, 3 freezing rain, 5 snow, 6 wet snow, 7 rain and
  snow, 8 ice pellets, 12 freezing drizzle; 0 none. IFS type is snow when
  Δsf/Δtp ≥ 0.5, else rain, overridden by freezing rain (3, 12) then sleet
  (8) if `ptype` at f or f−3 says so.
- **Heights:** both IFS and AIFS publish `gh` (gpm), so no geopotential
  conversion. AIFS has no gust and no `ptype`.
- **Coordinates:** 90 to −90, −180 to 179.75; `crop_to_domain` handles it.

## Storage conventions

- **Split fields by how the viewer loads them.** In trend mode the older run
  only needs the shaded variable, so speed and direction are separate fields
  (`wspd250`, `wdir250`), as are temperature and dew point. This keeps the jet
  trend at about 37 KB per frame, even though direction exists. Group bands in
  one field only when they are always used together (precipitation amount and
  type).
- **Pick the encoding from the physical range.** Store the smallest integer
  type that holds the range at a resolution finer than anyone will read:

  | Field | dtype | scale | offset | Range | Why |
  |---|---|---|---|---|---|
  | wind speeds | uint8 | 1 kt | 0 | 0–255 kt | 1 kt is finer than the 10 kt isotach interval |
  | temperature, dew point | uint8 | 1 °F | −80 | −80 to 175 °F | covers polar winters and desert summers |
  | directions | uint8 | 360/256 | 0 | wraps | 1.4°; `wrap: 360` stores modulo instead of clipping |
  | MSLET | uint16 | 0.1 hPa | 0 | 0–6553 hPa | exact; isobars need sub-hPa |
  | 6-h precipitation | uint16 | 0.01 in | 0 | 0–655 in | the first bin is 0.01 in |
  | precipitation type | uint8 | 1 | 0 | codes | `categories` lists the labels |
  | 500 mb height | uint16 | 1 m | 0 | 0–65535 m | exact to the metre |
  | 500 mb absolute vorticity | uint8 | 10⁻⁵ s⁻¹ | −50 | −50 to 204, nodata 255 | edges have no centred difference |
  | 850 mb temperature | uint8 | 0.5 °C | −60 | −60 to 67.5 °C | finer than 1 °F, as 850 mb charts read in °C |

  Values are rounded to the nearest step. Anything outside the range is
  clipped, except wrapped bands. NaN is refused unless the band declares
  `nodata`.
- **Missing data (frame format v3).** A band may declare `"nodata"`, which
  must be the dtype's top value (255 or 65535). NaN is stored as that value
  and decodes to NaN; valid values are clipped one step lower. It's for grids
  the model doesn't fill (regional products) and for derived fields with
  points that can't be computed (`vort500`'s edge rows and columns). Other
  global fields don't need it.
  A wrapped band can only have it if its codes leave the top value free:
  360/256° directions use all 256, so config validation rejects `nodata`
  there.
- **Row-delta before gzip.** Each row stores the first sample, then
  differences mod 2^bits, which cut gzip output by about 21% overall (MSLET 32%,
  directions 30%). It is lossless, and decoding is a running sum.
- **Measured size per hour** (F120, gzipped):

  | Field | Size |
  |---|---|
  | wspd250 | 37 KB |
  | wdir250 | 41 KB |
  | t2m | 28 KB |
  | d2m | 30 KB |
  | wspd10 | 34 KB |
  | wdir10 | 65 KB |
  | gust | 34 KB |
  | mslp | 46 KB |
  | precip | 34 KB |

  That's about 350 KB per hour, and was about 160 MB for the 9-run window
  when GFS stopped at F288. 10 m directions are the most expensive because
  they're noisy near calm areas.

  The upper-air fields (GFS, 2026-10-11): hgt500 34 KB, vort500 47 KB, t850
  26 KB. With them a GFS hour is 466 KB, an ECMWF hour 466 KB and an AIFS
  hour 299 KB (AIFS fields are smoother, so they compress better). The full
  windows measured 267 MB (GFS), 140 MB (ECMWF) and 161 MB (AIFS).
- **Vorticity clips at both ends, rarely.** `vort500` is computed on the
  display grid from 500 mb u/v (`fields.absolute_vorticity`, flux form on the
  sphere), so it's the same for every model. Its 1st–99th percentiles are
  about −4 to 33, but a tropical cyclone core reaches the 204 ceiling at a
  few points, and steep terrain (the Alaska Range, where 500 mb is close to
  the ground) produces a few values at −50. Edge rows and columns are
  nodata; the renderer draws any pixel with a nodata corner transparent.
- **Never change an existing field's encoding; give it a new id.** The store
  keeps no encoding version per file, and R2 serves frames as immutable for a
  year (`Cache-Control: immutable`), so browsers and the CDN would keep the old
  bytes. If you change `scale`, `offset`, `dtype` or `nodata`, add the field
  under a new id (`t850v2`) and drop the old one: the update fetches the new id
  for every retained run, and the old frames age out with their runs. Locally
  you can still delete a field's files (`rm -rf data/gfs/runs/*/<field>`) and
  run `update` while experimenting.
- **The cross-language contract.** `shared/test-vectors/frames.json` holds
  frames encoded by Python; vitest decodes the same bytes. If you change the
  frame format, regenerate it with `uv run python -m tests.test_contract`, and
  both test suites must pass.

## Frontend conventions

- **A view is data plus a scene builder** (`web/src/views/types.ts`):
  - `fields(mode, variable, overlays)` says what to load. Without `primary`
    there is no frame. `current` lists everything the current run needs.
    `older` is usually just `[primary]` in trend mode.
  - `scene(inputs)` returns the raster, overlay layers, colorbar, stats, and
    hover rows. It must also cope with `inputs.old[primary] == null`: the
    comparison is unavailable, but the current run's overlays should still draw.
  - Use `inputs.memo(key, make)` for anything expensive (contours, extrema).
    The app prefixes keys with the product, the view, and both runs and
    hours, so a key never leaks across frames. Products share run ids
    (`2026100900` exists for GFS, ECMWF and AIFS), which is why the product
    is in the prefix.
- **Pick a trend quantity that's signal, not noise.** Run-to-run differences
  of a noisy field (vorticity) are mostly noise, so the 500 mb trend shades
  Δ height and keeps vorticity for forecast mode.
- **Nodata draws transparent.** A bilinear sample with a NaN corner is NaN,
  and `shadeScalar` leaves that pixel transparent. `extreme()` skips NaN, and
  readouts should use `fmtNum`, which prints "—" for it.
- **Never interpolate categories.** Continuous bands are sampled bilinearly.
  Categorical bands (precipitation type) take the nearest grid point. At the
  edge of a precipitation area, use the wettest of the four surrounding points
  that has a category, or the area gets a fringe of the wrong type.
- **Smooth before contouring, not before shading.** Quantized fields draw
  stair-stepped contours, so contour a copy smoothed with `smoothForContours`
  (one pass for 1 kt or 1 °F data; three for MSLP isobars; eight for H/L
  detection). Shading, readouts and stats use raw values.
- **d3-contour's coordinate quirks.** Grid point (i, j) is at contour
  coordinate (i + 0.5, j + 0.5), and every ring is closed along the grid's
  outer edge. `contourLines` handles both; reuse it.
- **Directions on a conic map need local north.** "Up" is north only on the
  central meridian, so project a short step along the bearing with
  `screenBearing(proj, lon, lat, deg)`. Barbs, flow arrows, and anything
  directional should go through it.
- **Pressure centers.** `findExtrema` wants a heavily smoothed field. A center
  must be strictly beyond all 8 neighbours (plateaus never count), stand out
  by a minimum prominence, and sit away from the domain edge. Only the strongest
  center of each kind within 2 × the radius is kept.
- **Palettes.** Continuous palettes are value stops (`stopsColor`), so a
  meaningful threshold can be a sharp step, like the blue→green jump at 32 °F.
  Trend palettes are symmetric: RdBu reversed for "more is red" quantities,
  BrBG for precipitation. `tickStep` always divides the limit, so ticks land
  on 0 and both ends.
- **Units in the UI.** Say what the number is and over what period, e.g. "6-h
  precipitation (in, liquid equivalent)", "6 h ending …". Hover readouts show
  the raw grid-point value.
