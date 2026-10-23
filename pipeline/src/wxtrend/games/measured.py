"""Modeled or Measured (build plan G2): two maps of one moment of yesterday; pick the measured one.

Each round shows the same field at the same time twice over the Lower 48: once
as measured (``obsgrid.py``: NOAA's URMA, or MRMS for rain) and once as GFS
forecast it 3 to 5 days earlier. Which side is which is random, fixed per day.

- **Rounds:** early-morning temperature (12Z), midday dew point (18Z),
  afternoon temperature and gusts (21Z), and rain over 24 hours from 06Z to 06Z
  (about the day, in local time). On a dry day (under ``MIN_WET_SHARE`` of the
  land measured a tenth of an inch) the rain round becomes overnight dew point
  (06Z). No dew point shares an hour with a temperature: a dew point can't top
  the temperature at its hour, so a revealed temperature map would give away
  which dew point map is the forecast (or the other way round).
- **Same footprint:** both maps show only Lower 48 land where the measured map
  has a value, so a coastline or a radar gap can't tell them apart.
- **Same detail:** both maps get the same light blur (``SHARED_BLUR``), which
  takes out GFS's grid-scale speckle, and the measured map, sharper still, a
  little more (``EXTRA_BLUR``), chosen each round so its texture matches the
  forecast's (``texture``). Measured on 2026-10-15 to 21 (build plan G2).
- **Same average:** GFS's temperatures and dew points differ from URMA's by a
  steady few degrees (−3 to −4 °F in the afternoon dew point, +1 to +4.5 °F in
  the early-morning temperature on the days checked, already in GFS's own
  analysis), so "the cooler one at dawn" would win without any weather. The
  forecast map is shifted by its mean miss over land (``shift``; rain isn't), and
  the reveal says by how much.
- **The lead:** of the 00Z and 12Z GFS runs 3 to 5 days before the round's time,
  the one whose miss, once shifted (RMS against the measured map's spread), is
  the median: the closest can be a coin flip on a quiet day, the worst a giveaway.

Data that's missing (a 404, a variable not in a file) swaps in the spare or
drops a run; any other error stops the run, so the workflow's backup run can
make the day whole rather than leave a lesser puzzle published.
"""

from __future__ import annotations

import logging
import random
import tempfile
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Callable

import numpy as np
from scipy.ndimage import gaussian_filter

from ..config import Product, load_config
from ..fetch import UpstreamMissing
from . import maps, obsgrid
from .land import StateOutlines

log = logging.getLogger(__name__)

GAME = "measured"
VERSION = 1
EPOCH = date(2026, 10, 21)  # puzzle #1
STEP = 0.25  # degrees: the site's display grid

MODEL = "gfs"
MODEL_NAME = "GFS"
LEADS_H = (72, 120)  # the forecast's lead, from 3 to 5 days
RUN_HOURS = (0, 12)  # the runs it may come from
MIN_WET_SHARE = 0.03  # of land with a tenth of an inch or more, or the rain round is swapped
WET_IN = 0.1
MIN_CELLS = 2000  # a round's maps share at least this many cells (the Lower 48 has about 13,300)

# Blur, in 0.25° cells. Measured on the review's rounds (Oct 15, 19, 20 and 21):
# with the same blur on both, the measured map stays grainier (median ratio of
# cell-to-cell texture at 0.75: dew point 1.30, rain 1.38, early-morning
# temperature 1.23, afternoon 1.04, gust 1.08), so it gets the extra that
# matches each round.
SHARED_BLUR = 0.75
EXTRA_BLUR = tuple(k / 8 for k in range(17))  # 0 to 2

MISSING = (FileNotFoundError, KeyError, UpstreamMissing)


@dataclass(frozen=True)
class Kind:
    id: str
    field: str  # obsgrid's name: t2m, d2m, gust or rain
    hour: int  # the valid time, hours after the day's 00Z (rain: the 24 hours' end)
    title: str
    unit: str
    decimals: int
    scale: float  # stored byte = (value - offset) / scale
    offset: float
    spread_floor: float  # the least spread a miss is measured against


