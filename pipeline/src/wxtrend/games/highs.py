"""Each model's own forecast of a day's high at a few cities (build plan G4, Beat the Models).

The site's frames are 6-hourly (00, 06, 12 and 18Z), so the afternoon peak
falls between them; a high taken from them comes in low. Five models publish
output that resolves a high (checked on the 2026-10-22 and 23 runs):

- GFS: hourly files to 120 h, each with ``TMAX``, the 2 m maximum since the last
  6-hourly reset (f013 covers 12-13 h, f017 12-17 h), and the hour's ``TMP``.
- The GEFS mean: 3-hourly files, ``TMAX`` the same way (f015: 12-15 h). It's
  the mean of the members' maxima, as NOAA publishes it.
- ECMWF IFS: ``mx2t3``, the maximum over the last 3 hours at every 3-hour step
  to 144 h, and ``2t``.
- ICON: hourly files to 78 h, ``tmax_2m`` since the last 6-hourly reset (f005:
  0-5 h; f007: 6-7 h), and ``t_2m``.
- GEM: hourly 2 m temperature and no maximum, so its high is the max of the hours.

AIFS, AIGFS, AIGEFS, HGEFS and the ECMWF ensemble mean output only every 6 hours
and sit out.

A day's high is the maximum of the longest windows that lie inside the day,
together with the temperatures at the hours no chosen window covers (a window
covers the hours after its start, up to its end). Nothing outside the day
counts: a window that straddles midnight is replaced by the hours on the day's
side of it. With 3-hourly output (ECMWF, the GEFS mean) up to two hours at
either end of the day have no message inside it, so a high that comes at
midnight, ahead of a cold front, can come in low.

Each model's value at a city is interpolated bilinearly on its own lat/lon grid
(GFS and ECMWF 0.25°, the GEFS mean 0.5°, GEM 0.15°), and barycentrically
between ICON's three nearest cells, then moved from the model's ground to the
airport's elevation at 6.5 °C a kilometre (``LAPSE_F_PER_M``), with the model's
own surface height from the same run. A grid cell around a valley airport
averages the mountains beside it: in the 2026-10-01 to 23 backtest, the four
models' highs at Bishop, CA came in 15 °F low before the adjustment and 6 °F
after, and the cities whose mean miss was 3 °F or more went from 76 of 328 to
31; GFS's typical miss went from 2.6 to 2.4 °F. These are the sources' numbers,
adjusted: they won't match the site's maps, which show the 6-hourly frames.
"""

from __future__ import annotations

import bz2
import json
import logging
import math
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from ..config import DEFAULT_CONFIG_DIR, load_config
from ..fetch import NotPublished, UpstreamMissing, icon_coords, select_idx_messages, select_messages
from ..net import retrying_session

log = logging.getLogger(__name__)

MODELS = ("gfs", "gefs", "ecmwf", "icon", "gdps")
WORKERS = 4  # downloads at once, per model
LAPSE_F_PER_M = 6.5e-3 * 9 / 5  # the standard atmosphere's 6.5 °C a kilometre, in °F a metre
G = 9.80665  # ECMWF's surface height is a geopotential
_DECODE_LOCK = threading.Lock()


@dataclass(frozen=True)
class Schedule:
    """Which messages a model's run publishes for the high, up to ``last`` hours."""
    step: int  # hours between files (or ECMWF's steps)
    last: int
    window: int | None  # the maximum's window: it resets every ``window`` hours (None: no maximum)
    running: bool  # True: each file's maximum runs from the last reset (GFS, GEFS, ICON); False: over the step


SCHEDULES = {
    "gfs": Schedule(step=1, last=120, window=6, running=True),
    "gefs": Schedule(step=3, last=240, window=6, running=True),
    "ecmwf": Schedule(step=3, last=144, window=3, running=False),
    "icon": Schedule(step=1, last=78, window=6, running=True),
    "gdps": Schedule(step=1, last=240, window=None, running=False),
}

# Per-file sources' other files (ICON's t2m is the model's own source.variables entry)
ICON_TMAX = "tmax_2m/icon_global_icosahedral_single-level_{init:%Y%m%d%H}_{fhr:03d}_TMAX_2M"
ICON_HEIGHT = "hsurf/icon_global_icosahedral_time-invariant_{init:%Y%m%d%H}_HSURF"
GEM_HEIGHT = "GeopotentialHeight_Sfc"


