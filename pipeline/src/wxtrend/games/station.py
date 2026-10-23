"""Station ID (build plan G3): a hidden city, one weather clue at a time; six guesses.

The cities are ``config/games/station-cities.json``: well-known Lower 48
cities whose airport has an NWS daily climate report (CLI). Clues come from
those reports (the day's high, low, rain, gust and wind, the times of the high
and low, sky cover, normals, records) and from IEM's ASOS summaries (dew point
and humidity, which the reports lack).

Six cards, one before each guess. The measured ones are in families that Wx
Marks the Spot didn't show that day (``draft.py``), so its reveal can't be
used to look the answer up; the draw always leaves Station ID the high or the
low. Never the day-to-day change: it's today's high minus yesterday's, so
with yesterday's pin game it would give the high away (the 2026-10-23 review).

1. The temperature: the one the draw kept for Station ID (the other too, when
   the pin game didn't draw it, comes later), with its departure from normal.
   Chris played the first version (2026-10-23) and found the times of the
   high and low, light wind, humidity and dew point very hard to reason from
   as first clues, even knowing the weather; temperature is the clue people
   can place on a map.
2-5. In an order shuffled by the date: the other measured families, the clock
   (when the high and low came, and the sky cover), and the normals (normal
   high and low for the date, rain since Jan 1 against normal), which come
   4th or 5th. On a dry day rain is no clue. Short of cards, this month's
   rain against normal fills in, then the records (and the elevation is left
   for card 6 on its own).
6. Records for the date (with their years) and the elevation.

A wrong guess shows that city's values for the clues so far, beside the
answer's, and its distance band (under 200 miles, 200 to 500, 500 to 1,000,
farther; no compass arrow). Tested on 2026-10-01 to 22 with 330 cities (328 now): a
player who ignores the weather and guesses among the cities the bands allow
wins 53% of games in six guesses, and a real player tracks the bands' rings
less well than that one does (with Worldle's distance and arrow it was every
game by the fourth); one who knows the day's weather wins in 3.5 on average.

Answers go through the cities in an order shuffled for each cycle of
len(cities) days. A day starts at its place in the order and takes the first
city that hasn't been an answer this cycle and whose report has every clue.
The cycle's answers so far ride along in each puzzle ("used"), so a day reads
the day before's (or the latest within a week).
"""

from __future__ import annotations

import hashlib
import json
import random
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from . import draft
from .iem import IEM

GAME = "station"
VERSION = 1
EPOCH = date(2026, 10, 23)  # puzzle #1: the first day the draw leaves Station ID a temperature
GUESSES = 6
BANDS_MI = (200, 500, 1000)
MIN_PRECIP_IN = 0.10  # below this at every city, rain is no clue
MIN_REPORTS = 0.8  # share of the cities whose report must be in

CREDIT = {"text": "NWS daily climate reports and ASOS observations via the Iowa Environmental Mesonet", "url": IEM + "/"}

# The items each card shows. Items in OPTIONAL may be missing from the answer's report
FAMILY_ITEMS = {
    "high": ["high", "high_depart"],
    "low": ["low", "low_depart"],
    "rain": ["rain"],
    "gust": ["gust", "gust_dir"],
    "dew": ["dew_max", "dew_min"],
    "wind": ["wind"],
    "humid": ["humid"],
}
CLOCK = {"id": "clock", "items": ["high_time", "low_time", "sky"]}
MONTH = {"id": "month", "items": ["rain_month", "rain_month_normal"]}
NORMALS = {"id": "normals", "items": ["normal_high", "normal_low", "rain_year", "rain_year_normal"]}
RECORD_ITEMS = ["record_high", "record_high_year", "record_low", "record_low_year"]
RECORDS = {"id": "records", "items": RECORD_ITEMS + ["elev"]}
# When the records fill a gap in the middle, the elevation is card 6 on its own
RECORD = {"id": "record", "items": RECORD_ITEMS}
ELEVATION = {"id": "elevation", "items": ["elev"]}
# Items the answer's report may lack, as long as its card has something to show
OPTIONAL = {"sky", "gust_dir", "high_depart", "low_depart", *RECORD_ITEMS}
LOOK_BACK_DAYS = 7  # how far back a day looks for the cycle's answers so far


