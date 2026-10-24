"""Make a day's puzzle, write it under the data root, and publish it to R2.

A puzzle is ``games/<game>/<date>.json``, and ``games/<game>/latest.json`` is a
copy of the newest. The dated file is written first, ``latest.json`` last, and
``latest.json`` never moves back to an older day (rerunning an old day only
rewrites that day's file). Beat the Models also writes each day's models'
calls and verdict beside its puzzle (``run_beat``).
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Callable

from ..store import R2Store, atomic_write_bytes
from . import beat, draft, highs, iem, maps, measured, spot, station
from .land import StateOutlines

log = logging.getLogger(__name__)

# The Lower 48's last local midnight is 08Z (Pacific standard time; 07Z in summer)
DAY_ENDS_UTC = timedelta(hours=8)


def default_day(now: datetime) -> date:
    """The newest day that has ended everywhere in the Lower 48."""
    return (now - DAY_ENDS_UTC).date() - timedelta(days=1)


def make_spot(day: date, area: dict, with_maps: bool = True, config_dir: Path | None = None) -> dict:
    stations = iem.fetch_stations()
    today = iem.fetch_daily(day)
    before = iem.fetch_daily(day - timedelta(days=1))
    iem.check_coverage(day, stations, today)
    iem.check_coverage(day - timedelta(days=1), stations, before)
    puzzle = spot.build_puzzle(day, stations, today, before, area, StateOutlines())
    if with_maps:
        product, fetch = maps.gfs_fetch(config_dir)
        found = maps.make_maps(day, [r["kind"] for r in puzzle["rounds"]], area, product, fetch)
        for r in puzzle["rounds"]:
            if r["kind"] in found:
                r["map"] = found[r["kind"]]
    return puzzle


def make_measured(day: date, area: dict, config_dir: Path | None = None) -> dict:
    measure, forecast = measured.noaa_sources(measured.game_grid(area), config_dir)
    return measured.build_puzzle(day, area, measure, forecast, StateOutlines())


def make_station(day: date, area: dict, spot_puzzle: dict, earlier: Callable[[date], dict | None],
                 config_dir: Path, beat_puzzle: Callable[[date], dict | None] = lambda d: None) -> dict:
    """``spot_puzzle``: Wx Marks the Spot's puzzle for the same day, whose fields Station ID leaves out;
    ``earlier(d)``: Station ID's puzzle for an earlier day d, or None (for the cycle's answers so far);
    ``beat_puzzle(d)``: Beat the Models' puzzle for day d, or None (its cities for the day and the two
    after can't be the answer)."""
    if spot_puzzle.get("date") != day.isoformat():
        raise ValueError(f"Wx Marks the Spot's puzzle is for {spot_puzzle.get('date')}, not {day}")
    cities = station.load_cities(config_dir)
    reports = iem.fetch_cli(day)
    asos = iem.fetch_daily(day)
    used = station.used_before(day, len(cities), earlier)
    # The day after next exists only when Station ID is remade later: its page shows the day's high too
    avoid = {p["city"]["id"] for k in range(3) if (p := beat_puzzle(day + timedelta(days=k))) is not None}
    return station.build_puzzle(day, cities, reports, asos, draft.families_shown(spot_puzzle), area, used,
                                avoid=avoid)


class GameFiles:
    """A game's files: R2's when publishing (what players see), else the data dir's. Writes go to both."""

    def __init__(self, data_dir: Path, game: str, remote: R2Store | None = None):
        self.root = data_dir / "games" / game
        self.remote = remote

    def read(self, name: str) -> dict | None:
        if self.remote is not None:
            return self.remote.read_json(name)
        path = self.root / name
        return json.loads(path.read_text()) if path.exists() else None

    def write(self, name: str, obj: dict) -> None:
        payload = encode(obj)
        self.root.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(self.root / name, payload)
        if self.remote is not None:
            self.remote.put_json(name, payload)


