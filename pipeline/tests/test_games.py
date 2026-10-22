"""Wx Marks the Spot's puzzle: station rules, rounds, maps and the daily files (games/)."""

import json
from datetime import date, datetime, timezone

import numpy as np
import pytest

from wxtrend.config import DEFAULT_CONFIG_DIR, load_config
from wxtrend.games import daily, maps, spot
from wxtrend.games.iem import IncompleteData, Station, check_coverage, parse_stations, tidy_name
from wxtrend.games.land import StateOutlines

OUTLINES = StateOutlines()
REGIONS = {r["id"]: r for r in json.loads((DEFAULT_CONFIG_DIR / "regions.json").read_text())["regions"]}
US = REGIONS["us"]
DAY = date(2026, 10, 20)


def station(sid, lat, lon, state="KS", elev=400.0, name=None, asos=True):
    return Station(sid, name or sid, state, lat, lon, elev, asos)


def row(**values):
    return {"tmpf_est": False, "precip_est": False, **values}


def test_tidy_name():
    assert tidy_name("ASHEVILLE_MUNICIPAL_(ASOS)") == "Asheville Municipal"
    assert tidy_name("BURNS MUNI (AMO") == "Burns Muni"
    assert tidy_name("SAN DIEGO/GILLESPIE") == "San Diego/Gillespie"
    assert tidy_name("Manhattan - Wall Street") == "Manhattan - Wall Street"
    assert tidy_name("ALLENTOWN-BETHLEHEM") == "Allentown-Bethlehem"
    assert tidy_name("WILLIAMS AFB/CHANDL") == "Williams AFB/Chandl"
    assert tidy_name("Gila Bend Af Aux") == "Gila Bend AF Aux"
    assert tidy_name("ALBUQUERQUE/DOUBLE EAGLE II APT") == "Albuquerque/Double Eagle II Apt"
    assert tidy_name("BREMERTON NTNL AWOS") == "Bremerton Ntnl"
    assert tidy_name("MCALLEN MILLER INTL") == "McAllen Miller Intl"


def feature(sid, sname, state="CO", online=True, attributes=None):
    return {
        "type": "Feature", "id": sid, "geometry": {"type": "Point", "coordinates": [-106.17, 38.1]},
        "properties": {"sname": sname, "state": state, "elevation": 2385.0, "online": online,
                       "attributes": attributes or {}},
    }


def test_parse_stations_keeps_online_stations_and_flags_awos():
    got = parse_stations({"features": [
        feature("04V", "SAGUACHE MUNI", attributes={"IS_AWOS": "1"}),
        feature("OLD", "SAGUACHE MUNI", online=False),
        feature("TCS", "TRUTH OR CONSEQUENC", state="NM"),
    ]})
    assert list(got) == ["04V", "TCS"]
    assert got["04V"] == Station("04V", "Saguache Muni", "CO", 38.1, -106.17, 2385.0, False)
    assert got["TCS"].name == "Truth or Consequences" and got["TCS"].asos  # cut off at 19 characters by IEM


def test_coverage_catches_a_state_iem_hasnt_summarized():
    stations = {f"K{i}": station(f"K{i}", 38.9, -100.0) for i in range(10)} | {"N1": station("N1", 41, -99, "NE")}
    rows = {s: row() for s in stations}
    check_coverage(DAY, stations, rows)
    check_coverage(DAY, stations, {s: r for s, r in rows.items() if s not in ("K0", "K1")})  # 8 of 10 will do
    with pytest.raises(IncompleteData, match="KS 7/10"):
        check_coverage(DAY, stations, {s: r for s, r in rows.items() if s not in ("K0", "K1", "K2")})
    with pytest.raises(IncompleteData, match="NE 0/1"):
        check_coverage(DAY, stations, {s: r for s, r in rows.items() if s != "N1"})


def test_default_day_waits_for_the_day_to_end_in_the_west():
    assert daily.default_day(datetime(2026, 10, 21, 10, 30, tzinfo=timezone.utc)) == DAY
    # 06Z on the 21st is still the 20th in California
    assert daily.default_day(datetime(2026, 10, 21, 6, 0, tzinfo=timezone.utc)) == date(2026, 10, 19)


@pytest.mark.parametrize(("lon", "lat", "slack", "state"), [
    (-97.43, 37.65, 0, "KS"),  # Wichita
    (-104.67, 39.86, 0, "CO"),  # Denver
    (-94.5466, 29.1302, 12, None),  # Galveston 209B, a platform 37 km out
    (-91.667, 28.196, 12, None),  # Eugene Island 338K
    (-81.689, 24.576, 12, "FL"),  # Key West NAS, 10 km beyond the simplified outline
    (-80.0, 30.0, 12, None),  # the Atlantic
])
def test_state_at(lon, lat, slack, state):
    assert OUTLINES.state_at(lon, lat, slack) == state


