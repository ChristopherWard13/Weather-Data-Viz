"""Beat the Models (build plan G4): call a city's high for tomorrow before its midnight; the morning
after the day, see your miss beside five models'.

The cities are Station ID's (``config/games/station-cities.json``): Lower 48
cities whose airport has an NWS daily climate report (CLI). The high to call is
the report's, in whole °F, over its day: midnight to midnight local standard
time. A call locks at midnight on the city's clock as the day starts.

The models are the five whose output resolves a high (``highs.py``), each at
its latest run out at the lock: the newest run on the site's cycle whose start
plus the config's latency is before it. A model's high is moved to the
airport's elevation, and its call is that rounded to a whole degree, so a
player and a model who miss by the same are tied.

Three files a day under ``games/beat/``, each written once:

- ``<day>.json``, the puzzle, at 10:30Z the day before: the city, the lock, and
  the city's last two whole-day reports (high and normal high). ``latest.json``
  is a copy of the newest.
- ``<day>.models.json``: each model's call, from the first run after the lock
  (10:30Z on the day itself). It can't wait for the verdict: DWD keeps each
  hour of day's ICON run for only about a day.
- ``<day>.result.json``: the report's high, with the models' calls again, from
  10:30Z the morning after the day. A report still missing after
  ``VOID_AFTER_DAYS`` voids the day.

The city is drawn, by the date, from the tenth of cities where the five
models' 00Z highs for the day disagree the most (``PICK_SHARE``), so it's never
a coin flip on forecasts that agree, leaving out the last ``REPEAT_DAYS``
days' cities and Station ID's latest two answers (this page shows the city's
last two highs, which are Station ID's clues). Station ID in turn never picks
this game's cities for its day or the two after. Backtested on 2026-10-01 to 23
(four models; ICON keeps no archive): a player who called the four models'
average scored 44 points a day and busted on 2 of 22 days. The single widest
spread picked the cities whose grids can't see their airports' weather (Eureka,
Salinas, Oakland and Santa Rosa in a week) and busted that player on 10.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from .highs import High, Model, Place, Source

log = logging.getLogger(__name__)

GAME = "beat"
VERSION = 1
EPOCH = date(2026, 10, 27)  # puzzle #1's day
REPEAT_DAYS = 30
PICK_SHARE = 0.1  # the city is drawn from this share of cities, widest spreads first
MIN_MODELS = 3  # fewer, and there's nothing to beat
VOID_AFTER_DAYS = 3  # a report still missing on this many mornings' tries voids the day
POINTS = 100  # for an exact call
POINTS_PER_DEGREE = 20  # lost for each °F off
BUST_F = 5  # a miss this big scores nothing

CREDIT = {
    "text": "Forecasts: NOAA (GFS, GEFS), ECMWF (CC BY 4.0), Deutscher Wetterdienst (ICON, CC BY 4.0), "
            "Environment and Climate Change Canada (GEM). The high: the NWS daily climate report, via the Iowa "
            "Environmental Mesonet",
    "url": "https://mesonet.agron.iastate.edu/",
}


def climate_day(tz: str, day: date) -> tuple[datetime, datetime]:
    """The UTC bounds of ``day`` as the NWS climate report keeps it: midnight to midnight local
    standard time all year (an hour later on the clock in summer)."""
    start = datetime.combine(day, time(), tzinfo=timezone.utc) - _standard_offset(tz, day)
    return start, start + timedelta(days=1)


def _standard_offset(tz: str, day: date) -> timedelta:
    t = datetime.combine(day, time(12), tzinfo=ZoneInfo(tz))
    return t.utcoffset() - (t.dst() or timedelta(0))


def lock_time(tz: str, day: date) -> datetime:
    """When the call for ``day`` locks: midnight on the city's clock as the day starts, in UTC."""
    return datetime.combine(day, time(), tzinfo=ZoneInfo(tz)).astimezone(timezone.utc)


def whole(x: float) -> int:
    """A high to the whole degree, halves away from zero (the page rounds the same way)."""
    return int(x + 0.5) if x >= 0 else -int(-x + 0.5)


def points(call: int, high: int) -> int:
    return max(0, POINTS - POINTS_PER_DEGREE * abs(call - high))


def iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def map_time(tz: str, day: date) -> str:
    """The model maps' 6-hourly time nearest 3 p.m. local standard time on ``day`` (about when
    highs come), later on a tie: "YYYYMMDDHH"."""
    start, _ = climate_day(tz, day)
    afternoon = start + timedelta(hours=15)
    hours = afternoon.hour + 3  # to the nearest 6-hourly time, a tie going later
    t = afternoon.replace(hour=0) + timedelta(hours=hours - hours % 6)
    return f"{t:%Y%m%d%H}"


def region_for(state: str, regions: list[dict]) -> str:
    """The site's region holding the state (Mainland US if none does)."""
    return next((r["id"] for r in regions if state in r.get("states", [])), "us")


# ------------------------------------------------------------------ the puzzle


def spreads(day: date, cities: list[dict], calls: dict[str, list[High | None]]) -> list[float | None]:
    """Each city's spread of the models' highs for ``day`` (max minus min), or None with fewer than
    MIN_MODELS of them."""
    out = []
    for k in range(len(cities)):
        vals = [v[k].value for v in calls.values() if v[k] is not None]
        out.append(max(vals) - min(vals) if len(vals) >= MIN_MODELS else None)
    return out


def pick_city(day: date, cities: list[dict], spread: list[float | None], avoid: set[str]) -> int:
    """A city from the PICK_SHARE of them with the widest spreads (leaving out ``avoid``), drawn by
    an order shuffled by the date."""
    def shuffled(k: int) -> str:
        return hashlib.sha256(f"beat:{day.isoformat()}:{cities[k]['id']}".encode()).hexdigest()

    ok = sorted((k for k, c in enumerate(cities) if spread[k] is not None and c["id"] not in avoid),
                key=lambda k: (-spread[k], cities[k]["id"]))
    if not ok:
        raise ValueError(f"{day}: no city has {MIN_MODELS} models' highs")
    return min(ok[:max(1, round(PICK_SHARE * len(ok)))], key=shuffled)


def recent_cities(day: date, earlier) -> list[str]:
    """The cities of the puzzles for the REPEAT_DAYS days before ``day``, from the latest within a
    week (each puzzle carries the ones of the REPEAT_DAYS days before it, one a day)."""
    for k in range(1, 8):
        prev = earlier(day - timedelta(days=k))
        if prev is not None:
            # prev's list and its own city cover the days up to day - k; days without a puzzle drift it
            return (prev.get("recent", []) + [prev["city"]["id"]])[-(REPEAT_DAYS + 1 - k):]
    return []


def city_block(c: dict, regions: list[dict]) -> dict:
    return {"id": c["id"], "city": c["city"], "state": c["state"], "station": c["station"],
            "lat": c["lat"], "lon": c["lon"], "elev": c["elev"], "tz": c["tz"], "region": region_for(c["state"], regions)}


def place(c: dict, day: date) -> Place:
    return Place(c["lat"], c["lon"], c["elev"], *climate_day(c["tz"], day))


def report_line(d: date, report: dict | None) -> dict:
    """One past day for the puzzle's context: its high and normal high (None if the report lacks them)."""
    def num(v):
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None

    r = report or {}
    return {"date": d.isoformat(), "high": num(r.get("high")), "normal": num(r.get("high_normal"))}


def build_puzzle(day: date, cities: list[dict], k: int, models: list[Model], regions: list[dict],
                 context: list[tuple[date, dict | None]], recent: list[str], spread: float,
                 made: datetime | None = None) -> dict:
    """The puzzle for ``day``: city ``k``; ``context``: its last whole-day reports, newest last."""
    c = cities[k]
    return {
        "v": VERSION,
        "game": GAME,
        "date": day.isoformat(),
        "number": (day - EPOCH).days + 1,
        "made": iso(made or datetime.now(timezone.utc)),
        "credit": CREDIT,
        "city": city_block(c, regions),
        "lock": iso(lock_time(c["tz"], day)),
        "day": [iso(t) for t in climate_day(c["tz"], day)],
        "map": map_time(c["tz"], day),
        "models": [{"id": m.id, "name": m.name} for m in models],
        "context": [report_line(d, r) for d, r in context],
        "spread": round(spread, 1),
        "rules": {"points": POINTS, "per_degree": POINTS_PER_DEGREE, "bust": BUST_F},
        "recent": recent,
    }