def load_cities(config_dir: Path) -> list[dict]:
    return json.loads((config_dir / "games" / "station-cities.json").read_text())["cities"]


def _num(v) -> float | None:
    """A report's number; "T" (a trace) is 0.001, "M" (missing) is None."""
    if v == "T":
        return 0.001
    if v is None or isinstance(v, str):
        try:
            return float(v) if v not in (None, "", "M", "MM") else None
        except ValueError:
            return None
    return float(v)


def _minutes(t) -> int | None:
    """'329 PM' → 929 (minutes after midnight, local standard time)."""
    if not isinstance(t, str) or not t.endswith(("AM", "PM")) or not t[:-3].strip().isdigit():
        return None
    hm = int(t[:-3])
    h, m = divmod(hm, 100)
    if h > 12 or m > 59:
        return None
    return (h % 12 + (12 if t.endswith("PM") else 0)) * 60 + m


def _year(years) -> int | None:
    """The latest year a record was set (or tied)."""
    return max(years) if isinstance(years, list) and years else None


def city_values(city: dict, report: dict | None, asos: dict | None) -> dict[str, float | int | None]:
    """Every clue item for one city: °F, inches, mph, degrees, %, minutes, years and metres."""
    r, a = report or {}, asos or {}
    est = a.get("tmpf_est")
    v = {
        "high": _num(r.get("high")), "high_depart": _num(r.get("high_depart")),
        "low": _num(r.get("low")), "low_depart": _num(r.get("low_depart")),
        "rain": _num(r.get("precip")),
        "gust": _num(r.get("highest_gust_speed")), "gust_dir": _num(r.get("highest_gust_direction")),
        "dew_max": None if est else a.get("max_dwpf"), "dew_min": None if est else a.get("min_dwpf"),
        "wind": _num(r.get("average_wind_speed")),
        "humid": None if est or a.get("min_rh") is None else round(a["min_rh"]),
        "high_time": _minutes(r.get("high_time")), "low_time": _minutes(r.get("low_time")),
        "sky": _num(r.get("average_sky_cover")),
        "rain_month": _num(r.get("precip_month")), "rain_month_normal": _num(r.get("precip_month_normal")),
        "normal_high": _num(r.get("high_normal")), "normal_low": _num(r.get("low_normal")),
        "rain_year": _num(r.get("precip_jan1")), "rain_year_normal": _num(r.get("precip_jan1_normal")),
        "record_high": _num(r.get("high_record")), "record_high_year": _year(r.get("high_record_years")),
        "record_low": _num(r.get("low_record")), "record_low_year": _year(r.get("low_record_years")),
        "elev": float(city["elev"]),
    }
    if v["sky"] is not None and not 0 <= v["sky"] <= 1:
        v["sky"] = None
    return {k: _tidy(x) for k, x in v.items()}


def _tidy(x) -> float | int | None:
    """Whole numbers as integers, to keep the puzzle small; no "-0.0"."""
    if x is None:
        return None
    x = round(float(x), 3) + 0.0
    return int(x) if x.is_integer() else x


def plan_cards(day: date, families: list[str], dry: bool) -> list[dict]:
    """The day's six cards, from the families Wx Marks the Spot left."""
    def card(family: str) -> dict:
        return {"id": family, "items": FAMILY_ITEMS[family]}

    measured = [f for f in families if f in FAMILY_ITEMS and not (f == "rain" and dry)]
    kept = draft.station_temperature(day)
    # The kept temperature first; days before draft.FROM may have neither
    first = sorted((f for f in measured if f in draft.TEMPERATURES), key=lambda f: f != kept)[:1]
    need = GUESSES - 2 - len(first)  # the middle cards besides the normals
    middle = [card(f) for f in measured if f not in first] + [CLOCK]
    for filler in (MONTH, RECORD):
        if len(middle) < need:
            middle.append(filler)
    middle = middle[:need]
    rng = random.Random(f"cards:{day.isoformat()}")
    rng.shuffle(middle)
    cards = [card(f) for f in first] + middle
    cards.insert(rng.choice([3, 4]), NORMALS)
    return cards + [ELEVATION if RECORD in middle else RECORDS]