KINDS = {k.id: k for k in [
    Kind("morning", "t2m", 12, "Early-morning temperature", "°F", 0, 1, -60, 3),
    Kind("afternoon", "t2m", 21, "Afternoon temperature", "°F", 0, 1, -60, 3),
    Kind("dewpoint", "d2m", 18, "Midday dew point", "°F", 0, 1, -60, 3),
    Kind("gust", "gust", 21, "Afternoon wind gusts", "kt", 0, 0.5, 0, 3),
    Kind("rain", "rain", 30, "24-hour rain", "in", 2, 0.05, 0, 0.1),  # up to 12.7 in
    Kind("nightdew", "d2m", 6, "Overnight dew point", "°F", 0, 1, -60, 3),
]}
PLAN = ["morning", "afternoon", "dewpoint", "gust", "rain"]
SPARE = "nightdew"  # instead of a dry rain round, or one whose data is missing

MEASURED_LABEL = {
    "rain": "Measured: NOAA's MRMS, radar rainfall corrected to rain gauges",
    "default": "Measured: NOAA's URMA, station observations analysed onto a 2.5 km grid",
}
CREDIT = [
    {"text": "URMA, NOAA/NCEP", "url": "https://registry.opendata.aws/noaa-rtma/"},
    {"text": "MRMS, NOAA/NSSL", "url": "https://registry.opendata.aws/noaa-mrms-pds/"},
    {"text": "GFS, NOAA/NCEP", "url": "https://registry.opendata.aws/noaa-gfs-bdp-pds/"},
]

# (field, valid) -> the measured field on the game's grid, unblurred (rain: the 24 hours ending then)
Measure = Callable[[str, datetime], np.ndarray]
# (field id, init, fhr) -> the forecast field on the game's grid (precip: its 6-hour amount)
Forecast = Callable[[str, datetime, int], np.ndarray]


def game_grid(area: dict) -> dict:
    """The area's box on the site's 0.25° spacing, rows north to south."""
    (s, n), (w, e) = area["lat"], area["lon"]
    return {"lat0": n, "lon0": w, "dlat": -STEP, "dlon": STEP,
            "ny": round((n - s) / STEP) + 1, "nx": round((e - w) / STEP) + 1}


def candidate_runs(valid: datetime) -> list[datetime]:
    """The runs that forecast ``valid`` from LEADS_H[0] to LEADS_H[1] hours ahead, oldest first."""
    latest = valid - timedelta(hours=LEADS_H[0])
    t = latest.replace(minute=0, second=0, microsecond=0)
    out = []
    while valid - t <= timedelta(hours=LEADS_H[1]):
        if t.hour in RUN_HOURS and valid - t >= timedelta(hours=LEADS_H[0]):
            out.append(t)
        t -= timedelta(hours=1)
    return sorted(out)


def forecast_field(kind: Kind, init: datetime, valid: datetime, forecast: Forecast) -> np.ndarray:
    lead = round((valid - init).total_seconds() / 3600)
    if kind.field == "rain":
        return sum(forecast("precip", init, lead - k) for k in (18, 12, 6, 0))
    return forecast(kind.field, init, lead)


def interior(land: np.ndarray) -> np.ndarray:
    """Land at least two cells from the coast and the border, where texture is measured."""
    return gaussian_filter(land.astype(float), 2) > 0.99


def texture(x: np.ndarray, inner: np.ndarray) -> tuple[float, float]:
    """How grainy a map is over ``inner``: the RMS of its 5-point Laplacian (cell to cell), and of
    what a 2-cell blur takes out of it (a little coarser)."""
    lap = np.full(x.shape, np.nan)
    lap[1:-1, 1:-1] = 4 * x[1:-1, 1:-1] - x[:-2, 1:-1] - x[2:, 1:-1] - x[1:-1, :-2] - x[1:-1, 2:]
    filled = np.where(np.isnan(x), np.nanmean(x), x)
    high = filled - gaussian_filter(filled, 2)
    ok = inner & ~np.isnan(lap)
    return float(np.sqrt(np.mean(lap[ok] ** 2))), float(np.sqrt(np.mean(high[ok] ** 2)))


