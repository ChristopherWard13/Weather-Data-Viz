"""The weather map under each round's reveal: the day as GFS analysed it.

Each round's reveal shades the model's picture of the day under the stations'
dots, so a player sees the pattern that made the answer: the ridge, the cold
front, the band of rain. The pictures come from GFS's 6-hourly analyses (f000)
and its first 6 hours of precipitation, combined over the day:

- hottest: the warmer of the 18Z and 00Z 2 m temperatures (afternoon and evening)
- coldest: the colder of the 06Z and 12Z ones (night and early morning)
- gust and dew point: the highest of the day's four analyses
- rain and melted snow: four runs' first 6 hours added up, 06Z to 06Z
- warm-up and cool-down: the hottest map minus the day before's

They're fetched from NOAA with the gfs product's own adapter, not read from
the site's bucket: GFS runs leave the bucket after 48 hours, and a puzzle may
be remade later. Each map is a 0.5° grid over the Lower 48's box, one byte a
point (about 9 KB in base64), so a puzzle stays whole however old it gets.
"""

from __future__ import annotations

import base64
import logging
import tempfile
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Callable

import numpy as np

from ..config import Product, load_config

log = logging.getLogger(__name__)

STEP = 0.5  # degrees
NODATA = 255

# (init, fhr, field ids) -> field id -> band -> values on the product's display grid
Fetch = Callable[[datetime, int, list[str]], dict[str, dict[str, np.ndarray]]]


@dataclass(frozen=True)
class Recipe:
    field: str
    band: str
    hours: tuple[int, ...]  # valid times, hours after the day's 00Z
    how: str  # "max", "min", "sum" (6-hour amounts ending 6 h after each hour) or "change"
    label: str
    scale: float  # stored byte = (value - offset) / scale
    offset: float
    # The model maps' view of the same thing: view, variable, the hour of the run, the hour shown, period
    link: tuple[str, str, int, int, str | None]


_HOT = (18, 24)
RECIPES = {
    "hottest": Recipe("t2m", "temp", _HOT, "max", "GFS analysis: the warmer of 18Z and 00Z", 1, -60,
                      ("t2m", "temp", 24, 24, None)),
    "coldest": Recipe("t2m", "temp", (6, 12), "min", "GFS analysis: the colder of 06Z and 12Z", 1, -60,
                      ("t2m", "temp", 12, 12, None)),
    "gust": Recipe("gust", "gust", (6, 12, 18, 24), "max", "GFS analysis: the highest gust of 06Z, 12Z, 18Z and 00Z",
                   0.5, 0, ("wind10", "gust", 18, 18, None)),
    "muggiest": Recipe("d2m", "dewpt", (6, 12, 18, 24), "max", "GFS analysis: the highest dew point of 06Z, 12Z, 18Z and 00Z",
                       1, -60, ("t2m", "dewpt", 18, 18, None)),
    "wettest": Recipe("precip", "qpf", (6, 12, 18, 24), "sum", "GFS: four runs' first 6 hours added up, 06Z to 06Z",
                      0.05, 0, ("precip", "all", 6, 30, "24h")),  # up to 12.7 in
    "warmup": Recipe("t2m", "temp", _HOT, "change", "GFS analysis: the warmer of 18Z and 00Z, minus the day before's",
                     0.5, -60, ("t2m", "temp", 24, 24, None)),
}
RECIPES["cooldown"] = RECIPES["warmup"]


def needs(recipe: Recipe) -> list[tuple[int, int]]:
    """(hour of the run, forecast hour) pairs the recipe reads."""
    if recipe.how == "sum":
        return [(h, 6) for h in recipe.hours]
    if recipe.how == "change":
        return [(h, 0) for h in recipe.hours] + [(h - 24, 0) for h in recipe.hours]
    return [(h, 0) for h in recipe.hours]


def combine(recipe: Recipe, frames: dict[tuple[int, int], np.ndarray]) -> np.ndarray:
    """The day's map from the frames ``needs`` lists, keyed the same way."""
    def stack(keys):
        return np.stack([frames[k] for k in keys])

    with np.errstate(invalid="ignore"):
        if recipe.how == "max":
            return np.nanmax(stack(needs(recipe)), axis=0)
        if recipe.how == "min":
            return np.nanmin(stack(needs(recipe)), axis=0)
        if recipe.how == "sum":
            return stack(needs(recipe)).sum(axis=0)
        today = np.nanmax(stack([(h, 0) for h in recipe.hours]), axis=0)
        before = np.nanmax(stack([(h - 24, 0) for h in recipe.hours]), axis=0)
        return today - before


