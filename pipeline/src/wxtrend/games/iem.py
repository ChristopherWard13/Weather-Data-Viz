"""Daily station summaries from the Iowa Environmental Mesonet (IEM).

IEM summarizes every ASOS/AWOS station's METARs by local calendar day
(``api/1/daily.json``) and publishes each state network's station list
(``geojson/network/<ST>_ASOS.geojson``). Its data "may be used freely by anyone
for any lawful purpose" (checked 2026-10-21); attribution is appreciated, so the
games credit it. Units as IEM gives them: °F, inches, and knots for gusts.
Summaries exist for the current, unfinished day too, so callers ask only for
days that have ended.

IEM is an academic service: one request per state at a time, a few at once.
"""

from __future__ import annotations

import logging
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, timedelta

import requests

from ..net import retrying_session

log = logging.getLogger(__name__)

IEM = "https://mesonet.agron.iastate.edu"
CREDIT = {"text": "NWS ASOS observations via the Iowa Environmental Mesonet", "url": IEM + "/"}

LOWER_48 = (
    "AL AZ AR CA CO CT DE FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND "
    "OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY"
).split()
# DC's airports (DCA) are in the Virginia and Maryland networks
WORKERS = 4
# A day's summaries must cover this share of each state's online stations (a
# normal day covers all of them), or the puzzle would quietly miss a state
MIN_COVERAGE = 0.8

# Kept in capitals however IEM writes them
ABBREVIATIONS = {"AF", "AFB", "AAF", "ANGB", "ARB", "MCAS", "NAF", "NAS", "NAWS", "II", "III"}
# IEM's names cut off at 19 characters, or misspelled, for stations that have been answers
NAME_FIXES = {
    "BAB": "Beale AFB",
    "BVO": "Bartlesville",
    "IWA": "Phoenix-Mesa Gateway",
    "P33": "Willcox",
    "TCS": "Truth or Consequences",
}


class IncompleteData(RuntimeError):
    """IEM's summaries for a day are missing too many stations to make a fair puzzle."""


@dataclass(frozen=True)
class Station:
    id: str
    name: str
    state: str
    lat: float
    lon: float
    elev: float  # metres
    asos: bool  # False for AWOS, which IEM flags with IS_AWOS


def tidy_name(raw: str) -> str:
    """'ASHEVILLE_MUNICIPAL_(ASOS)' → 'Asheville Municipal'; 'ALLENTOWN-BETHLEHEM' →
    'Allentown-Bethlehem'; 'Gila Bend Af Aux' → 'Gila Bend AF Aux'."""
    name = raw.replace("_", " ")
    name = re.sub(r"\([^)]*\)?", " ", name)  # parentheticals, closed or cut off
    name = re.sub(r"\b(?:ASOS|AWOS)\b", " ", name, flags=re.I)
    name = re.sub(r"\s+", " ", name).strip(" -/")
    capitals = name.isupper()

    def word(m: re.Match) -> str:
        w = m.group(0)
        if w.upper() in ABBREVIATIONS:
            return w.upper()
        if not capitals:
            return w
        w = w.capitalize()
        return "Mc" + w[2:].capitalize() if w.startswith("Mc") and len(w) > 2 else w

    return re.sub(r"[A-Za-z]+", word, name) or raw


def parse_stations(geojson: dict) -> dict[str, Station]:
    """A network's online stations."""
    out = {}
    for f in geojson.get("features", []):
        p = f["properties"]
        if not p.get("online"):
            continue
        lon, lat = f["geometry"]["coordinates"]
        out[f["id"]] = Station(
            id=f["id"], name=NAME_FIXES.get(f["id"]) or tidy_name(p.get("sname") or f["id"]), state=p.get("state") or "",
            lat=float(lat), lon=float(lon), elev=float(p.get("elevation") or 0.0),
            asos=(p.get("attributes") or {}).get("IS_AWOS") != "1",
        )
    return out


def _get_json(session: requests.Session, url: str) -> dict:
    r = session.get(url, timeout=60)
    r.raise_for_status()
    return r.json()


def fetch_stations(session: requests.Session | None = None, states=LOWER_48) -> dict[str, Station]:
    session = session or retrying_session(WORKERS)

    def one(st: str) -> dict[str, Station]:
        return parse_stations(_get_json(session, f"{IEM}/geojson/network/{st}_ASOS.geojson"))

    out: dict[str, Station] = {}
    with ThreadPoolExecutor(WORKERS) as pool:
        for part in pool.map(one, states):
            out.update(part)
    log.info("%d online stations in %d networks", len(out), len(states))
    return out


def fetch_daily(day: date, session: requests.Session | None = None, states=LOWER_48) -> dict[str, dict]:
    """Each station's summary for one local calendar day, by station id."""
    session = session or retrying_session(WORKERS)

    def one(st: str) -> list[dict]:
        return _get_json(session, f"{IEM}/api/1/daily.json?network={st}_ASOS&date={day.isoformat()}")["data"]

    out: dict[str, dict] = {}
    with ThreadPoolExecutor(WORKERS) as pool:
        for rows in pool.map(one, states):
            for row in rows:
                if row.get("date") == day.isoformat():
                    out[row["station"]] = row
    log.info("%s: summaries for %d stations", day, len(out))
    return out


def fetch_cli(day: date, session: requests.Session | None = None) -> dict[str, dict]:
    """The NWS daily climate reports (CLI) for one day, by station id ("KDEN"), as IEM parses them.

    One request covers every site (about 600 in the Lower 48). Reports keep
    local standard time all year, and give the day's normals, records and
    departures. A site's report for the day is usually out by 08Z; some come
    hours later (Knoxville's for 2026-10-22 at 14:37Z).

    Many sites also send an afternoon report ("as of 5 PM") with the same
    date, and IEM lists it until the day's own report replaces it. Its low,
    rain, wind and times stop at 5 PM, so only reports issued after local
    standard midnight count: from 04Z the next day (midnight in the East is
    05Z; afternoon reports are out by about 03Z)."""
    session = session or retrying_session(WORKERS)
    features = _get_json(session, f"{IEM}/geojson/cli.py?dt={day.isoformat()}")["features"]
    return whole_day(day, [f["properties"] for f in features])


def whole_day(day: date, reports: list[dict]) -> dict[str, dict]:
    """The reports that cover all of ``day``, by station: issued (the product id's
    YYYYMMDDHHMM) from 04Z the next day."""
    after = (day + timedelta(days=1)).strftime("%Y%m%d") + "0400"
    out = {r["station"]: r for r in reports
           if r.get("valid") == day.isoformat() and str(r.get("product", ""))[:12] >= after}
    log.info("%s: whole-day climate reports for %d sites (%d listed)", day, len(out), len(reports))
    return out


def check_coverage(day: date, stations: dict[str, Station], rows: dict[str, dict], states=LOWER_48) -> None:
    """Raise IncompleteData if any state's summaries miss more than a fifth of its online stations.

    IEM answers a state it hasn't summarized yet with an empty list, not an
    error; a puzzle made from it would leave the state out, and a published day
    is never remade on its own."""
    online: dict[str, int] = {}
    have: dict[str, int] = {}
    for s, st in stations.items():
        online[st.state] = online.get(st.state, 0) + 1
        have[st.state] = have.get(st.state, 0) + (s in rows)
    short = [f"{st} {have.get(st, 0)}/{online[st]}" for st in states
             if online.get(st) and have.get(st, 0) < MIN_COVERAGE * online[st]]
    if short:
        raise IncompleteData(f"{day}: IEM's summaries are missing stations in {', '.join(short)}")