def match_blur(measured: np.ndarray, model: np.ndarray, inner: np.ndarray) -> tuple[float, np.ndarray]:
    """The extra blur (one of EXTRA_BLUR) that brings the measured map's texture closest to the
    model's, on both of ``texture``'s scales, and the measured map with it."""
    want = texture(model, inner)
    best = None
    for sigma in EXTRA_BLUR:
        m = obsgrid.smooth(measured, sigma)
        got = texture(m, inner)
        off = max(abs(np.log(max(g, 1e-9) / max(w, 1e-9))) for g, w in zip(got, want))
        if best is None or off < best[0] - 1e-9:
            best = (off, sigma, m)
    return best[1], best[2]


def shift(kind: Kind, model: np.ndarray, measured: np.ndarray, mask: np.ndarray) -> float:
    """How much the forecast map is moved to share the measured mean over land (rain: not at all)."""
    if kind.field == "rain":
        return 0.0
    return float(np.mean(model[mask] - measured[mask]))


def miss(shown: np.ndarray, model: np.ndarray, measured: np.ndarray, mask: np.ndarray, kind: Kind) -> dict:
    """How far the forecast was off where both maps show: the shifted map's RMS against the measured
    spread (what the player sees), and the forecast's own RMS and mean, unshifted."""
    spread = max(float(np.std(measured[mask])), kind.spread_floor)
    seen = shown[mask] - measured[mask]
    raw = model[mask] - measured[mask]
    return {"score": round(float(np.sqrt(np.mean(seen * seen))) / spread, 3),
            "rms": round(float(np.sqrt(np.mean(raw * raw))), 2),
            "bias": round(float(np.mean(raw)), 2)}