def test_summits_need_to_stand_far_above_their_neighbours():
    stations = {
        "MWN": station("MWN", 44.27, -71.30, "NH", 1910, "Mount Washington"),
        "BML": station("BML", 44.58, -71.18, "NH", 353, "Berlin Municipal"),
        "HIE": station("HIE", 44.37, -71.55, "NH", 319, "Whitefield"),
        # Denver among Front Range neighbours: high, but not above them
        "DEN": station("DEN", 39.86, -104.67, "CO", 1640, "Denver Intl"),
        "APA": station("APA", 39.57, -104.85, "CO", 1793, "Centennial"),
        "BJC": station("BJC", 39.91, -105.12, "CO", 1724, "Broomfield"),
        # Named like a summit, but level with its neighbours
        "MVN": station("MVN", 38.32, -88.86, "IL", 146, "Mount Vernon"),
        "CUL": station("CUL", 38.09, -88.12, "IL", 130, "Carmi"),
    }
    assert spot.summits(stations) == {"MWN"}


def test_neighbours_reach_150_km_in_the_far_north():
    # 2.02° of longitude at 48.9°N is about 148 km, and these two sit two 2° cells apart
    stations = {"A": station("A", 48.9, -100.01, "ND"), "B": station("B", 48.9, -97.99, "ND")}
    assert spot.haversine_km(48.9, -100.01, 48.9, -97.99) < 150
    assert spot.neighbours(stations, 150) == {"A": ["B"], "B": ["A"]}


def kansas(n=6):
    """n ASOS stations along I-70, 40 km apart: everyone's neighbours."""
    return {f"K{i}": station(f"K{i}", 38.9, -100.0 + 0.46 * i) for i in range(n)}


def test_a_value_its_neighbours_dont_back_up_is_left_out():
    stations = kansas()
    today = {s: row(max_tmpf=80.0 + i, max_gust=30.0) for i, s in enumerate(stations)}
    today["K2"] = row(max_tmpf=81.0, max_gust=181.0)  # a broken anemometer
    near = spot.neighbours(stations, spot.NEIGHBOUR_KM)
    gusts = spot.round_values(spot.KINDS["gust"], stations, near, today, {})
    assert "K2" not in gusts and len(gusts) == 5
    highs = spot.round_values(spot.KINDS["hottest"], stations, near, today, {})
    assert set(highs) == set(stations)


def test_one_bad_neighbour_cant_vouch_for_another():
    stations = kansas()
    today = {s: row(min_tmpf=40.0) for s in stations}
    today["K2"] = row(min_tmpf=4.0)
    today["K3"] = row(min_tmpf=6.0)  # a second bad sensor beside it
    near = spot.neighbours(stations, spot.NEIGHBOUR_KM)
    lows = spot.round_values(spot.KINDS["coldest"], stations, near, today, {})
    assert "K2" not in lows and "K3" not in lows


def test_awos_stations_back_others_up_but_arent_answers():
    stations = kansas(3) | {"AW": station("AW", 38.9, -99.0, asos=False)}
    today = {s: row(max_tmpf=70.0) for s in stations} | {"AW": row(max_tmpf=95.0)}
    near = spot.neighbours(stations, spot.NEIGHBOUR_KM)
    highs = spot.round_values(spot.KINDS["hottest"], stations, near, today, {})
    assert "AW" not in highs and set(highs) == {"K0", "K1", "K2"}


def test_values_are_rounded_as_players_see_them():
    stations = kansas(3)
    today = {"K0": row(max_tmpf=80.4), "K1": row(max_tmpf=79.6), "K2": row(max_tmpf=78.2)}
    near = spot.neighbours(stations, spot.NEIGHBOUR_KM)
    assert spot.round_values(spot.KINDS["hottest"], stations, near, today, {}) == {"K0": 80.0, "K1": 80.0, "K2": 78.0}


def test_every_round_is_the_lower_48_and_the_swing_alternates():
    assert spot.plan_rounds(DAY) == ["hottest", "coldest", "gust", "wettest", "cooldown"]
    assert spot.plan_rounds(date(2026, 10, 21))[4] == "warmup"


def puzzle_for(today, before=None, stations=None, day=DAY):
    return spot.build_puzzle(day, stations or kansas(), today, before or {}, US, OUTLINES,
                             made=datetime(2026, 10, 21, 10, 30, tzinfo=timezone.utc))


def full_rows(stations, precip=0.5):
    return {s: row(max_tmpf=70.0 + i, min_tmpf=40.0 - i, max_gust=20.0 + i, precip=precip * (i + 1) / 6,
                   max_dwpf=50.0 + i) for i, s in enumerate(stations)}


@pytest.fixture
def few_stations(monkeypatch):
    monkeypatch.setattr(spot, "MIN_STATIONS", 3)


