"""Make a day's puzzle, write it under the data root, and publish it to R2.

A puzzle is ``games/<game>/<date>.json``, and ``games/<game>/latest.json`` is a
copy of the newest. The dated file is written first, ``latest.json`` last, and
``latest.json`` never moves back to an older day (rerunning an old day only
rewrites that day's file).
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Callable

from ..store import R2Store, atomic_write_bytes
from . import draft, iem, maps, measured, spot, station
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
                 config_dir: Path) -> dict:
    """``spot_puzzle``: Wx Marks the Spot's puzzle for the same day, whose fields Station ID leaves out;
    ``earlier(d)``: Station ID's puzzle for an earlier day d, or None (for the cycle's answers so far)."""
    if spot_puzzle.get("date") != day.isoformat():
        raise ValueError(f"Wx Marks the Spot's puzzle is for {spot_puzzle.get('date')}, not {day}")
    cities = station.load_cities(config_dir)
    reports = iem.fetch_cli(day)
    asos = iem.fetch_daily(day)
    used = station.used_before(day, len(cities), earlier)
    return station.build_puzzle(day, cities, reports, asos, draft.families_shown(spot_puzzle), area, used)


NAMES = {"spot": "Wx Marks the Spot", "measured": "Modeled or Measured", "station": "Station ID"}


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