def run_beat(newest: date, files: GameFiles, station_files: GameFiles, config_dir: Path,
             now: datetime, replace: bool = False) -> tuple[list[str], list[str]]:
    """Beat the Models' day, for ``newest``, the newest day ended in the Lower 48 (Y). Three steps,
    each on its own (one failing doesn't stop the others):

    1. the verdicts for Y and the days before it still waiting for one (making a day's models'
       calls first if they're missing);
    2. the models' calls for Y+1, whose lock passed at midnight;
    3. the puzzle for Y+2, the next day, with its 00Z runs of this morning.

    The models' calls and the verdicts are written once: ``replace`` remakes only the puzzle (a
    model's run can't be read again a day later: DWD keeps ICON's about a day). A model that can't
    be read is an error, and until ``beat.LAST_TRY`` on the day nothing is written, so the backup run
    tries again; from then on the calls are written without it. Returns (summary lines, errors)."""
    lines: list[str] = []
    errors: list[str] = []
    models = highs.load_models(config_dir)
    sources: dict[str, highs.Source] = {}

    def source(m: highs.Model) -> highs.Source:
        if m.id not in sources:
            sources[m.id] = highs.Source(m, config_dir)
        return sources[m.id]

    def all_sources() -> dict[str, highs.Source]:
        return {m.id: source(m) for m in models}

    def models_for(day: date) -> dict | None:
        """The day's models' calls: already made, or made now if its lock has passed."""
        name = f"{day.isoformat()}.models.json"
        found = files.read(name)
        puzzle = files.read(f"{day.isoformat()}.json")
        if found is not None or puzzle is None:
            return found
        if now < datetime.fromisoformat(puzzle["lock"].replace("Z", "+00:00")):
            raise ValueError(f"{day}: its call doesn't lock until {puzzle['lock']}")
        calls, missing = beat.models_at_lock(puzzle, models, all_sources())
        if missing:
            errors.append(f"models' calls for {day}: " + "; ".join(missing))
            last_try = datetime.combine(day, beat.LAST_TRY, tzinfo=timezone.utc)
            if now < last_try:
                log.warning("%s: %d of %d models read; the backup run tries again", day, len(calls), len(models))
                return None
        made = beat.build_models(puzzle, calls, made=now)
        files.write(name, made)
        lines.extend(beat.summary(None, made, None))
        return made

    # 1. The verdicts
    for back in range(beat.VOID_AFTER_DAYS - 1, -1, -1):
        day = newest - timedelta(days=back)
        name = f"{day.isoformat()}.result.json"
        try:
            puzzle = files.read(f"{day.isoformat()}.json")
            if puzzle is None or files.read(name) is not None:
                continue
            try:
                calls = models_for(day)
            except Exception as e:  # noqa: BLE001 - the verdict still shows the high
                log.warning("%s: no models' calls for the verdict: %s", day, e)
                calls = None
            report = iem.fetch_cli(day).get(puzzle["city"]["id"])
            high = beat.report_line(day, report)["high"]
            if high is None and back < beat.VOID_AFTER_DAYS - 1:
                log.info("%s: no whole-day report for %s yet; the verdict waits", day, puzzle["city"]["id"])
                continue
            result = beat.build_result(puzzle, calls, report, void=high is None, made=now)
            files.write(name, result)
            lines.extend(beat.summary(None, None, result))
        except Exception as e:  # noqa: BLE001 - logged and reported; the other steps go on
            log.exception("%s: Beat the Models' verdict failed", day)
            errors.append(f"verdict for {day}: {e}")

    # 2. The models' calls for the day that just locked
    day = newest + timedelta(days=1)
    try:
        models_for(day)
    except Exception as e:  # noqa: BLE001
        log.exception("%s: Beat the Models' models' calls failed", day)
        errors.append(f"models' calls for {day}: {e}")

    # 3. The next day's puzzle
    day = newest + timedelta(days=2)
    try:
        cities = station.load_cities(config_dir)
        if day < beat.EPOCH:
            log.info("Beat the Models starts on %s (#1); no puzzle for %s", beat.EPOCH, day)
        elif files.read(f"{day.isoformat()}.json") is not None and not replace:
            log.info("%s: Beat the Models' puzzle is already published; leaving it", day)
            if files.remote is not None and catch_up_latest(files.remote, day.isoformat()):
                lines.append(f"Beat the Models {day}: latest.json caught up")
        elif newest < default_day(now) and now >= max(beat.lock_time(c["tz"], day) for c in cities):
            # An earlier day run by hand (for its verdict): its next puzzle's day has begun
            log.info("%s: every city's call has locked; no puzzle", day)
        else:
            puzzle = make_beat_puzzle(day, models, all_sources(), files, station_files, config_dir, now)
            for name in [f"{day.isoformat()}.json"] + (["latest.json"] if _newer(files, day) else []):
                files.write(name, puzzle)
            lines.extend(beat.summary(puzzle, None, None))
    except Exception as e:  # noqa: BLE001
        log.exception("%s: Beat the Models' puzzle failed", day)
        errors.append(f"puzzle for {day}: {e}")
    return lines, errors


def _newer(files: GameFiles, day: date) -> bool:
    """Whether ``day`` is at least as new as latest.json's."""
    return day.isoformat() >= (files.read("latest.json") or {}).get("date", "")