def test_build_puzzle(few_stations):
    stations = kansas()
    today = full_rows(stations)
    today["K4"]["max_tmpf"] = 75.0  # tied with K5 for the top
    before = {s: row(max_tmpf=80.0) for s in stations}
    p = puzzle_for(today, before, stations)
    assert (p["v"], p["game"], p["date"], p["number"], p["made"]) == (2, "spot", "2026-10-20", 20, "2026-10-21T10:30:00Z")
    assert p["area"] == {"id": "us", "label": "Mainland US", "lat": [23, 51], "lon": [-126, -66]}
    assert p["scoring"]["value"] + p["scoring"]["distance"] == 1000
    assert [r["kind"] for r in p["rounds"]] == ["hottest", "coldest", "gust", "wettest", "cooldown"]
    names = [s[0] for s in p["stations"]]
    hot, cold, gust, wet, swing = p["rounds"]
    assert hot["best"] == 75 and [names[i] for i in hot["top"]] == ["K4", "K5"]
    assert hot["floor"] == 72  # the median of 70, 71, 72, 73, 75, 75
    assert [names[i] for i in cold["top"]] == ["K5"] and cold["best"] == 35
    assert gust["best"] == 25 and gust["unit"] == "kt"
    assert swing["best"] == -10 and [names[i] for i in swing["top"]] == ["K0"]  # K0: 70 after 80
    assert wet["decimals"] == 2 and wet["best"] == 0.5
    assert len(hot["i"]) == len(hot["v"]) == 6


def test_a_dry_day_asks_for_the_highest_dew_point(few_stations):
    stations = kansas()
    before = {s: row(max_tmpf=60.0) for s in stations}
    p = puzzle_for(full_rows(stations, precip=0.05), before, stations, day=date(2026, 10, 21))
    assert p["rounds"][3]["kind"] == "muggiest"


def test_too_few_stations_is_an_error():
    with pytest.raises(ValueError, match="only"):
        puzzle_for(full_rows(kansas()), {})


# ------------------------------------------------------------------ maps

GFS = load_config().product("gfs")


def test_map_grid_covers_the_box_at_half_a_degree():
    g = maps.map_grid(US)
    assert g == {"lat0": 51, "lon0": -126, "dlat": -0.5, "dlon": 0.5, "ny": 57, "nx": 121}
    full = np.arange(GFS.grid.ny * GFS.grid.nx, dtype=float).reshape(GFS.grid.ny, GFS.grid.nx)
    sub = maps.subsample(full, GFS, g)
    assert sub.shape == (57, 121)
    # The corner points land on 51°N, 126°W and 23°N, 66°W of the 0.25° grid
    nx, res = GFS.grid.nx, GFS.grid.resolution
    assert sub[0, 0] == round((GFS.grid.lat_max - 51) / res) * nx + round((-126 - GFS.grid.lon_min) / res)
    assert sub[-1, -1] == round((GFS.grid.lat_max - 23) / res) * nx + round((-66 - GFS.grid.lon_min) / res)


def test_encode_round_trips_and_marks_nodata():
    r = maps.RECIPES["hottest"]
    values = np.array([[71.4, np.nan], [-80.0, 300.0]])
    got = maps.decode(maps.encode(values, r), r.scale, r.offset, (2, 2))
    assert got[0, 0] == 71 and np.isnan(got[0, 1])
    assert got[1, 0] == -60 and got[1, 1] == 194  # clipped to what a byte holds


def test_combine_takes_the_day_s_extremes():
    one, two = np.array([[50.0, 60.0]]), np.array([[55.0, 52.0]])
    assert maps.combine(maps.RECIPES["hottest"], {(18, 0): one, (24, 0): two}).tolist() == [[55, 60]]
    assert maps.combine(maps.RECIPES["coldest"], {(6, 0): one, (12, 0): two}).tolist() == [[50, 52]]
    rain = {(h, 6): np.array([[0.1, 0.0]]) for h in (6, 12, 18, 24)}
    assert maps.combine(maps.RECIPES["wettest"], rain).tolist() == [[pytest.approx(0.4), 0.0]]
    swing = {(18, 0): one, (24, 0): two, (-6, 0): np.array([[60.0, 61.0]]), (0, 0): np.array([[40.0, 70.0]])}
    assert maps.combine(maps.RECIPES["cooldown"], swing).tolist() == [[-5, -10]]


