"""Wx Marks the Spot (build plan G1): five of yesterday's extremes; drop a pin where each happened.

The five rounds come from a daily draw of field families (``draft.py``), so
the fields change from day to day and Station ID can keep to the others.

The station rules were tested on 2026-10-01 to 20 (build plan G1):

- ASOS stations in the Lower 48, on the map's land (``land.py``): Gulf platforms
  sit in the Louisiana and Texas networks.
- No summits or passes. Mount Washington had the top gust on 13 of 20 days. An
  elevation cap would have dropped Denver and Albuquerque, so a station is out
  only when it stands far above its neighbours.
- Each value must be backed up by its neighbours within 150 km, compared with
  the second most extreme of them, so one other bad sensor can't vouch for it.
  That caught a 208 kt gust and 6.8 °F in Georgia in October, and kept a 99 kt
  hurricane gust whose neighbours had 80 and 71.

Every round covers the Lower 48. A pin scores twice (the page does the sums,
from ``SCORING``): up to 600 points for how extreme the weather was at the
station nearest it, and up to 400 for how close it is to the top spot. So a pin
anywhere in a broad heat wave earns most of the points, and finding the exact
spot earns the rest. Values are ranked as players see them (rounded), and
stations tied for the top all count as the top spot.
"""

from __future__ import annotations

import math
import random
import re
import statistics
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Callable

from . import draft
from .iem import CREDIT, LOWER_48, Station
from .land import StateOutlines

GAME = "spot"
VERSION = 3  # 3: rounds from the daily draw, and "swapped" on the round that replaced a dry rain round
EPOCH = date(2026, 10, 1)  # puzzle #1

LAND_SLACK_KM = 12  # keeps Galveston and Key West NAS; Gulf platforms are 18 km out and more
NEIGHBOUR_KM = 150
SUMMIT_KM = 75
SUMMIT_NAME = re.compile(r"\b(pass|peak|summit|mount|mountain|mtn|mt)\b", re.I)
SUMMIT_NAMED_M = 400  # above the median of its neighbours, with a summit's name
SUMMIT_ANY_M = 1200  # above them, whatever its name
MIN_PRECIP_IN = 0.10  # below this nationally, the wet round asks for the highest dew point
MIN_STATIONS = 50  # a round normally has 700 to 1,400

# How the page scores a pin (tuned on 2026-10-19 and 20: a random pin averages
# about 140 a round, one among the top 2% of stations about 750)
SCORING = {
    "value": 600,  # how extreme the weather was at the station nearest the pin
    "distance": 400,  # how close the pin is to the top spot
    "full_km": 25,  # full distance points this close
    "scale_km": 250,  # then exp(-(d - full_km) / scale_km)
    "reach_km": 150,  # no station this close to the pin: no value points
}


@dataclass(frozen=True)
class Kind:
    """One kind of round: how to read a station's value and how to check it against its neighbours.
    Values keep IEM's units (°F, inches, knots); the page converts them to the viewer's."""

    id: str
    title: str  # "Hottest high", for logs and the job summary; the page words its own prompts
    unit: str
    decimals: int
    sign: int  # +1: the highest value wins; -1: the lowest
    value: Callable[[dict, dict | None], float | None]  # (the day's summary, the day before's)
    plausible: Callable[[float, float], bool]  # (value, the second most extreme neighbour's)


def _temp(col: str) -> Callable[[dict, dict | None], float | None]:
    return lambda row, prev: None if row.get("tmpf_est") else row.get(col)


def _precip(row: dict, prev: dict | None) -> float | None:
    return None if row.get("precip_est") else row.get("precip")


def _change(row: dict, prev: dict | None) -> float | None:
    if prev is None or row.get("tmpf_est") or prev.get("tmpf_est"):
        return None
    a, b = row.get("max_tmpf"), prev.get("max_tmpf")
    return None if a is None or b is None else a - b