@dataclass(frozen=True)
class Piece:
    """One message: the maximum over (start, end], or with start == end the temperature at that hour.

    Hours are after the run's start; the message is in the file (or step) ``end``."""
    kind: str  # "max" or "inst"
    start: int
    end: int

    def covers(self, hour: int) -> bool:
        return self.kind == "max" and self.start < hour <= self.end


def pieces(schedule: Schedule, last: int | None = None) -> list[Piece]:
    """Every message a run of this schedule publishes for the high, to hour ``last``."""
    top = min(schedule.last, schedule.last if last is None else last)
    out = [Piece("inst", 0, 0)]
    for h in range(schedule.step, top + 1, schedule.step):
        out.append(Piece("inst", h, h))
        if schedule.window:
            start = schedule.window * ((h - 1) // schedule.window) if schedule.running else h - schedule.window
            out.append(Piece("max", start, h))
    return out


def choose(available: list[Piece], start: int, end: int) -> list[Piece]:
    """The messages whose maximum is a day's high: the longest windows inside [start, end]
    (hours after the run's start), and the temperatures at the hours inside it that no
    chosen window covers."""
    inside = [p for p in available if p.kind == "max" and start <= p.start and p.end <= end]
    longest = [p for p in inside
               if not any(q != p and q.start <= p.start and p.end <= q.end for q in inside)]
    hours = [p for p in available if p.kind == "inst" and start <= p.start <= end
             and not any(w.covers(p.start) for w in longest)]
    return sorted(longest + hours, key=lambda p: (p.end, p.kind))


@dataclass(frozen=True)
class Model:
    id: str
    name: str
    cycle_hours: int  # the runs the site carries: every 6 or 12 hours
    latency: timedelta  # from the run's start to when the site takes it as out

    def run_at(self, t: datetime) -> datetime:
        """The model's latest run out at ``t``: the newest start on the site's cycle whose
        start plus the config's latency is no later than ``t``."""
        newest = t - self.latency
        hour = newest.hour - newest.hour % self.cycle_hours
        return newest.replace(hour=hour, minute=0, second=0, microsecond=0)


def load_models(config_dir: Path | None = None) -> list[Model]:
    """The five models, in MODELS' order, with names, cycles and latencies from config/models/."""
    root = Path(config_dir or DEFAULT_CONFIG_DIR) / "models"
    out = []
    for mid in MODELS:
        m = json.loads((root / f"{mid}.json").read_text())
        out.append(Model(mid, m["name"], int(m["cycle_interval_hours"]), timedelta(minutes=int(m["latency_minutes"]))))
    return out


@dataclass(frozen=True)
class Place:
    """Where and when: a city's coordinates, its airport's elevation (metres), and its day's bounds (UTC)."""
    lat: float
    lon: float
    elev: float
    start: datetime
    end: datetime


@dataclass(frozen=True)
class High:
    """A model's high at a place (°F, at the place's elevation; unrounded), and the model's ground there (metres)."""
    value: float
    ground: float


def to_fahrenheit(values: np.ndarray, units: str) -> np.ndarray:
    if units == "K":
        return (values - 273.15) * 9 / 5 + 32
    if units in ("C", "degC", "deg C"):
        return values * 9 / 5 + 32
    raise ValueError(f"unexpected temperature units {units!r}")


def bilinear(values: np.ndarray, lats: np.ndarray, lons: np.ndarray, plat: np.ndarray, plon: np.ndarray) -> np.ndarray:
    """Values at points on a global regular lat/lon grid: ``lats`` and ``lons`` are its axes in the
    order its rows and columns run (either direction), longitudes evenly spaced around the globe."""
    ny, nx = values.shape
    dlat = lats[1] - lats[0]
    dlon = lons[1] - lons[0]
    if not math.isclose(abs(dlon) * nx, 360.0, abs_tol=1e-6):
        raise ValueError(f"expected a global grid, got {nx} longitudes {dlon}° apart")
    fi = (plat - lats[0]) / dlat
    i0 = np.clip(np.floor(fi).astype(int), 0, ny - 2)
    ty = fi - i0
    fj = ((plon - lons[0]) * np.sign(dlon)) % 360.0 / abs(dlon)
    j0 = np.floor(fj).astype(int) % nx
    tx = fj - np.floor(fj)
    j1 = (j0 + 1) % nx
    v00, v01 = values[i0, j0], values[i0, j1]
    v10, v11 = values[i0 + 1, j0], values[i0 + 1, j1]
    return (1 - ty) * ((1 - tx) * v00 + tx * v01) + ty * ((1 - tx) * v10 + tx * v11)


class Cells:
    """Barycentric weights from ICON's cells to some points: the triangle of cell centres around each."""

    def __init__(self, clat: np.ndarray, clon: np.ndarray, plat: np.ndarray, plon: np.ndarray, margin: float = 1.0):
        from scipy.spatial import Delaunay

        clon = (clon + 180.0) % 360.0 - 180.0
        near = ((clat >= plat.min() - margin) & (clat <= plat.max() + margin)
                & (clon >= plon.min() - margin) & (clon <= plon.max() + margin))
        self.sel = np.flatnonzero(near)
        tri = Delaunay(np.column_stack([clon[self.sel], clat[self.sel]]))
        targets = np.column_stack([(plon + 180.0) % 360.0 - 180.0, plat])
        simplex = tri.find_simplex(targets)
        if (simplex < 0).any():
            raise ValueError("a point is outside ICON's cells")
        T = tri.transform[simplex]
        b = np.einsum("nij,nj->ni", T[:, :2], targets - T[:, 2])
        self.weights = np.column_stack([b, 1.0 - b.sum(axis=1)])
        self.vertices = self.sel[tri.simplices[simplex]]

    def apply(self, values: np.ndarray) -> np.ndarray:
        return (values[self.vertices] * self.weights).sum(axis=1)


def to_metres(values: np.ndarray, units: str) -> np.ndarray:
    """A surface height in metres: GFS's, GEM's and ICON's already are; ECMWF's is a geopotential."""
    if units in ("m", "gpm"):
        return values
    if units in ("m**2 s**-2", "m2 s-2"):
        return values / G
    raise ValueError(f"unexpected height units {units!r}")


GROUND = Piece("ground", 0, 0)  # the model's surface height, read from the run's first file


def _decode(data: bytes, piece: Piece, init: datetime, tag: str):
    """(values, grid) of one message, checked to be the piece it should be: an instant at its hour
    or a maximum over its window (in °F), or the model's ground (in metres), from the run ``init``.
    ``grid`` is ("regular", lats, lons) or ("unstructured", uuidOfHGrid)."""
    import eccodes

    h = eccodes.codes_new_from_message(data)
    try:
        get = lambda k: eccodes.codes_get(h, k)  # noqa: E731
        eccodes.codes_set(h, "stepUnits", "h")
        if piece != GROUND:
            step_type = get("stepType")
            steps = (eccodes.codes_get(h, "startStep", int), eccodes.codes_get(h, "endStep", int))
            want = ("max", (piece.start, piece.end)) if piece.kind == "max" else ("instant", (piece.end, piece.end))
            if (step_type, steps) != want:
                raise ValueError(f"{tag}: {step_type} over {steps[0]}-{steps[1]} h, not {want[0]} over "
                                 f"{want[1][0]}-{want[1][1]} h")
            if get("typeOfLevel") != "heightAboveGround" or float(get("level")) != 2.0:
                raise ValueError(f"{tag}: at {get('typeOfLevel')} {get('level')}, not 2 m")
        else:
            # Geopotential (ECMWF), geopotential height (GFS, GEFS, GEM) or geometric height (ICON) of the surface
            got = (get("discipline"), get("parameterCategory"), get("parameterNumber"), get("typeOfFirstFixedSurface"))
            if got[:3] not in ((0, 3, 4), (0, 3, 5), (0, 3, 6)) or got[3] != "sfc":
                raise ValueError(f"{tag}: parameter {got[:3]} at {got[3]}, not the surface's height")
        # ICON's time-invariant files come from the run's 00 folder, with its date
        if piece != GROUND or eccodes.codes_get(h, "gridType") != "unstructured_grid":
            if (get("dataDate"), get("dataTime")) != (int(f"{init:%Y%m%d}"), int(f"{init:%H}00")):
                raise ValueError(f"{tag}: from the run {get('dataDate')} {get('dataTime'):04d}, not {init:%Y%m%d %H}00")
        values = eccodes.codes_get_values(h).astype(np.float64)
        if get("bitmapPresent"):
            values[values == get("missingValue")] = np.nan
        values = to_metres(values, get("units")) if piece == GROUND else to_fahrenheit(values, get("units"))
        if get("gridType") == "unstructured_grid":
            return values, ("unstructured", get("uuidOfHGrid"))
        if get("gridType") != "regular_ll" or get("iScansNegatively") or get("jPointsAreConsecutive"):
            raise ValueError(f"{tag}: expected a regular lat/lon grid in rows, got {get('gridType')}")
        ny, nx = get("Nj"), get("Ni")
        lats = np.linspace(get("latitudeOfFirstGridPointInDegrees"), get("latitudeOfLastGridPointInDegrees"), ny)
        lons = get("longitudeOfFirstGridPointInDegrees") + get("iDirectionIncrementInDegrees") * np.arange(nx)
        return values.reshape(ny, nx), ("regular", lats, lons)
    finally:
        eccodes.codes_release(h)


class Source:
    """Fetches one model's messages and interpolates them at points."""

    def __init__(self, model: Model, config_dir: Path | None = None, session=None):
        self.model = model
        self.schedule = SCHEDULES[model.id]
        self.product = load_config(config_dir).product(model.id)
        self.session = session or retrying_session(WORKERS)

    def _get_range(self, url: str, offset: int, length: int | None, tag: str) -> bytes:
        if length is None:  # the file's last message: to its end
            r = self.session.get(url, headers={"Range": f"bytes={offset}-"}, timeout=120)
        else:
            r = self.session.get(url, headers={"Range": f"bytes={offset}-{offset + length - 1}"}, timeout=120)
        if r.status_code == 404:
            raise NotPublished(f"{tag}: no file at {url}")
        r.raise_for_status()
        if r.status_code != 206 or (length is not None and len(r.content) != length):
            raise UpstreamMissing(f"{tag}: HTTP {r.status_code}, {len(r.content)} bytes for {length}")
        return r.content

    def _get_index(self, url: str, tag: str) -> str:
        r = self.session.get(url, timeout=60)
        if r.status_code == 404:
            raise NotPublished(f"{tag}: no index at {url}")
        r.raise_for_status()
        return r.text

    def _get_file(self, url: str, tag: str) -> bytes:
        r = self.session.get(url, timeout=180)
        if r.status_code == 404:
            raise NotPublished(f"{tag}: no file at {url}")
        r.raise_for_status()
        return bz2.decompress(r.content) if url.endswith(".bz2") else r.content

    def message(self, init: datetime, piece: Piece) -> bytes:
        """One piece's GRIB2 message."""
        model = self.product.model
        fhr = piece.end
        tag = f"{self.model.id} {init:%Y%m%d%H} f{fhr:03d} {piece.kind}"
        if self.model.id in ("gfs", "gefs"):
            idx_url = model.index_url_for(init, fhr)
            if piece == GROUND:
                search = ":HGT:surface:"
            elif piece.kind == "max":
                search = rf":TMAX:2 m above ground:{piece.start}-{piece.end} hour max fcst:"
            else:
                search = ":TMP:2 m above ground:" + ("anl:" if fhr == 0 else rf"{fhr} hour fcst:")
            spans = select_idx_messages(self._get_index(idx_url, tag), search)
            if len(spans) != 1:
                raise UpstreamMissing(f"{tag}: {len(spans)} messages match {search!r}")
            return self._get_range(idx_url.removesuffix(".idx"), *spans[0], tag)
        if self.model.id == "ecmwf":
            idx_url = model.index_url_for(init, fhr)
            param = {"max": "mx2t3", "inst": "2t", "ground": "z"}[piece.kind]
            found = select_messages(self._get_index(idx_url, tag), {param: (param, "sfc", None)})
            if param not in found:
                raise UpstreamMissing(f"{tag}: no {param} in {idx_url}")
            return self._get_range(idx_url.removesuffix(".index") + ".grib2", *found[param], tag)
        if self.model.id == "icon":
            if piece == GROUND:
                return self._icon_ground(init, tag)
            part = ICON_TMAX if piece.kind == "max" else dict(model.variables)["t2m"]
            return self._get_file(model.file_url.format(init=init, fhr=fhr, file=part.format(init=init, fhr=fhr)), tag)
        if piece.kind == "max":
            raise ValueError("GEM publishes no maximum temperature")
        if piece == GROUND:
            return self._get_file(model.file_url.format(init=init, fhr=0, file=GEM_HEIGHT), tag)
        return self._get_file(model.var_url_for("t2m", init, fhr), tag)

    def _icon_ground(self, init: datetime, tag: str) -> bytes:
        """ICON's surface height: a time-invariant file published only with the 00Z runs, whose folder
        DWD replaces daily; the run's own day's, the next's or the one before's (its grid is checked
        against the temperatures' when they're interpolated)."""
        for days in (0, 1, -1):
            run = init.replace(hour=0) + timedelta(days=days)
            url = self.product.model.file_url.format(init=run, fhr=0, file=ICON_HEIGHT.format(init=run))
            try:
                return self._get_file(url, tag)
            except NotPublished:
                continue
        raise UpstreamMissing(f"{tag}: no surface height file near the run")

    def values(self, init: datetime, wanted: list[Piece], plat: np.ndarray, plon: np.ndarray) -> dict[Piece, np.ndarray]:
        """Each piece's values (°F, or metres for the ground) at the points."""
        with ThreadPoolExecutor(WORKERS) as pool:
            data = dict(zip(wanted, pool.map(lambda p: self.message(init, p), wanted)))
        out: dict[Piece, np.ndarray] = {}
        cells: dict[str, Cells] = {}
        for p in wanted:
            with _DECODE_LOCK:
                values, grid = _decode(data.pop(p), p, init, f"{self.model.id} {init:%Y%m%d%H} f{p.end:03d} {p.kind}")
            if grid[0] == "regular":
                out[p] = bilinear(values, grid[1], grid[2], plat, plon)
                continue
            uuid = grid[1]
            if cells and uuid not in cells:
                raise UpstreamMissing(f"{self.model.id} {init:%Y%m%d%H}: {p.kind} f{p.end:03d} is on grid {uuid}, "
                                      f"the run's other fields on {next(iter(cells))}")
            if uuid not in cells:
                clat, clon = icon_coords(self.product, init, uuid, self.session)
                cells[uuid] = Cells(clat, clon, plat, plon)
            out[p] = cells[uuid].apply(values)
        return out

    def highs(self, init: datetime, places: list[Place]) -> list[High | None]:
        """Each place's high in the run ``init``, moved to the place's elevation; None where a value
        is missing (NaN)."""
        spans = []
        for pl in places:
            start = (pl.start - init) / timedelta(hours=1)
            end = (pl.end - init) / timedelta(hours=1)
            if start != int(start) or end != int(end) or start < 0:
                raise ValueError(f"{self.model.id} {init:%Y%m%d%H}: a day of {pl.start}-{pl.end} doesn't start "
                                 "on a whole hour after the run")
            if end > self.schedule.last:
                raise ValueError(f"{self.model.id} {init:%Y%m%d%H}: the day ends at {end:g} h, past its {self.schedule.last} h")
            spans.append((int(start), int(end)))
        available = pieces(self.schedule, max(e for _, e in spans))
        chosen = [choose(available, s, e) for s, e in spans]
        wanted = sorted({p for c in chosen for p in c}, key=lambda p: (p.end, p.kind)) + [GROUND]
        plat = np.array([pl.lat for pl in places])
        plon = np.array([pl.lon for pl in places])
        got = self.values(init, wanted, plat, plon)
        out: list[High | None] = []
        for k, (pl, c) in enumerate(zip(places, chosen)):
            vals = [float(got[p][k]) for p in c]
            ground = float(got[GROUND][k])
            if any(math.isnan(v) for v in vals) or math.isnan(ground):
                out.append(None)
                continue
            out.append(High(max(vals) + LAPSE_F_PER_M * (ground - pl.elev), round(ground)))
        log.info("%s %s: highs at %d places from %d messages", self.model.id, f"{init:%Y%m%d%H}", len(places), len(wanted))
        return out