def complete(cards: list[dict], v: dict) -> bool:
    """Whether a city's values can fill every card as the answer: every item it must have, and
    something on every card."""
    return all(all(v[i] is not None for i in c["items"] if i not in OPTIONAL)
               and any(v[i] is not None for i in c["items"]) for c in cards)


def cycle_order(ids: list[str], cycle: int) -> list[str]:
    """The cities in cycle ``cycle``'s shuffled order (adding a city to the list doesn't reorder the others)."""
    return sorted(ids, key=lambda i: hashlib.sha256(f"station:{cycle}:{i}".encode()).hexdigest())


def used_before(day: date, count: int, earlier: Callable[[date], dict | None]) -> list[str]:
    """The cities already answers this cycle, from the latest puzzle within a week before ``day``.

    ``earlier(d)`` is Station ID's puzzle for d, or None. A gap longer than a
    week forgets the cycle's answers; the day's place in the order still keeps
    it from going back to the cycle's first cities."""
    cycle = (day - EPOCH).days // count
    for k in range(1, LOOK_BACK_DAYS + 1):
        prev = earlier(day - timedelta(days=k))
        if prev is None:
            continue
        if (prev["number"] - 1) // count != cycle:
            return []
        return prev.get("used", []) + [prev["cities"][prev["answer"]][0]]
    return []


def build_puzzle(day: date, cities: list[dict], reports: dict[str, dict], asos: dict[str, dict],
                 spot_shown: set[str], area: dict, used: list[str] = (), made: datetime | None = None) -> dict:
    """The day's puzzle. ``spot_shown``: the families Wx Marks the Spot's puzzle for the day shows;
    ``used``: the cities already answers this cycle (``used_before``)."""
    have = sum(c["id"] in reports for c in cities)
    if have < MIN_REPORTS * len(cities):
        raise ValueError(f"{day}: whole-day climate reports for only {have} of {len(cities)} cities")
    values = [city_values(c, reports.get(c["id"]), asos.get(c["id"][1:])) for c in cities]
    families = [f for f in draft.FAMILIES if f not in spot_shown]
    dry = max((v["rain"] or 0.0 for v in values), default=0.0) < MIN_PRECIP_IN

    n = (day - EPOCH).days
    count = len(cities)
    order = cycle_order([c["id"] for c in cities], n // count)
    index = {c["id"]: k for k, c in enumerate(cities)}
    cards = plan_cards(day, families, dry)
    walk = [index[order[(n % count + step) % count]] for step in range(count)]
    taken = set(used)
    # A city not yet used this cycle; if every complete one has been (a long run of skips), any complete one
    answer = next((k for k in walk if cities[k]["id"] not in taken and complete(cards, values[k])), None)
    if answer is None:
        answer = next((k for k in walk if complete(cards, values[k])), None)
    if answer is None:
        raise ValueError(f"{day}: no city has every clue")

    items = [i for c in cards for i in c["items"]]
    return {
        "v": VERSION,
        "game": GAME,
        "date": day.isoformat(),
        "number": n + 1,
        "made": (made or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "credit": CREDIT,
        "area": {k: area[k] for k in ("id", "label", "lat", "lon")},
        "guesses": GUESSES,
        "bands": list(BANDS_MI),
        "spot": sorted(spot_shown, key=draft.FAMILIES.index),
        "cities": [[c["id"], c["city"], c["state"], c["station"], c["lat"], c["lon"]] for c in cities],
        "answer": answer,
        "cards": cards,
        "values": {i: [v[i] for v in values] for i in items},
        "used": [u for u in used if u in index],
    }