KINDS = {
    "hottest": Kind("hottest", "Hottest high", "°F", 0, 1, _temp("max_tmpf"), lambda v, ref: v - ref <= 12),
    "coldest": Kind("coldest", "Coldest low", "°F", 0, -1, _temp("min_tmpf"), lambda v, ref: ref - v <= 12),
    "gust": Kind("gust", "Highest wind gust", "kt", 0, 1, lambda row, prev: row.get("max_gust"),
                 lambda v, ref: v <= 1.5 * ref + 10),
    "wettest": Kind("wettest", "Most rain and melted snow", "in", 2, 1, _precip, lambda v, ref: v <= 2.5 * ref + 1.0),
    "muggiest": Kind("muggiest", "Highest dew point", "°F", 0, 1, _temp("max_dwpf"), lambda v, ref: v - ref <= 8),
    "warmup": Kind("warmup", "Biggest warm-up from the day before", "°F", 0, 1, _change, lambda v, ref: v - ref <= 12),
    "cooldown": Kind("cooldown", "Biggest cool-down from the day before", "°F", 0, -1, _change,
                     lambda v, ref: ref - v <= 12),
    "coolhigh": Kind("coolhigh", "Coolest high", "°F", 0, -1, _temp("max_tmpf"), lambda v, ref: ref - v <= 12),
    "lowdew": Kind("lowdew", "Lowest dew point", "°F", 0, -1, _temp("min_dwpf"), lambda v, ref: ref - v <= 12),
    "windiest": Kind("windiest", "Highest average wind", "kt", 0, 1, lambda row, prev: row.get("avg_sknt"),
                     lambda v, ref: v <= 1.5 * ref + 5),
    # A dew point sensor that reads low gives a humidity far below its neighbours'. Two of them sat
    # 150 km apart in West Virginia in October (6 and 7 % against 14 to 21 % around them)
    "lowhumid": Kind("lowhumid", "Lowest humidity", "%", 0, -1, _temp("min_rh"), lambda v, ref: v >= 0.7 * ref - 2),
}

# A dry day's rain round becomes the first of these families that the day didn't draw
DRY_SWAP = ("dew", "wind", "humid", "change", "gust", "high", "low")


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(min(1.0, math.sqrt(a)))


CELL_DEG = 2


