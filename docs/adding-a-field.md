# Adding a data type

How the jet, temperature, wind, precipitation, 500 mb and 850 mb fields were
built, and how the GFS, ECMWF, AIFS, AIGFS and ensemble-mean products
(including the ECMWF ENS mean, averaged from members) were added, written as a recipe for the next field (CAPE, simulated reflectivity, …)
and the next model.
The conventions and gotchas below were learned the hard way, and most of them
are covered by a test.

## The recipe

1. **Find the exact GRIB messages.** Read the inventory for a recent cycle at
   F000, F006 and a long lead (say F120). GFS, GEFS and the NOMADS products
   have a wgrib2 `.idx`; ECMWF has an eccodes `.index` (one JSON object per
   message). For NOMADS, use `curl --http1.1` (see
   [NOMADS gotchas](#nomads-gotchas)):

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
     sources (GFS, GEFS) the `search` regex; for NOMADS sources (AIGFS,
     AIGEFS, HGEFS) the `search` regex and the `file` it's in (`sfc` or
     `pres`); for ECMWF open data an empty `{}` (messages are picked from the
     recipe). Add `min_fhr` if needed. A product gets only the fields its
     model lists, in catalog order.
3. **Tell the pipeline how to compute it** in
   `pipeline/src/wxtrend/catalog.py`:
   - add the GRIB variables to `GRIB_KEYS` as `(shortName, typeOfLevel, level)`;
   - add a recipe to each model's table in `RECIPES` (shared ones go in
     `UPPER_AND_SURFACE`): the `Need`s it reads and a function of
     `(inputs, grid)` that returns physical values for every band. A `Need`
     can read another step of the run (`Need("tp", -6)`, keyed `"tp@-6"`) or
     apply only at some hours (`when=`); only the ECMWF adapter supports
     offsets. A `Need` also has a `kind`: `fc` (the step's message, the
     default), `members` (the mean of every perturbed member's message) or
     `em` (the ensemble's own mean); only the ECMWF adapter reads the last
     two. Inputs that are codes, not quantities (ECMWF's `ptype`), go in
     `CATEGORICAL_VARS`, so a regridded product takes the nearest point's
     code instead of a weighted mean.

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
   `web/src/views/` and register it in `VIEWS` in `views/index.ts`. A new
   view (or a new variable of one) also needs an entry in `FIELD_ITEMS`
   there, which is the Fields sidebar: its label, group (Surface or Upper
   air), and the `noun`/`short` the model bar uses ("AIFS doesn't output
   gusts", "no gust output"). The fields a model must output are derived from
   what the view shades in each mode (for a Shading choice, only what every
   choice shades: 500 mb needs heights, not vorticity). An overlay whose
   field a model lacks isn't offered for it (`overlayFields`). See
   [frontend conventions](#frontend-conventions).
6. **Test it:**
   - `web/tests/views.test.ts` builds every view, in every mode and variable,
     from synthetic fields; add your field to the `bands()` helper there (with
     NaN where the pipeline writes nodata, as `vort500` has at its edges).
   - Add the field to the `TABS` list (GFS, by its sidebar label) and
     `VIEWS` (every other product) in `web/e2e/viewer.spec.ts`, which check
     real data, zero console errors, and non-blank shading, and write
     screenshots.
   - Models that don't output the field need nothing extra: the model bar
     hides their chip for it ("Not shown: AIFS (no gust output)"), and
     picking the field on one of them switches to another model with a
     banner. `test_catalog.py` and the manifest decide who has what.

## Adding a model

1. `config/models/<id>.json`:
   - `source.adapter`, and where its files are:
     - `herbie`: `herbie_model`, `herbie_product`, `priority` (the Herbie
       source, e.g. `aws`), optionally `herbie_member` (`avg` for the GEFS
       mean), and `index_url`;
     - `ecmwf_opendata`: `index_url`; for the ECMWF ensemble also
       `mean_index_urls` (the files holding ECMWF's own mean, keyed by the
       last step each covers) and `members` (how many perturbed members a
       mean must have);
     - `nomads`: `files`, one GRIB2 URL template per file of an hour
       (`{"sfc": ..., "pres": ...}`; each has an `.idx` beside it), and
       `requests_per_minute` (60, half NOMADS's limit).

     Templates use `{init:%Y%m%d}`, `{init:%H}`, `{fhr}` or `{fhr:03d}`. An
     hour is posted when its index (every file's index, for NOMADS) exists.
   - `"precip_type": false` if the model has no precipitation type (its
     recipe writes 5, "unspecified").
   - `about` when the name doesn't say what the fields are made of (the
     ECMWF ENS mean's members); it's shown under the view's explanation.
   - `max_connections` if the source throttles, `forecast_hours` with
     `model_max`, lags, fields and products. A product whose source isn't on
     its display grid's spacing sets `"regrid": true` (GEFS's 0.5° on
     `na025`); `regrid.py` builds and caches the weights.
   - Add the product to a group in `config/site.json`'s `model_bar` (Global,
     AI, Ensemble mean, later Regional); order within and across groups is
     the bar's order. The chip shows the model's `name` and appears for every
     field the model's manifest lists and every region its grid covers.
2. Recipes in `catalog.py` under the model id.
3. Measure posting times from the source's object timestamps (or NOMADS's
   directory listings, which are in UTC) before writing its workflow (see the
   comments in `.github/workflows/gfs.yml`). Put the latest one, in minutes
   after init, in the model file as `latency_minutes`: the scheduler Worker
   (`scheduler/`) starts the workflow once a cycle is that old, and the site
   marks a run late from it. Then copy `ecmwf.yml` as `<product>.yml` (the
   Worker dispatches that name) and set the cron (a backup to the Worker) and
   `concurrency: product-<id>`. A regridded product passes
   `regrid: true` to `product.yml` (the weights cache); a NOMADS product
   passes a `timeout_minutes` long enough for a full backfill at its paced
   rate.
4. Add it to the product loop in `web/e2e/viewer.spec.ts` and to the
   `Makefile`: `E2E_PRODUCTS` if its pinned cycle stays in the source's
   archive (AWS, Google Cloud), otherwise `E2E_FIXTURE_PRODUCTS` (NOMADS keeps
   days, not years). Fixture products come from a frozen bundle on a GitHub
   release: `make e2e-fixtures`, attach `e2e-fixtures.tar.gz` to a new
   `e2e-fixtures-<cycle>` release, and update the tag, runs and SHA-256 in
   the `Makefile`. `make e2e-data` refuses a bundle that no longer matches
   `config/` (a new field, a changed band), so adding a field to a fixture
   product means rebuilding it.

## GRIB and GFS gotchas

- **GFS has no snowfall field** (no `ASNOW` in the 0.25° files, nor any
  freezing-rain or sleet amount; checked 2026-10-13). It has `CSNOW` as a
  6-hour average (the share of the window it was snowing) and as an instant,
  `SNOD` and `WEASD` (instantaneous snow depth and its water), `CPOFP`, and
  the 6-hour `APCP`. Snowfall is derived as the average `CSNOW` × `APCP`
  (`fields.snowfall_from_flag`) and labelled as derived: the flag is weighted
  by time, not amount, so heavy rain then light snow counts some rain as snow.
- **GEFS's `geavg` averages the 30 perturbed members, not the control.** On
  2026-10-12 00Z the mean of `gep01`–`gep30`'s 6-h `APCP` matched `geavg`'s to
  its packing (0.05 mm at most, F006–F384); adding `gec00` made points differ
  by up to 4.4 mm. Anything averaged from GEFS members (snowfall) uses the
  same 30, so it agrees with the fields read from `geavg`. Each member's
  `pgrb2ap5` file has its own `APCP` and `CSNOW` (adjacent, so one range), and
  `geavg` also has `PRES:surface`, `PWAT` and temperatures at
  1000/925/850/700/500 mb (no 600).

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
  | `RH:2 m above ground` (GEFS) | `2r` | heightAboveGround | 2 | instant | % |
  | `APCP:surface:a-f hour acc` | `tp` | surface | — | accum | kg m⁻² (= mm) |
  | `CRAIN/CSNOW/CICEP/CFRZR:surface:a-f hour ave` | `crain`… | surface | — | avg | fraction 0–1 |

- **Averaged categorical fields are fractions.** The `… hour ave` versions of
  CRAIN, CSNOW, CICEP and CFRZR are the fraction of the window each type was
  diagnosed. That is the right input for a 6-hour total; the instantaneous
  0/1 flags describe only the valid time.
- **Use MSLET for isobars, not PRMSL, where there's a choice.** PRMSL's
  reduction to sea level is noisy over high terrain; with it the Rockies
  filled with tight contours and fake H/L centers. MSLET (NCEP's membrane
  reduction) is what operational surface charts use. GEFS's `pgrb2ap5` and
  the NOAA AI products publish only PRMSL, so they use it (labelled on the
  model card); the ensemble means and the AI models are smooth enough that
  it reads fine.
- **Ensemble-statistic messages carry a suffix.** In the AIGEFS/HGEFS
  `ensstat` files every `.idx` line ends `:ens mean` (or `:ens spread`), e.g.
  `:TMP:2 m above ground:6 hour fcst:ens mean`. Regexes that end at the level
  (`:TMP:2 m above ground:`) still match; don't anchor on the line's end.
- **GEFS's type flags are 6-hour averages, like GFS's.** At every 6-hourly
  step the member-mean CRAIN/CSNOW/CICEP/CFRZR are `a-f hour ave` (`6-12 hour
  ave`), so they already cover the whole 6-hour window; the 3-hourly steps in
  between (to F240) carry 3-hour windows. Don't add f−3 to them.
- **GEFS has no 2 m dew point.** `pgrb2ap5` has `RH:2 m above ground`, so
  dew point is derived from T and RH by the Magnus formula
  (`fields.dewpoint_magnus`). The NOAA AI products have neither, so they
  have no dew point at all.
- **GFS has no 2 m wind.** Surface wind is 10 m (`UGRD/VGRD:10 m above
  ground`). Winds on the 0.25° lat/lon grid are earth-relative, so speed and
  direction need no rotation.
- **Herbie reads throttling as "not found".** Its existence check is a plain
  HEAD with no retry, so an AWS `503 Slow Down` leaves `H.grib` empty, just
  like a missing file. The first GEFS backfill on a runner (2026-10-12) lost
  4 hours this way. A Herbie miss is therefore a retryable `UpstreamMissing`;
  only adapters that see the 404 itself (NOMADS, ECMWF) raise `NotPublished`,
  which isn't retried.
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

## NOMADS gotchas

AIGFS, AIGEFS and HGEFS come only from NOMADS (`nomads.ncep.noaa.gov`),
checked 2026-10-12. See the build plan's "NOAA AI and ensemble sources".

- **curl over HTTP/2 prints nothing.** NOMADS sends `content-length` with
  trailing spaces over HTTP/2, which curl rejects (`Invalid HTTP header field
  was received`), so the body looks empty. Use `curl --http1.1`. Python
  `requests` speaks only HTTP/1.1 and is fine.
- **It rate-limits by IP:** 120 requests a minute in NCEP's 2021 policy,
  summed over NOMADS and the NCEP FTP sites, and over-limit IPs get blocked.
  The `nomads` adapter paces each product to `requests_per_minute` (60) split
  across its workers, and reads a file in two requests: the `.idx`, then one
  multi-range GET for every needed message, which Apache answers as
  `multipart/byteranges`. A 200 there means the ranges were ignored (that's
  the whole ~80 MB file), so the adapter refuses it. When probing by hand,
  sleep between requests.
- **Completeness from listings, not HEADs.** A cycle's directory listing
  shows every file, so the completeness check reads one listing per cycle
  (`cycles.listing_exists_fn`) instead of a HEAD per hour and file. Listings
  are Apache-style HTML in **UTC**; file links are upper-case `<A HREF=...>`
  and long names are truncated in the text (`...grib2..&gt;`), so read the
  `HREF`.
- **Retention is short and varies:** AIGFS about 11 days; AIGEFS and HGEFS 2
  days (a little over: on 2026-10-12 at 14Z the Oct 10 runs were still
  there). A pinned e2e cycle would vanish, hence the frozen fixture bundle, and
  an outage longer than the retention loses those runs. The update checks each
  older run once and skips it if it's gone, doesn't retry a 404
  (`fetch.NotPublished`), and doesn't fail the job for either.
- **Two files per hour.** The NOAA AI products split each hour into `sfc`
  (10 m wind, 2 m T, PRMSL, APCP) and `pres` (13 pressure levels). Each field
  names its `file`. An hour counts as posted when both indexes are listed.
- **AIGFS lists F006's precipitation twice**, like GFS: the 6-hour bucket and
  the running total are both `0-6 hour acc`. The adapter keeps one of
  identical `.idx` lines. From F012 the bucket is `6-12 hour acc` and the
  total `0-12 hour acc`; `{a}-{f}` picks the bucket.
- **Same file names elsewhere aren't the same data.** `noaa-nws-graphcastgfs-pds`
  on AWS has `aigfs.YYYYMMDD/` folders that look like NOMADS's but hold a
  different configuration (more fields, different values, posted ~3 h later).
  Compare decoded values before trusting a mirror.

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

## ECMWF ensemble gotchas

The ECMWF ENS mean (`ecmwf-ens`, checked 2026-10-12 and 10-13 on the Google
Cloud mirror) is built from two kinds of file per run:

- **Members: `<init>-<step>h-enfo-ef.grib2`**, about 6.75 GB a step, holding
  the 50 perturbed members (`type` `pf`, `number` 1–50) of about 170
  parameters: 8,500 messages. **No control member is published.** A
  parameter's 50 messages are scattered through the file, so each is its own
  byte range (~0.7 MB). The adapter reads them on 16 connections per
  worker (`max_connections` 96 over 6 workers; it caps the product's
  requests in total, so IFS and AIFS keep 4) and sums them one message at a time with ecCodes
  (`fetch.read_member_means`): cfgrib would stack all 50 in memory first. An
  hour of the site's fields is about 300 MB of members, including the f−6
  totals for precipitation; locally that took about 3 s an hour on 6 workers.
- **ECMWF's mean: `-240h-enfo-ep` (steps 0–240) and `-360h-enfo-ep`
  (246–360).** Each holds every step it covers, and the spread (`es`) and
  probabilities (`ep`) beside the mean (`em`), so messages are picked by
  `type` and `step` too. The mean exists only for gh 1000/500/300, t
  850/500/250, ws 850/250 and msl: wind **speed** at 250 mb, no components,
  so the jet has no direction (the Options panel hides flow arrows and barbs
  for it). Both files post at the very end of the run, after the last member
  file, so an hour counts as posted only when its mean file is there too
  (`Model.index_urls_for`).
- **The members' mean isn't ECMWF's mean.** ECMWF's includes the control,
  so the two differ by (members' mean − control) / 51, which grows with lead
  time: MSLP differed by 0.01–0.15 hPa on average but up to 1.03 hPa at a
  point in a deep low (2026-10-12 00Z and 12Z, F000–F360). `wxtrend fetch`
  checks the average difference (`catalog.MEAN_CHECKS`, 0.3 hPa); a limit on
  the largest point would fail routinely.
- **Means are linear**, so the 6-h amount from member-mean running totals
  equals the mean of each member's 6-h amount, and the snow-share type rule
  applies to the mean totals directly. Winds are the speed and direction of
  the mean vector.
- **Posting:** member files land from T0+7:40 to 8:47, the mean files at
  8:45–8:55 (9 cycles, 2026-10-09 to 10-13).

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
  | 6-h snowfall (liquid) | uint16 | 0.001 in | 0 | 0–65 in | at 0.01 in, steps under 0.005 in round to 0: 2–10 % of all snow on 2026-10-12 00Z (most on the smooth GEFS mean). 0.001 in costs 2–3× the bytes (10–19 KB a frame against 5–9) |
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
- **Say "current"/"older" through `inputs.sides`.** Compare mode's
  difference map reuses each view's trend scene with the other model in the
  `old` slot, so readout labels and captions use `sides.cur`, `sides.old`
  and `sides.minus` ("Current"/"Older" and "… minus …" in trend mode, model
  names in compare mode) rather than hard-coded words.
- **Stats follow the region in focus.** Pass `inp` to `extreme(values, inp,
  sign)`: it searches the focused region's box (`inp.focus`), or the whole
  grid at North America. For a stat over some points only, pass a filter
  (`extreme(qpf, inp, 1, (k) => FROZEN_TYPES.has(...))` for "Max frozen")
  rather than looping over the grid yourself, which ignores the focus.
  Contours, centers and shading still cover the whole grid; focusing only
  refits the projection.
- **Variables: sidebar items or a Shading choice.** A view's `variables` are
  separate Fields sidebar items when `FIELD_ITEMS` lists one per variable
  (Temperature and Dew point). When it lists the view once (500 mb), they're
  a "Shading" choice in Options instead, and `main.ts` picks the per-model
  default (ensemble means open 500 mb on heights) until the viewer chooses.
- **A strict variable hides models without it.** A Shading choice normally
  follows the model (the ECMWF ENS mean falls back to 500 mb heights). Mark a
  variable `strict` (precipitation's Snow) and picking it works like picking
  a sidebar field: models without its field leave the model bar, with the
  note, and the current one is swapped for one that has it, with the banner.
  `requiredFields` and `missingNoun` (`web/src/views/index.ts`) say which
  fields and what to call them.
- **Totals over a window are summed in the browser.** A view with `sums`
  (precipitation: `qpf`, snowfall's `sf`) and `periods` offers 6 h, 24 h and
  Total. `planFrame` works out one window for everything drawn
  (`web/src/accum.ts`): it starts at the latest init among the runs shown
  (both runs of a trend, both models of a comparison, every presentation
  slot), so two runs or models are always summed over the same hours, never
  each over its own run. `loadFields` sums the window's 6-h frames for those
  fields (dropping bands that can't be summed, like type) and loads overlays
  at the valid time. The scene gets the window as `inputs.acc`; put it in
  memo keys, since the app's prefix names the frames' sources, not the window.
  A total can't be made past a missing 6-h amount, so for totals the scrubber
  (and presentation's) ends before the first gap among the runs summed
  (`totalsGap`): an hour that never posted, or the rest of a run still posting.
  A link past it steps back with a banner naming the missing hour.
- **Show the viewer's units; keep the stored ones.** Frames stay in their
  stored units (kt, °F at 2 m, °C at 850 mb, m). A view that shows a speed or
  temperature converts through `web/src/units.ts`: `speedQ(inputs.units)` or
  `tempQ(inputs.units, stored)` give `from` for values and `scale` for
  differences. Put colorbar ticks on round shown values with `ticksIn`, pass
  the quantity to `trend()` (it rounds the fixed limit in the shown unit and
  returns it as `shown` for `scaleNote`), and set `trendQ` on the view so the
  "±… " scale button matches. Contour levels that depend on the unit go in
  the memo key. Titles and `explain()` get the units too.
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
- **Type 5 is "unspecified", not a type.** Models with no type output
  (AIGFS, AIGEFS, HGEFS) mark every wet point 5 and set `"precip_type":
  false` in their model file (a pytest checks the flag against the recipe).
  The site keys off the flag, not the data, so a dry frame still gets the
  right legend: one neutral row with "type isn't available", readouts saying
  "not available", no "& type" in the title. Side by side with a typed model,
  the legend shows the types plus a grey row named for the untyped one. Test
  for frozen types with `FROZEN_TYPES` (2–4), never `ptype >= 2`.
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
- **Categorical palettes are measured, not eyeballed.** Precipitation type has
  6 bins per type (`QPF_BINS`), and `palettes.test.ts` checks every pair of
  colors from different types: CIELAB ΔE76 ≥ 15 with normal vision, ≥ 12 with
  deuteranopia simulated (Machado 2009), each type's lightest bin ≥ 20 off the
  dry color (`PRECIP_DRY`), and ≥ 10 between a type's neighbouring bins. Run it
  after any color change; warm tans and rain greens collide under
  deuteranopia, which is why sleet is a grey taupe.
- **Units in the UI.** Say what the number is and over what period, e.g. "6-h
  precipitation (in, liquid equivalent)", "6 h ending …". Hover readouts show
  the raw grid-point value. Say a thing once: if the legend explains it (type
  not available), the caption doesn't repeat it.
- **Late runs.** A chip turns amber by `web/src/freshness.ts`, the same rule the
  scheduler uses to dispatch (`scheduler/src/freshness.ts`): the next cycle's
  init plus the model's `latency_minutes`. Change one, change both.
