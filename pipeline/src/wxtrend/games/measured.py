"""Modeled or Measured (build plan G2): two maps of one moment of yesterday; pick the measured one.

Each round shows the same field at the same time twice over the Lower 48: once
as measured (``obsgrid.py``: NOAA's URMA, or MRMS for rain) and once as GFS
forecast it 3 to 5 days earlier. Which side is which is random, fixed per day.

- **Rounds:** early-morning temperature (12Z), afternoon temperature, dew point
  and gusts (21Z), and rain over 24 hours from 06Z to 06Z (about the day,
  in local time). On a dry day (under ``MIN_WET_SHARE`` of the land measured a
  tenth of an inch) the rain round becomes early-morning dew point.
- **Same footprint:** both maps show only Lower 48 land where the measured map
  has a value, so a coastline or a radar gap can't tell them apart.
- **Same detail:** the measured map is averaged onto the site's 0.25° grid and
  smoothed to about GFS's fine detail (``obsgrid.SMOOTH_CELLS``).
- **The lead:** of the 00Z and 12Z GFS runs 3 to 5 days before the round's time,
  the one whose miss (RMS, against the measured map's spread) is the median.
  The closest forecast can be a coin flip on a quiet day; the worst is a giveaway.
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

from ..config import Product, load_config
from . import maps, obsgrid
from .land import StateOutlines

log = logging.getLogger(__name__)

GAME = "measured"
VERSION = 1
EPOCH = date(2026, 10, 22)  # puzzle #1
STEP = 0.25  # degrees: the site's display grid

MODEL = "gfs"
MODEL_NAME = "GFS"
LEADS_H = (72, 120)  # the forecast's lead, from 3 to 5 days
RUN_HOURS = (0, 12)  # the runs it may come from
MIN_WET_SHARE = 0.03  # of land with a tenth of an inch or more, or the rain round is swapped
WET_IN = 0.1
MIN_CELLS = 2000  # a round's maps share at least this many cells (the Lower 48 has about 13,300)


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
    Kind("dewpoint", "d2m", 21, "Afternoon dew point", "°F", 0, 1, -60, 3),
    Kind("gust", "gust", 21, "Afternoon wind gusts", "kt", 0, 0.5, 0, 3),
    Kind("rain", "rain", 30, "24-hour rain", "in", 2, 0.02, 0, 0.1),  # up to 5.08 in on the 0.25° grid
    Kind("morningdew", "d2m", 12, "Early-morning dew point", "°F", 0, 1, -60, 3),
]}
PLAN = ["morning", "afternoon", "dewpoint", "gust", "rain"]
SPARE = "morningdew"  # instead of a dry rain round, or one whose data is missing

MEASURED_LABEL = {
    "rain": "Measured: NOAA's MRMS, radar rainfall corrected to rain gauges",
    "default": "Measured: NOAA's URMA, station observations analysed onto a 2.5 km grid",
}
CREDIT = [
    {"text": "URMA, NOAA/NCEP", "url": "https://registry.opendata.aws/noaa-rtma/"},
    {"text": "MRMS, NOAA/NSSL", "url": "https://registry.opendata.aws/noaa-mrms-pds/"},
    {"text": "GFS, NOAA/NCEP", "url": "https://registry.opendata.aws/noaa-gfs-bdp-pds/"},
]

# (field, valid) -> the measured field on the game's grid, unsmoothed (rain: the 24 hours ending then)
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


def miss(model: np.ndarray, measured: np.ndarray, mask: np.ndarray, kind: Kind) -> dict:
    """How far the forecast was off where both maps show: RMS against the measured spread, and the bias."""
    d = model[mask] - measured[mask]
    spread = max(float(np.std(measured[mask])), kind.spread_floor)
    return {"score": round(float(np.sqrt(np.mean(d * d))) / spread, 3),
            "rms": round(float(np.sqrt(np.mean(d * d))), 2),
            "bias": round(float(np.mean(d)), 2)}


def build_round(kind: Kind, day: date, grid: dict, land: np.ndarray, measure: Measure, forecast: Forecast,
                rng: random.Random) -> dict | None:
    """One round, or None if the rain round is dry or its data is missing."""
    valid = datetime.combine(day, time(0), tzinfo=timezone.utc) + timedelta(hours=kind.hour)
    try:
        measured = obsgrid.smooth(measure(kind.field, valid), obsgrid.SMOOTH_CELLS[kind.field])
    except Exception as e:  # noqa: BLE001 (a spare round stands in)
        log.warning("%s: no measured %s at %s: %s", kind.id, kind.field, valid, e)
        return None
    base = land & ~np.isnan(measured)
    if kind.field == "rain" and np.mean(measured[base] >= WET_IN) < MIN_WET_SHARE:
        log.info("rain: only %.1f%% of land had %.1f in; using %s", 100 * np.mean(measured[base] >= WET_IN), WET_IN, SPARE)
        return None
    tries = []
    for init in candidate_runs(valid):
        try:
            model = forecast_field(kind, init, valid, forecast)
        except Exception as e:  # noqa: BLE001 (another run will do)
            log.warning("%s: GFS %s for %s: %s", kind.id, maps.run_id(init), valid, e)
            continue
        mask = base & ~np.isnan(model)
        if mask.sum() >= MIN_CELLS:
            tries.append((miss(model, measured, mask, kind), init, model, mask))
    if not tries:
        log.warning("%s: no GFS run 3 to 5 days ahead of %s", kind.id, valid)
        return None
    tries.sort(key=lambda t: t[0]["score"])
    how, init, model, mask = tries[len(tries) // 2]
    answer = rng.randrange(2)  # which map is the measured one
    pair = [np.where(mask, measured, np.nan), np.where(mask, model, np.nan)]
    if answer:
        pair.reverse()
    log.info("%s: GFS %s (%d h ahead) of %d runs, miss %.2f of the spread, bias %+.2f %s",
             kind.id, maps.run_id(init), round((valid - init).total_seconds() / 3600), len(tries),
             how["score"], how["bias"], kind.unit)
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
        "model": {"id": MODEL, "name": MODEL_NAME, "run": maps.run_id(init),
                  "lead": round((valid - init).total_seconds() / 3600)},
        "miss": how,
    }


def build_puzzle(day: date, area: dict, measure: Measure, forecast: Forecast, outlines: StateOutlines,
                 made: datetime | None = None) -> dict:
    grid = game_grid(area)
    lats, lons = obsgrid.grid_axes(grid)
    land = outlines.land_mask(lats, lons)
    rng = random.Random(f"{GAME}:{day.isoformat()}")
    rounds = []
    for kind_id in PLAN:
        r = build_round(KINDS[kind_id], day, grid, land, measure, forecast, rng)
        if r is None and kind_id != SPARE and not any(x["kind"] == SPARE for x in rounds):
            r = build_round(KINDS[SPARE], day, grid, land, measure, forecast, rng)
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