# ------------------------------------------------------------------ the models' calls and the verdict


def models_at_lock(puzzle: dict, models: list[Model], sources: dict[str, Source]) -> tuple[list[dict], list[str]]:
    """Each model's call for the puzzle's day, from its latest run out at the lock, and why each
    model left out couldn't be read."""
    lock = datetime.fromisoformat(puzzle["lock"].replace("Z", "+00:00"))
    start, end = (datetime.fromisoformat(t.replace("Z", "+00:00")) for t in puzzle["day"])
    c = puzzle["city"]
    out, missing = [], []
    for m in models:
        init = m.run_at(lock)
        try:
            (high,) = sources[m.id].highs(init, [Place(c["lat"], c["lon"], c["elev"], start, end)])
        except Exception as e:  # noqa: BLE001 - a model missing is a smaller field, not no game
            missing.append(f"{m.name}'s run {init:%Y%m%d%H} couldn't be read: {e}")
            log.warning("%s: %s", puzzle["date"], missing[-1])
            continue
        if high is None:
            missing.append(f"{m.name}'s run {init:%Y%m%d%H} has no value at {c['id']}")
            log.warning("%s: %s", puzzle["date"], missing[-1])
            continue
        # The call is the unrounded high to the whole degree (71.46 is 71, though it shows as 71.5)
        out.append({"id": m.id, "name": m.name, "run": f"{init:%Y%m%d%H}", "high": round(high.value, 1),
                    "call": whole(high.value), "ground": high.ground,
                    "lead": round((start + timedelta(hours=15) - init) / timedelta(hours=1))})
    return out, missing


def build_models(puzzle: dict, calls: list[dict], made: datetime | None = None) -> dict:
    if len(calls) < MIN_MODELS:
        raise ValueError(f"{puzzle['date']}: only {len(calls)} models' calls ({', '.join(c['id'] for c in calls)}); "
                         f"need {MIN_MODELS}")
    return {"v": VERSION, "game": GAME, "date": puzzle["date"], "number": puzzle["number"],
            "made": iso(made or datetime.now(timezone.utc)), "city": puzzle["city"], "lock": puzzle["lock"],
            "models": calls}


def build_result(puzzle: dict, models: dict | None, report: dict | None, void: bool = False,
                 made: datetime | None = None) -> dict:
    """The verdict: the report's high (None when ``void``), and the models' calls again."""
    high = None if void else report_line(date.fromisoformat(puzzle["date"]), report)["high"]
    if high is None and not void:
        raise ValueError(f"{puzzle['date']}: no high in {puzzle['city']['id']}'s report")
    return {"v": VERSION, "game": GAME, "date": puzzle["date"], "number": puzzle["number"],
            "made": iso(made or datetime.now(timezone.utc)), "city": puzzle["city"], "lock": puzzle["lock"],
            "high": None if high is None else int(high), "void": void,
            "models": (models or {}).get("models", [])}


def summary(puzzle: dict | None, models: dict | None, result: dict | None) -> list[str]:
    lines = []
    if result is not None:
        c = result["city"]
        if result["void"]:
            lines.append(f"Beat the Models #{result['number']} ({result['date']}) {c['city']}, {c['state']}: void (no report)")
        else:
            calls = ", ".join(f"{m['name']} {m['call']} ({m['call'] - result['high']:+d})" for m in result["models"])
            lines.append(f"Beat the Models #{result['number']} ({result['date']}) {c['city']}, {c['state']}: "
                         f"the high was {result['high']} °F; {calls}")
    if models is not None:
        c = models["city"]
        calls = ", ".join(f"{m['name']} {m['call']} (run {m['run']})" for m in models["models"])
        lines.append(f"Beat the Models #{models['number']} ({models['date']}) {c['city']}, {c['state']} locked: {calls}")
    if puzzle is not None:
        c = puzzle["city"]
        lines.append(f"Beat the Models #{puzzle['number']} ({puzzle['date']}): {c['city']}, {c['state']} "
                     f"({c['station']}), locks {puzzle['lock']}; the models' 00Z highs spread {puzzle['spread']:g} °F")
    return lines
