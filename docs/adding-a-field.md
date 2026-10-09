# Adding a data type

How the jet, temperature, wind, and precipitation tabs were built, written as a
recipe for the next field (500 mb height, CAPE, simulated reflectivity, …).
The conventions and gotchas below were learned the hard way, and most of them
are covered by a test.

## The recipe

1. **Find the exact GRIB message strings.** Read the `.idx` inventory for a
   recent cycle at F000, F006 and a long lead (say F120):

   ```bash
   curl -s https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261009/00/atmos/gfs.t00z.pgrb2.0p25.f120.idx | grep -n ':TMP:'
   ```

2. **Declare the field in `config.json`** under `fields`: a `search` regex,
   `min_fhr`, and one entry per stored band (`dtype`, `scale`, `offset`,
   `units`, and optionally `wrap` or `categories`). See
   [storage conventions](#storage-conventions) for picking an encoding.
3. **Tell the pipeline how to compute it** in
   `pipeline/src/wxtrend/catalog.py`:
   - add the GRIB variables to `GRIB_KEYS` as `(shortName, typeOfLevel, level)`;
   - add a `COMPUTE` entry that returns physical values for every band.

   `test_catalog.py` fails if a configured field has no compute function or
   misses a band.
4. **Dry-run one hour** and check the decoded ranges look physical:

   ```bash
   cd pipeline && uv run wxtrend --data-dir /tmp/dry fetch --cycle latest --hours 0,6,120 --fields yourfield
   ```

   Then run `uv run wxtrend update`. Existing runs pick up the new field
   automatically, because the update fetches only the fields missing for each
   (run, hour). Nothing else is re-downloaded.
5. **Show it.** Either add an overlay to an existing view, or add a view in
   `web/src/views/` and register it in `views/index.ts`. See
   [frontend conventions](#frontend-conventions).
6. **Test it:**
   - `web/tests/views.test.ts` builds every view, in every mode and variable,
     from synthetic fields; add your field to the `bands()` helper there.
   - Add the tab to the `TABS` list in `web/e2e/viewer.spec.ts`, which checks
     real data, zero console errors, and non-blank shading, and writes a
     screenshot.

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
  Between F120 and F240 the output is 3-hourly, and odd 3-hour steps carry
  3-hour buckets, so stick to multiples of 6. Escape literal braces as `{{ }}`;
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
- **Plan download size and time.** All nine fields together take about
  6.5 MB of byte ranges per hour, in one download per hour. A full 9-run
  backfill (441 hours) took 7.5 minutes locally with 6 worker processes;
  decoding is the bottleneck, which is why the update uses processes rather
  than threads.

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

  Values are rounded to the nearest step. Anything outside the range is
  clipped, except wrapped bands. NaN is refused, because the format has no
  missing-value sentinel.
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

  That's about 350 KB per hour and about 160 MB for the 9-run window. 10 m
  directions are the most expensive because they're noisy near calm areas.
- **Changing an existing field's encoding needs a refetch.** The store keeps
  no encoding version per file. If you change `scale`, `offset` or `dtype`,
  delete that field's files (`rm -rf data/runs/*/<field>`) and run `update`.
  In CI, delete the `gfs-data-*` caches. Renaming a field is safer: the new id
  is fetched and the old directory is ignored.
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
    The app prefixes keys with the view and both runs and hours, so a key never
    leaks across frames.
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