def build_round(kind: Kind, day: date, land: np.ndarray, measure: Measure, forecast: Forecast,
                rng: random.Random) -> dict | None:
    """One round, or None if the rain round is dry or its data is missing."""
    valid = datetime.combine(day, time(0), tzinfo=timezone.utc) + timedelta(hours=kind.hour)
    try:
        raw = measure(kind.field, valid)
    except MISSING as e:
        log.warning("%s: no measured %s at %s: %s", kind.id, kind.field, valid, e)
        return None
    measured = obsgrid.smooth(raw, SHARED_BLUR)
    base = land & ~np.isnan(measured)
    if kind.field == "rain" and np.mean(measured[base] >= WET_IN) < MIN_WET_SHARE:
        log.info("rain: only %.1f%% of land had %.1f in; using %s", 100 * np.mean(measured[base] >= WET_IN), WET_IN, SPARE)
        return None
    inner = interior(land)
    tries = []
    for init in candidate_runs(valid):
        try:
            model = obsgrid.smooth(forecast_field(kind, init, valid, forecast), SHARED_BLUR)
        except MISSING as e:
            log.warning("%s: GFS %s for %s: %s", kind.id, maps.run_id(init), valid, e)
            continue
        mask = base & ~np.isnan(model)
        if mask.sum() < MIN_CELLS:
            continue
        extra, meas = match_blur(measured, model, inner & mask)
        moved = shift(kind, model, meas, mask)
        shown = model - moved
        if kind.field == "gust":
            shown = np.maximum(shown, 0.0)
        tries.append((miss(shown, model, meas, mask, kind), init, shown, meas, mask, moved, extra))
    if not tries:
        log.warning("%s: no GFS run 3 to 5 days ahead of %s", kind.id, valid)
        return None
    tries.sort(key=lambda t: t[0]["score"])
    how, init, shown, meas, mask, moved, extra = tries[len(tries) // 2]
    answer = rng.randrange(2)  # which map is the measured one
    pair = [np.where(mask, meas, np.nan), np.where(mask, shown, np.nan)]
    if answer:
        pair.reverse()
    lead = round((valid - init).total_seconds() / 3600)
    log.info("%s: GFS %s (%d h ahead) of %d runs, miss %.2f of the spread; map moved %+.2f %s; "
             "measured map's extra blur %.3g", kind.id, maps.run_id(init), lead, len(tries), how["score"], -moved,
             kind.unit, extra)
    return {
        "kind": kind.id,
        "title": kind.title,
        "field": kind.field,
        "unit": kind.unit,
        "decimals": kind.decimals,
        "valid": valid.strftime("%Y-%m-%dT%H:%MZ"),
        **({"from": (valid - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%MZ")} if kind.field == "rain" else {}),
        "scale": kind.scale,
        "offset": kind.offset,
        "nodata": maps.NODATA,
        "maps": [maps.encode(v, kind) for v in pair],
        "answer": answer,
        "measured": MEASURED_LABEL.get(kind.field, MEASURED_LABEL["default"]),
        "model": {"id": MODEL, "name": MODEL_NAME, "run": maps.run_id(init), "lead": lead},
        "miss": how,
        "shift": round(moved, 2),
        # sigma in cells: the forecast's, and the measured map's in all (blurs add in quadrature)
        "blur": {"model": SHARED_BLUR, "measured": round((SHARED_BLUR ** 2 + extra ** 2) ** 0.5, 3)},
    }


def build_puzzle(day: date, area: dict, measure: Measure, forecast: Forecast, outlines: StateOutlines,
                 made: datetime | None = None) -> dict:
    grid = game_grid(area)
    land = outlines.land_mask(*obsgrid.grid_axes(grid))
    rng = random.Random(f"{GAME}:{day.isoformat()}")
    rounds = []
    for kind_id in PLAN:
        r = build_round(KINDS[kind_id], day, land, measure, forecast, rng)
        if r is None and not any(x["kind"] == SPARE for x in rounds):
            r = build_round(KINDS[SPARE], day, land, measure, forecast, rng)
        if r is None:
            raise ValueError(f"{day}: no {kind_id} round (and no spare)")
        rounds.append(r)
    return {
        "v": VERSION,
        "game": GAME,
        "date": day.isoformat(),
        "number": (day - EPOCH).days + 1,
        "made": (made or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "credit": CREDIT,
        "area": {k: area[k] for k in ("id", "label", "lat", "lon")},
        "grid": grid,
        "rounds": rounds,
    }


def noaa_sources(grid: dict, config_dir: Path | None = None) -> tuple[Measure, Forecast]:
    """URMA and MRMS from NOAA's AWS buckets, and GFS through its own adapter (as G1's maps)."""
    from ..fetch import fetch_hour
    from ..net import retrying_session

    session = retrying_session()
    product: Product = load_config(config_dir).product(MODEL)
    bands = {"t2m": "temp", "d2m": "dewpt", "gust": "gust", "precip": "qpf"}

    def measure(field: str, valid: datetime) -> np.ndarray:
        if field == "rain":
            return obsgrid.mrms_rain_24h(valid, grid, session)
        return obsgrid.urma(valid, field, grid, session)

    def forecast(field: str, init: datetime, fhr: int) -> np.ndarray:
        with tempfile.TemporaryDirectory(prefix="wxtrend-game-") as work:
            values = fetch_hour(product, init, fhr, [field], Path(work))[field][bands[field]]
        return crop(values, product, grid)

    return measure, forecast


def crop(values: np.ndarray, product: Product, grid: dict) -> np.ndarray:
    """The game's box out of the product's display grid (the same 0.25° spacing)."""
    g = product.grid
    if abs(g.resolution - STEP) > 1e-9:
        raise ValueError(f"the {g.id} grid isn't {STEP}°")
    r0 = round((g.lat_max - grid["lat0"]) / g.resolution)
    c0 = round((grid["lon0"] - g.lon_min) / g.resolution)
    out = values[r0:r0 + grid["ny"], c0:c0 + grid["nx"]].astype(np.float64)
    if out.shape != (grid["ny"], grid["nx"]):
        raise ValueError(f"the {g.id} grid doesn't cover the game's box")
    return out