def neighbours(stations: dict[str, Station], radius_km: float) -> dict[str, list[str]]:
    """Each station's neighbours within ``radius_km`` (at most 220 km: two cells' worth)."""
    ids = sorted(stations)
    cells: dict[tuple[int, int], list[str]] = {}
    for s in ids:  # 2° cells, so each station is compared only with nearby ones
        cells.setdefault((int(stations[s].lat // CELL_DEG), int(stations[s].lon // CELL_DEG)), []).append(s)
    out = {}
    for s in ids:
        a = stations[s]
        ci, cj = int(a.lat // CELL_DEG), int(a.lon // CELL_DEG)
        # Two cells east and west: north of 47.6°N a 2° cell is narrower than 150 km
        near = [t for di in (-1, 0, 1) for dj in (-2, -1, 0, 1, 2) for t in cells.get((ci + di, cj + dj), ())]
        out[s] = [t for t in near if t != s and haversine_km(a.lat, a.lon, stations[t].lat, stations[t].lon) <= radius_km]
    return out


def summits(stations: dict[str, Station]) -> set[str]:
    """Mountaintop and pass stations: far above the median of their neighbours within 75 km."""
    out = set()
    for s, near in neighbours(stations, SUMMIT_KM).items():
        if not near:
            continue
        rise = stations[s].elev - statistics.median(stations[t].elev for t in near)
        if rise > SUMMIT_ANY_M or (rise > SUMMIT_NAMED_M and SUMMIT_NAME.search(stations[s].name)):
            out.add(s)
    return out


def eligible(stations: dict[str, Station], outlines: StateOutlines) -> dict[str, Station]:
    """Stations that may report for a round or back one up: in the Lower 48, on land, not a summit.
    AWOS stations count as neighbours; only ASOS stations can be answers."""
    land = {
        s: st for s, st in stations.items()
        if st.state in LOWER_48 and outlines.state_at(st.lon, st.lat, LAND_SLACK_KM) is not None
    }
    tops = summits(land)
    return {s: st for s, st in land.items() if s not in tops}


def plan_rounds(day: date) -> list[str]:
    """The day's five kinds of round. The wet round's kind is settled once the data is in.

    From ``draft.FROM`` the families are drawn each day. The high and the dew
    point ask for the usual extreme on about two days in three, and otherwise
    for the coolest high or the lowest dew point; the warm-up and cool-down
    still alternate. There's no warmest low: in October Key West had it on 19
    of 22 days."""
    n = (day - EPOCH).days
    if day < draft.FROM:
        return ["hottest", "coldest", "gust", "wettest", "warmup" if n % 2 == 0 else "cooldown"]
    rng = random.Random(f"kinds:{day.isoformat()}")
    return [_kind(f, rng.random() < 2 / 3, n) for f in draft.spot_families(day)]


def _kind(family: str, usual: bool, n: int) -> str:
    return {
        "high": "hottest" if usual else "coolhigh",
        "low": "coldest",
        "dew": "muggiest" if usual else "lowdew",
        "change": "warmup" if n % 2 == 0 else "cooldown",
        "gust": "gust", "rain": "wettest", "wind": "windiest", "humid": "lowhumid",
    }[family]


def dry_swap(day: date, kinds: list[str]) -> str:
    """The kind that replaces a dry day's rain round: the highest dew point, unless the day drew dew points."""
    families = {draft.KIND_FAMILY[k] for k in kinds}
    if day >= draft.FROM:  # Station ID's temperature stays its own (and the change, beside the high)
        families |= draft.kept_from_spot(day)
    family = next(f for f in DRY_SWAP if f not in families)
    return _kind(family, True, (day - EPOCH).days)


def round_values(kind: Kind, ok: dict[str, Station], near: dict[str, list[str]],
                 today: dict[str, dict], before: dict[str, dict]) -> dict[str, float]:
    """Every ASOS station whose value its neighbours back up, rounded as players see it."""
    raw = {}
    for s in ok:
        if s in today:
            v = kind.value(today[s], before.get(s))
            if v is not None:
                raw[s] = float(v)
    out = {}
    for s, v in raw.items():
        if not ok[s].asos:
            continue
        refs = sorted((raw[t] for t in near[s] if t in raw), key=lambda x: -kind.sign * x)
        if len(refs) >= 2 and kind.plausible(v, refs[1]):
            out[s] = round(v, kind.decimals) + 0.0  # + 0.0: no "-0.0"
    return out


def build_puzzle(day: date, stations: dict[str, Station], today: dict[str, dict], before: dict[str, dict],
                 area: dict, outlines: StateOutlines, made: datetime | None = None) -> dict:
    """The day's puzzle. ``area`` is regions.json's "us": the box every round's map shows."""
    ok = eligible(stations, outlines)
    near = neighbours(ok, NEIGHBOUR_KM)
    rounds = []
    used: dict[str, int] = {}
    order: list[str] = []

    def index(s: str) -> int:
        if s not in used:
            used[s] = len(order)
            order.append(s)
        return used[s]

    planned = plan_rounds(day)
    for kind_id in planned:
        kind = KINDS[kind_id]
        values = round_values(kind, ok, near, today, before)
        swapped = kind_id == "wettest" and max(values.values(), default=0.0) < MIN_PRECIP_IN
        if swapped:
            kind = KINDS[dry_swap(day, planned)]
            values = round_values(kind, ok, near, today, before)
        if len(values) < MIN_STATIONS:
            raise ValueError(f"{day}: only {len(values)} stations for {kind.id}")
        best = max(values.values(), key=lambda v: kind.sign * v)
        ids = sorted(values, key=index)
        rounds.append({
            "kind": kind.id,
            "title": kind.title,
            "unit": kind.unit,
            "decimals": kind.decimals,
            "best": best,
            # The median: value points start above it
            "floor": round(statistics.median(values.values()), kind.decimals) + 0.0,
            "top": sorted(index(s) for s in values if values[s] == best),
            "i": [index(s) for s in ids],
            "v": [values[s] for s in ids],
            **({"swapped": True} if swapped else {}),
        })

    return {
        "v": VERSION,
        "game": GAME,
        "date": day.isoformat(),
        "number": (day - EPOCH).days + 1,
        "made": (made or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "credit": CREDIT,
        "area": {k: area[k] for k in ("id", "label", "lat", "lon")},
        "scoring": SCORING,
        "stations": [[s, ok[s].name, ok[s].state, round(ok[s].lat, 3), round(ok[s].lon, 3)] for s in order],
        "rounds": rounds,
    }