def map_grid(area: dict) -> dict:
    """The maps' grid over the area's box: rows north to south, as the site's display grids."""
    (s, n), (w, e) = area["lat"], area["lon"]
    return {"lat0": n, "lon0": w, "dlat": -STEP, "dlon": STEP,
            "ny": round((n - s) / STEP) + 1, "nx": round((e - w) / STEP) + 1}


def subsample(values: np.ndarray, product: Product, grid: dict) -> np.ndarray:
    """The display grid's points on the maps' coarser grid."""
    g = product.grid
    step = round(STEP / g.resolution)
    r0 = round((g.lat_max - grid["lat0"]) / g.resolution)
    c0 = round((grid["lon0"] - g.lon_min) / g.resolution)
    out = values[r0:r0 + step * grid["ny"]:step, c0:c0 + step * grid["nx"]:step]
    if out.shape != (grid["ny"], grid["nx"]):
        raise ValueError(f"the {g.id} grid doesn't cover the maps' box")
    return out


def encode(values: np.ndarray, recipe: Recipe) -> str:
    q = np.round((values - recipe.offset) / recipe.scale)
    q = np.where(np.isnan(q), NODATA, np.clip(q, 0, NODATA - 1)).astype(np.uint8)
    return base64.b64encode(q.tobytes()).decode()


def decode(data: str, scale: float, offset: float, shape: tuple[int, int]) -> np.ndarray:
    q = np.frombuffer(base64.b64decode(data), dtype=np.uint8).reshape(shape).astype(float)
    return np.where(q == NODATA, np.nan, q * scale + offset)


def run_id(t: datetime) -> str:
    return t.strftime("%Y%m%d%H")


def make_maps(day: date, kinds: list[str], area: dict, product: Product, fetch: Fetch) -> dict[str, dict]:
    """A map for each kind of round, by kind. A kind whose frames can't be fetched gets none
    (its reveal shows the stations alone); the puzzle doesn't wait for it."""
    midnight = datetime.combine(day, time(0), tzinfo=timezone.utc)
    grid = map_grid(area)
    wanted: dict[tuple[int, int], set[str]] = {}
    for kind in kinds:
        r = RECIPES[kind]
        for key in needs(r):
            wanted.setdefault(key, set()).add(r.field)
    frames: dict[tuple[int, int, str], np.ndarray] = {}
    for (h, fhr), fields in sorted(wanted.items()):
        init = midnight + timedelta(hours=h)
        try:
            got = fetch(init, fhr, sorted(fields))
        except Exception as e:  # noqa: BLE001 (a missing map mustn't stop the puzzle)
            log.warning("GFS %s f%03d: %s; rounds that need it get no map", run_id(init), fhr, e)
            continue
        for fid in fields:
            for band, values in got[fid].items():
                frames[(h, fhr, f"{fid}.{band}")] = subsample(values, product, grid)
    out = {}
    for kind in kinds:
        r = RECIPES[kind]
        keys = needs(r)
        if not all((h, fhr, f"{r.field}.{r.band}") in frames for h, fhr in keys):
            continue
        values = combine(r, {(h, fhr): frames[(h, fhr, f"{r.field}.{r.band}")] for h, fhr in keys})
        view, var, run_h, shown_h, period = r.link
        out[kind] = {
            "label": r.label,
            "grid": grid,
            "scale": r.scale,
            "offset": r.offset,
            "nodata": NODATA,
            "data": encode(values, r),
            "link": {"m": product.id, "v": view, "var": var,
                     "run": run_id(midnight + timedelta(hours=run_h)),
                     "t": run_id(midnight + timedelta(hours=shown_h)),
                     **({"acc": period} if period else {})},
        }
    log.info("maps for %s of %d rounds", ", ".join(out) or "none", len(kinds))
    return out


def gfs_fetch(config_dir: Path | None = None) -> tuple[Product, Fetch]:
    """The gfs product and a fetch through its adapter (Herbie, from NOAA's AWS bucket)."""
    from ..fetch import fetch_hour

    product = load_config(config_dir).product("gfs")

    def fetch(init: datetime, fhr: int, field_ids: list[str]):
        with tempfile.TemporaryDirectory(prefix="wxtrend-game-") as work:
            return fetch_hour(product, init, fhr, field_ids, Path(work))

    return product, fetch