def test_make_maps_fetches_each_frame_once_and_skips_a_kind_it_cant_finish():
    calls = []

    def fetch(init, fhr, fields):
        calls.append((init.strftime("%Y%m%d%H"), fhr, tuple(fields)))
        if init.hour == 6 and fhr == 6:
            raise RuntimeError("not on AWS")
        shape = (GFS.grid.ny, GFS.grid.nx)
        return {f: {b: np.full(shape, 1.0)
                    for b in {"t2m": ["temp"], "gust": ["gust"], "d2m": ["dewpt"], "precip": ["qpf", "ptype"]}[f]}
                for f in fields}

    got = maps.make_maps(DAY, ["hottest", "gust", "wettest", "cooldown"], US, GFS, fetch)
    assert sorted(got) == ["cooldown", "gust", "hottest"]  # the rain needs the 06Z run's f006
    assert ("2026102018", 0, ("gust", "t2m")) in calls and len(calls) == len(set(calls))
    assert ("2026101918", 0, ("t2m",)) in calls  # the day before's afternoon, for the cool-down
    hot = got["hottest"]
    assert hot["link"] == {"m": "gfs", "v": "t2m", "var": "temp", "run": "2026102100", "t": "2026102100"}
    assert maps.decode(hot["data"], hot["scale"], hot["offset"], (57, 121)).max() == 1


# ------------------------------------------------------------------ daily files

def test_write_never_moves_latest_back(tmp_path):
    new = {"game": "spot", "date": "2026-10-20", "rounds": []}
    old = {"game": "spot", "date": "2026-10-19", "rounds": []}
    assert daily.write(tmp_path, new) == ["2026-10-20.json", "latest.json"]
    assert daily.write(tmp_path, old) == ["2026-10-19.json"]
    root = tmp_path / "games" / "spot"
    assert json.loads((root / "latest.json").read_text())["date"] == "2026-10-20"
    assert json.loads((root / "2026-10-19.json").read_text())["date"] == "2026-10-19"


class FakeRemote:
    def __init__(self):
        self.objects = {}

    def read_json(self, rel):
        return json.loads(self.objects[rel]) if rel in self.objects else None

    def put_json(self, rel, payload):
        self.objects[rel] = payload


def test_publish_writes_the_day_before_latest():
    remote = FakeRemote()
    assert daily.publish({"game": "spot", "date": "2026-10-20"}, remote) == ["2026-10-20.json", "latest.json"]
    assert list(remote.objects) == ["2026-10-20.json", "latest.json"]
    assert daily.publish({"game": "spot", "date": "2026-10-18"}, remote) == ["2026-10-18.json"]
    assert remote.read_json("latest.json")["date"] == "2026-10-20"


def cli_remote(monkeypatch, tmp_path, objects):
    from wxtrend import cli

    remote = FakeRemote()
    remote.objects.update(objects)
    monkeypatch.setattr(cli.R2Store, "from_env", classmethod(lambda cls, prefix: remote))
    return cli, remote


def never(*a, **k):
    raise AssertionError("fetched a day R2 already has")


ARGS = ["game", "spot", "--date", "2026-10-20", "--publish", "--now", "2026-10-21T10:30:00Z"]


def test_the_cli_leaves_a_published_day_alone(monkeypatch, tmp_path):
    cli, remote = cli_remote(monkeypatch, tmp_path, {"2026-10-20.json": b'{"date": "2026-10-20"}',
                                                     "latest.json": b'{"date": "2026-10-20"}'})
    monkeypatch.setattr(daily, "make_spot", never)
    assert cli.main(["--data-dir", str(tmp_path)] + ARGS) == 0

    made = {"game": "spot", "date": "2026-10-20", "number": 20, "rounds": [], "stations": []}
    monkeypatch.setattr(daily, "make_spot", lambda day, area, **k: made)
    monkeypatch.setattr(daily, "summary", lambda p: "ok")
    assert cli.main(["--data-dir", str(tmp_path)] + ARGS + ["--replace"]) == 0
    assert json.loads(remote.objects["2026-10-20.json"])["number"] == 20
    assert (tmp_path / "games" / "spot" / "latest.json").exists()


def test_a_published_day_catches_latest_up(monkeypatch, tmp_path):
    # The run that uploaded the 20th died before latest.json
    day = {"game": "spot", "date": "2026-10-20", "number": 20}
    cli, remote = cli_remote(monkeypatch, tmp_path, {"2026-10-20.json": json.dumps(day).encode(),
                                                     "latest.json": b'{"date": "2026-10-19"}'})
    monkeypatch.setattr(daily, "make_spot", never)
    assert cli.main(["--data-dir", str(tmp_path)] + ARGS) == 0
    assert remote.read_json("latest.json") == day


def test_the_cli_refuses_a_day_that_hasnt_ended(monkeypatch, tmp_path):
    cli, remote = cli_remote(monkeypatch, tmp_path, {})
    monkeypatch.setattr(daily, "make_spot", never)
    # 06Z on the 21st: the 20th hasn't ended in California
    assert cli.main(["--data-dir", str(tmp_path), "game", "spot", "--date", "2026-10-20",
                     "--now", "2026-10-21T06:00:00Z"]) == 1
    assert not remote.objects