def make_beat_puzzle(day: date, models: list[highs.Model], sources: dict[str, highs.Source], files: GameFiles,
                     station_files: GameFiles, config_dir: Path, now: datetime) -> dict:
    """The puzzle for ``day``: published the morning before, from each model's run out at 10:30Z then
    (00Z; fixed, so a remake later in the day picks the same city)."""
    cities = station.load_cities(config_dir)
    regions = json.loads((config_dir / "regions.json").read_text())["regions"]
    newest = day - timedelta(days=2)
    if now >= max(beat.lock_time(c["tz"], day) for c in cities):
        raise ValueError(f"{day}: every city's call has locked")
    # Station ID's answers for the newest day and the one before: this page shows their highs
    avoid: set[str] = set()
    for d in (newest, newest - timedelta(days=1)):
        sid = station_files.read(f"{d.isoformat()}.json")
        if sid is None and d == newest and d >= station.EPOCH:
            raise ValueError(f"Station ID's puzzle for {d} isn't published; Beat the Models leaves out its city, "
                             "so it's made after")
        if sid is not None:
            avoid.add(sid["cities"][sid["answer"]][0])
    recent = beat.recent_cities(day, lambda d: files.read(f"{d.isoformat()}.json"))
    avoid |= set(recent)
    picked_at = datetime.combine(day - timedelta(days=1), time(10, 30), tzinfo=timezone.utc)
    places = [beat.place(c, day) for c in cities]
    calls: dict[str, list[highs.High | None]] = {}
    for m in models:
        init = m.run_at(picked_at)
        try:
            calls[m.id] = sources[m.id].highs(init, places)
        except Exception as e:  # noqa: BLE001 - the spread of the rest still picks a city
            log.warning("%s: %s's run %s couldn't be read for the city's pick: %s", day, m.name, f"{init:%Y%m%d%H}", e)
    spread = beat.spreads(day, cities, calls)
    # A run delayed into the night leaves out the cities whose call has already locked
    locked = {c["id"] for c in cities if now >= beat.lock_time(c["tz"], day)}
    k = beat.pick_city(day, cities, spread, avoid | locked)
    reports = {d: iem.fetch_cli(d).get(cities[k]["id"]) for d in (newest - timedelta(days=1), newest)}
    return beat.build_puzzle(day, cities, k, models, regions, list(reports.items()), recent, spread[k], made=now)


NAMES = {"spot": "Wx Marks the Spot", "measured": "Modeled or Measured", "station": "Station ID",
         "beat": "Beat the Models"}


def encode(puzzle: dict) -> bytes:
    return json.dumps(puzzle, separators=(",", ":"), ensure_ascii=False).encode()


def write(data_dir: Path, puzzle: dict) -> list[str]:
    """Write the puzzle (and latest.json, if it's the newest); returns the names written."""
    root = data_dir / "games" / puzzle["game"]
    root.mkdir(parents=True, exist_ok=True)
    payload = encode(puzzle)
    written = [f"{puzzle['date']}.json"]
    atomic_write_bytes(root / written[0], payload)
    latest = root / "latest.json"
    current = json.loads(latest.read_text()).get("date", "") if latest.exists() else ""
    if puzzle["date"] >= current:
        atomic_write_bytes(latest, payload)
        written.append("latest.json")
    return written


def publish(puzzle: dict, remote: R2Store) -> list[str]:
    """Upload the puzzle, then latest.json if R2's is no newer."""
    payload = encode(puzzle)
    written = [f"{puzzle['date']}.json"]
    remote.put_json(written[0], payload)
    if catch_up_latest(remote, puzzle["date"], payload):
        written.append("latest.json")
    return written


def catch_up_latest(remote: R2Store, day: str, payload: bytes | None = None) -> bool:
    """Point latest.json at ``day``'s puzzle if R2's latest.json is older (or missing).

    A run that uploads a day but dies before latest.json would otherwise leave
    latest.json a day behind for good: the next run finds the day published
    and stops. Returns whether latest.json was written."""
    current = (remote.read_json("latest.json") or {}).get("date", "")
    if day < current or (day == current and payload is None):
        return False
    if payload is None:
        payload = encode(remote.read_json(f"{day}.json"))
    remote.put_json("latest.json", payload)
    return True


def summary(puzzle: dict) -> str:
    if puzzle["game"] == "station":
        _, city, state, name, *_ = puzzle["cities"][puzzle["answer"]]
        cards = ", ".join(c["id"] for c in puzzle["cards"])
        return (f"Station ID #{puzzle['number']} ({puzzle['date']}): {city}, {state} ({name}); cards {cards}; "
                f"left to Wx Marks the Spot: {', '.join(puzzle['spot'])}")
    if puzzle["game"] == "measured":
        parts = [f"{r['title']}: GFS {r['model']['run']} ({r['model']['lead']} h), miss {r['miss']['score']:g}, "
                 f"bias {r['miss']['bias']:+g} {r['unit']}" for r in puzzle["rounds"]]
        return f"Modeled or Measured #{puzzle['number']} ({puzzle['date']}): " + "; ".join(parts)
    st = puzzle["stations"]
    parts = []
    for r in puzzle["rounds"]:
        names = " and ".join(f"{st[i][1]}, {st[i][2]}" for i in r["top"])
        maps_note = "" if "map" in r else " (no map)"
        parts.append(f"{r['title']}: {names} {r['best']:g} {r['unit']}{maps_note}")
    return f"Wx Marks the Spot #{puzzle['number']} ({puzzle['date']}): " + "; ".join(parts)
