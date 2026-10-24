"""Beat the Models (games/beat.py, games/highs.py): the climate day, the lock, each model's high, the
city, and the day's three files."""

import json
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pytest

from wxtrend import cli
from wxtrend.config import DEFAULT_CONFIG_DIR
from wxtrend.games import beat, daily, highs, station

from .test_games import FakeRemote

UTC = timezone.utc
REGIONS = json.loads((DEFAULT_CONFIG_DIR / "regions.json").read_text())["regions"]


def at(*a):
    return datetime(*a, tzinfo=UTC)


# ------------------------------------------------------------------ the climate day and the lock


def test_the_climate_day_keeps_standard_time_all_year():
    # Denver: MST is UTC-7, in summer and winter alike
    assert beat.climate_day("America/Denver", date(2026, 10, 27)) == (at(2026, 10, 27, 7), at(2026, 10, 28, 7))
    assert beat.climate_day("America/Denver", date(2026, 12, 1)) == (at(2026, 12, 1, 7), at(2026, 12, 2, 7))
    # Phoenix keeps MST and no summer time; New York is UTC-5
    assert beat.climate_day("America/Phoenix", date(2026, 7, 1))[0] == at(2026, 7, 1, 7)
    assert beat.climate_day("America/New_York", date(2026, 7, 1))[0] == at(2026, 7, 1, 5)


def test_the_lock_is_midnight_on_the_city_s_clock():
    assert beat.lock_time("America/New_York", date(2026, 10, 27)) == at(2026, 10, 27, 4)  # EDT
    assert beat.lock_time("America/New_York", date(2026, 11, 2)) == at(2026, 11, 2, 5)  # EST from Nov 1
    assert beat.lock_time("America/Los_Angeles", date(2026, 10, 27)) == at(2026, 10, 27, 7)
    assert beat.lock_time("America/Phoenix", date(2026, 10, 27)) == at(2026, 10, 27, 7)
    # Summer's lock is an hour before the report's day starts; winter's, at its start
    assert beat.lock_time("America/Chicago", date(2026, 7, 1)) < beat.climate_day("America/Chicago", date(2026, 7, 1))[0]
    assert beat.lock_time("America/Chicago", date(2026, 1, 5)) == beat.climate_day("America/Chicago", date(2026, 1, 5))[0]


def test_the_map_time_is_the_6_hourly_time_nearest_the_afternoon():
    assert beat.map_time("America/New_York", date(2026, 10, 27)) == "2026102718"  # 3 p.m. EST is 20Z
    assert beat.map_time("America/Chicago", date(2026, 10, 27)) == "2026102800"  # 21Z: a tie goes later
    assert beat.map_time("America/Los_Angeles", date(2026, 10, 27)) == "2026102800"


def test_whole_degrees_round_halves_away_from_zero():
    assert [beat.whole(x) for x in (71.5, 71.49, -3.5, -3.4, 0.0)] == [72, 71, -4, -3, 0]


def test_points():
    assert [beat.points(70, 70 + d) for d in (0, 1, -2, 4, 5, 12)] == [100, 80, 60, 20, 0, 0]


# ------------------------------------------------------------------ each model's high


def test_each_schedule_s_messages():
    gfs = highs.pieces(highs.SCHEDULES["gfs"], 13)
    assert highs.Piece("max", 6, 7) in gfs and highs.Piece("max", 12, 13) in gfs and highs.Piece("max", 6, 12) in gfs
    gefs = highs.pieces(highs.SCHEDULES["gefs"], 18)
    assert {p for p in gefs if p.kind == "max"} == {highs.Piece("max", a, b)
                                                     for a, b in ((0, 3), (0, 6), (6, 9), (6, 12), (12, 15), (12, 18))}
    ecmwf = highs.pieces(highs.SCHEDULES["ecmwf"], 9)
    assert {p for p in ecmwf if p.kind == "max"} == {highs.Piece("max", 0, 3), highs.Piece("max", 3, 6),
                                                      highs.Piece("max", 6, 9)}
    assert not any(p.kind == "max" for p in highs.pieces(highs.SCHEDULES["gdps"], 24))


def test_a_day_s_messages_are_the_longest_windows_inside_it_and_the_hours_left():
    # GFS from 18Z, Eastern climate day 05Z-05Z: hours 11-35
    got = highs.choose(highs.pieces(highs.SCHEDULES["gfs"]), 11, 35)
    assert [p for p in got if p.kind == "max"] == [highs.Piece("max", 12, 18), highs.Piece("max", 18, 24),
                                                   highs.Piece("max", 24, 30), highs.Piece("max", 30, 35)]
    # 11 and 12 aren't covered: a window covers the hours after its start
    assert [p.end for p in got if p.kind == "inst"] == [11, 12]
    # ECMWF from 12Z, the same day (hours 17-41): 3-hour windows to 39, then nothing past it
    got = highs.choose(highs.pieces(highs.SCHEDULES["ecmwf"]), 17, 41)
    assert [(p.start, p.end) for p in got if p.kind == "max"] == [(h, h + 3) for h in range(18, 39, 3)]
    assert [p.end for p in got if p.kind == "inst"] == [18]
    # GEM: every hour of the day
    got = highs.choose(highs.pieces(highs.SCHEDULES["gdps"]), 17, 41)
    assert [p.end for p in got] == list(range(17, 42))


def test_nothing_outside_the_day_counts():
    for model in highs.MODELS:
        for start in range(0, 30):
            for p in highs.choose(highs.pieces(highs.SCHEDULES[model], 80), start, start + 24):
                assert start <= p.start and p.end <= start + 24, (model, start, p)


def test_the_run_out_at_a_time():
    gfs = highs.Model("gfs", "GFS", 6, timedelta(minutes=331))
    assert gfs.run_at(at(2026, 10, 27, 4)) == at(2026, 10, 26, 18)
    assert gfs.run_at(at(2026, 10, 27, 5, 31)) == at(2026, 10, 27, 0)
    ecmwf = highs.Model("ecmwf", "ECMWF", 12, timedelta(minutes=456))
    assert ecmwf.run_at(at(2026, 10, 27, 7)) == at(2026, 10, 26, 12)
    assert ecmwf.run_at(at(2026, 10, 27, 8)) == at(2026, 10, 27, 0)


def test_the_five_models_come_from_the_config():
    models = highs.load_models(DEFAULT_CONFIG_DIR)
    assert [m.id for m in models] == list(highs.MODELS)
    assert [m.name for m in models] == ["GFS", "GEFS mean", "ECMWF", "ICON", "GEM"]
    assert all(m.cycle_hours in (6, 12) and m.latency > timedelta(hours=2) for m in models)


@pytest.mark.parametrize("lat_order, lon0", [(-1, 0.0), (1, 0.0), (-1, -180.0)])
def test_bilinear_is_exact_for_a_linear_field(lat_order, lon0):
    lats = np.arange(90, -90.1, -0.25)[::lat_order]
    lons = lon0 + 0.25 * np.arange(1440)
    lon2 = (lons + 180) % 360 - 180  # the field is linear in -180..180 longitude near the points
    field = 2.0 * lats[:, None] + 0.5 * lon2[None, :]
    plat, plon = np.array([39.85, 33.63, 47.44]), np.array([-104.66, -84.44, -122.31])
    assert np.allclose(highs.bilinear(field, lats, lons, plat, plon), 2 * plat + 0.5 * plon)


def test_bilinear_wraps_around_the_globe():
    lats = np.array([10.0, 0.0])
    lons = np.arange(0, 360, 90.0)
    field = np.tile(np.array([0.0, 1.0, 2.0, 3.0]), (2, 1))
    # Halfway from 270°E back to 0°E
    assert highs.bilinear(field, lats, lons, np.array([5.0]), np.array([-45.0]))[0] == pytest.approx(1.5)


def test_icon_s_cells_interpolate_linear_fields_exactly():
    rng = np.random.default_rng(1)
    clat = rng.uniform(20, 55, 20000)
    clon = rng.uniform(-130, -60, 20000)
    plat, plon = np.array([39.85, 33.63]), np.array([-104.66, -84.44])
    cells = highs.Cells(clat, clon, plat, plon)
    assert np.allclose(cells.apply(3 * clat - clon), 3 * plat - plon)


def test_temperatures_in_kelvin_or_celsius():
    assert highs.to_fahrenheit(np.array([273.15]), "K")[0] == pytest.approx(32)
    assert highs.to_fahrenheit(np.array([100.0]), "C")[0] == pytest.approx(212)
    with pytest.raises(ValueError):
        highs.to_fahrenheit(np.array([1.0]), "F")


def test_a_source_s_high_is_moved_to_the_airport_and_left_unrounded(monkeypatch):
    src = highs.Source(MODELS[0])
    got = {}

    def values(init, wanted, plat, plon):
        got["wanted"] = wanted
        return {p: np.array([1500.0]) if p == highs.GROUND else np.array([71.46]) for p in wanted}

    monkeypatch.setattr(src, "values", values)
    (h,) = src.highs(at(2026, 10, 27), [highs.Place(39.8, -104.7, 1000.0, at(2026, 10, 27, 7), at(2026, 10, 28, 7))])
    # 500 m below the model's ground: 6.5 °C a km warmer, 5.85 °F
    assert h.value == pytest.approx(71.46 + 5.85) and h.ground == 1500
    assert got["wanted"][-1] == highs.GROUND


class FakeSource:
    """Highs by place index: fixed values, or an error."""

    def __init__(self, values=None, error=None):
        self.values, self.error, self.calls = values, error, []

    def highs(self, init, places):
        self.calls.append((init, places))
        if self.error:
            raise self.error
        return [highs.High(self.values[k % len(self.values)], 1500) for k in range(len(places))]


# ------------------------------------------------------------------ the city and the files

MODELS = highs.load_models(DEFAULT_CONFIG_DIR)


def cities(n=6):
    return [{"id": f"K{i:03d}", "city": f"City {i}", "state": "CO" if i % 2 else "GA", "station": f"CITY {i}",
             "lat": 30 + i, "lon": -100 + i, "elev": 100, "tz": "America/Denver" if i % 2 else "America/New_York"}
            for i in range(n)]


def test_spreads_need_three_models():
    cs = cities(3)
    H = lambda v: None if v is None else highs.High(v, 0)  # noqa: E731
    calls = {"gfs": [H(70), H(70), H(70)], "ecmwf": [H(75), None, H(71.5)], "gdps": [H(65), None, H(70)]}
    assert beat.spreads(date(2026, 10, 27), cs, calls) == [10, None, 1.5]


def test_the_city_is_drawn_from_the_widest_tenth_by_the_date():
    cs = [dict(c, id=f"K{i:03d}") for i, c in enumerate(cities(1) * 40)]
    spread = [float(i % 20) for i in range(40)]  # two cities each of 0 to 19
    picks = {beat.pick_city(date(2026, 10, 1) + timedelta(days=d), cs, spread, set()) for d in range(40)}
    # The widest tenth: the four cities at 19 and 18
    assert picks == {19, 39, 18, 38}
    # Avoided cities are left out before the tenth is taken
    picks = {beat.pick_city(date(2026, 10, 1) + timedelta(days=d), cs, spread, {"K019", "K039"}) for d in range(40)}
    assert picks <= {18, 38, 17, 37} and len(picks) > 1
    assert beat.pick_city(date(2026, 10, 27), cs[:3], [3, 9, None], set()) == 1
    with pytest.raises(ValueError):
        beat.pick_city(date(2026, 10, 27), cs[:4], [None] * 4, set())


def test_recent_cities_come_from_the_latest_puzzle():
    puzzles = {date(2026, 10, 26): {"city": {"id": "KAAA"}, "recent": [f"K{i:03d}" for i in range(40)]}}
    got = beat.recent_cities(date(2026, 10, 27), puzzles.get)
    assert len(got) == beat.REPEAT_DAYS and got[-1] == "KAAA"
    # Two days back: one day fewer of them
    assert len(beat.recent_cities(date(2026, 10, 28), puzzles.get)) == beat.REPEAT_DAYS - 1
    assert beat.recent_cities(date(2026, 11, 20), puzzles.get) == []


def test_the_city_list_has_time_zones():
    cs = station.load_cities(DEFAULT_CONFIG_DIR)
    assert all(c["tz"].startswith("America/") for c in cs)
    assert {c["tz"] for c in cs if c["state"] == "AZ"} == {"America/Phoenix"}


def puzzle_for(day=date(2026, 10, 27), k=1):
    cs = cities()
    return beat.build_puzzle(day, cs, k, MODELS, REGIONS, [(day - timedelta(days=3), {"high": 61, "high_normal": 64}),
                                                           (day - timedelta(days=2), None)],
                             ["K000"], 7.25, made=at(2026, 10, 26, 10, 30))


def test_the_puzzle():
    p = puzzle_for()
    assert p["number"] == 1 and p["date"] == "2026-10-27"
    assert p["city"] == {"id": "K001", "city": "City 1", "state": "CO", "station": "CITY 1", "lat": 31, "lon": -99,
                         "elev": 100, "tz": "America/Denver", "region": "southwest"}
    assert p["lock"] == "2026-10-27T06:00:00Z" and p["day"] == ["2026-10-27T07:00:00Z", "2026-10-28T07:00:00Z"]
    assert [m["id"] for m in p["models"]] == list(highs.MODELS)
    assert p["context"] == [{"date": "2026-10-24", "high": 61, "normal": 64}, {"date": "2026-10-25", "high": None, "normal": None}]
    assert p["spread"] == 7.2 and p["recent"] == ["K000"]
    assert p["rules"] == {"points": 100, "per_degree": 20, "bust": 5}


def test_the_models_calls_come_from_each_run_out_at_the_lock():
    p = puzzle_for()
    sources = {m.id: FakeSource([71.46 + i]) for i, m in enumerate(MODELS)}
    sources["icon"] = FakeSource(error=RuntimeError("gone"))
    calls, missing = beat.models_at_lock(p, MODELS, sources)
    assert [c["id"] for c in calls] == ["gfs", "gefs", "ecmwf", "gdps"]
    assert len(missing) == 1 and missing[0].startswith("ICON's run 2026102700 couldn't be read: gone")
    # The call rounds the unrounded high: 71.46 is 71, though it shows as 71.5
    assert [c["call"] for c in calls] == [71, 72, 73, 75]
    assert calls[0]["high"] == 71.5
    # Denver's lock is 06Z: GFS's 00Z run (out at 05:31Z), ECMWF's 12Z from the day before
    assert calls[0]["run"] == "2026102700" and calls[2]["run"] == "2026102612"
    init, places = sources["gfs"].calls[0]
    assert (places[0].start, places[0].end, places[0].elev) == (at(2026, 10, 27, 7), at(2026, 10, 28, 7), 100)
    assert calls[0]["ground"] == 1500
    assert calls[0]["lead"] == 22  # to 3 p.m. MST
    made = beat.build_models(p, calls, made=at(2026, 10, 27, 10, 30))
    assert made["city"]["id"] == "K001" and len(made["models"]) == 4
    with pytest.raises(ValueError, match="need 3"):
        beat.build_models(p, calls[:2])


def test_the_verdict():
    p = puzzle_for()
    m = beat.build_models(p, [{"id": "gfs", "call": 70}, {"id": "gefs", "call": 72}, {"id": "ecmwf", "call": 75}])
    r = beat.build_result(p, m, {"high": 73, "high_normal": 64})
    assert r["high"] == 73 and r["void"] is False and len(r["models"]) == 3
    v = beat.build_result(p, m, None, void=True)
    assert v["high"] is None and v["void"] is True
    with pytest.raises(ValueError):
        beat.build_result(p, m, {"high": "M"})


# ------------------------------------------------------------------ the day's run


class Files(daily.GameFiles):
    def __init__(self, tmp_path, game, objects=None):
        remote = FakeRemote()
        remote.objects.update({k: json.dumps(v) for k, v in (objects or {}).items()})
        super().__init__(tmp_path, game, remote)


def fake_world(monkeypatch, reports):
    """Five fake models (GFS warmest) and IEM's reports by day."""
    monkeypatch.setattr(highs, "Source", lambda m, config_dir=None: FakeSource([60 + 3 * highs.MODELS.index(m.id) + k % 4
                                                                                for k in range(7)]))
    monkeypatch.setattr(daily.iem, "fetch_cli", lambda d: reports.get(d, {}))


def station_puzzle(answer_id):
    return {"cities": [[answer_id, "X", "CO", "X", 0, 0]], "answer": 0}


def test_a_day_s_run_makes_the_verdict_the_lock_and_the_next_puzzle(monkeypatch, tmp_path):
    newest = date(2026, 10, 27)
    cs = station.load_cities(DEFAULT_CONFIG_DIR)
    first = next(c for c in cs if c["tz"] == "America/Denver")
    p_newest = beat.build_puzzle(newest, cs, cs.index(first), MODELS, REGIONS, [], [], 4.0)
    p_next = beat.build_puzzle(newest + timedelta(days=1), cs, 0, MODELS, REGIONS, [], [first["id"]], 4.0)
    files = Files(tmp_path, "beat", {"2026-10-27.json": p_newest, "2026-10-28.json": p_next, "latest.json": p_next})
    sid = Files(tmp_path, "station", {"2026-10-27.json": station_puzzle(cs[5]["id"]),
                                      "2026-10-26.json": station_puzzle(cs[6]["id"])})
    reports = {newest: {first["id"]: {"high": 66, "high_normal": 60}}, newest - timedelta(days=1): {}}
    fake_world(monkeypatch, reports)
    lines, errors = daily.run_beat(newest, files, sid, DEFAULT_CONFIG_DIR, at(2026, 10, 28, 10, 30))
    assert errors == []
    # 1. The newest day's verdict, with its models' calls made on the way (they were missing)
    result = files.read("2026-10-27.result.json")
    assert result["high"] == 66 and len(result["models"]) == 5
    assert files.read("2026-10-27.models.json")["models"] == result["models"]
    # 2. The day that locked at midnight
    assert files.read("2026-10-28.models.json")["city"]["id"] == cs[0]["id"]
    # 3. The day after: not the recent cities, nor Station ID's two answers
    new = files.read("2026-10-29.json")
    assert files.read("latest.json") == new
    assert new["city"]["id"] not in {first["id"], cs[0]["id"], cs[5]["id"], cs[6]["id"]}
    assert new["recent"] == [first["id"], cs[0]["id"]]
    assert len(lines) == 4
    # Run again: everything is there, nothing changes
    before = dict(files.remote.objects)
    assert daily.run_beat(newest, files, sid, DEFAULT_CONFIG_DIR, at(2026, 10, 28, 12, 45)) == ([], [])
    assert files.remote.objects == before


def test_a_late_report_waits_then_voids_the_day(monkeypatch, tmp_path):
    cs = station.load_cities(DEFAULT_CONFIG_DIR)
    day = date(2026, 10, 27)
    p = beat.build_puzzle(day, cs, 0, MODELS, REGIONS, [], [], 4.0)
    files = Files(tmp_path, "beat", {"2026-10-27.json": p})
    sid = Files(tmp_path, "station", {})
    fake_world(monkeypatch, {})
    for k in range(beat.VOID_AFTER_DAYS - 1):
        daily.run_beat(day + timedelta(days=k), files, sid, DEFAULT_CONFIG_DIR, at(2026, 10, 28 + k, 10, 30))
        assert files.read("2026-10-27.result.json") is None
    daily.run_beat(day + timedelta(days=beat.VOID_AFTER_DAYS - 1), files, sid, DEFAULT_CONFIG_DIR,
                   at(2026, 10, 27 + beat.VOID_AFTER_DAYS, 10, 30))
    assert files.read("2026-10-27.result.json")["void"] is True


def test_the_puzzle_waits_for_station_id(monkeypatch, tmp_path):
    fake_world(monkeypatch, {})
    files, sid = Files(tmp_path, "beat"), Files(tmp_path, "station")
    lines, errors = daily.run_beat(date(2026, 10, 27), files, sid, DEFAULT_CONFIG_DIR, at(2026, 10, 28, 10, 30))
    assert len(errors) == 1 and "Station ID's puzzle for 2026-10-27" in errors[0]
    assert files.read("2026-10-29.json") is None


def test_no_puzzle_once_its_lock_has_passed(monkeypatch, tmp_path):
    fake_world(monkeypatch, {})
    files = Files(tmp_path, "beat")
    sid = Files(tmp_path, "station", {"2026-10-27.json": station_puzzle("KXXX")})
    # 07:30Z: past midnight in Los Angeles (07Z in PDT), while Oct 27 is still the newest day ended
    _, errors = daily.run_beat(date(2026, 10, 27), files, sid, DEFAULT_CONFIG_DIR, at(2026, 10, 29, 7, 30))
    assert any("every city's call has locked" in e for e in errors)


def failing_icon(monkeypatch):
    monkeypatch.setattr(highs, "Source", lambda m, config_dir=None: FakeSource(error=RuntimeError("503"))
                        if m.id == "icon" else FakeSource([70 + highs.MODELS.index(m.id)]))


def test_a_model_that_can_t_be_read_waits_for_the_backup_run(monkeypatch, tmp_path):
    cs = station.load_cities(DEFAULT_CONFIG_DIR)
    p = beat.build_puzzle(date(2026, 10, 28), cs, 0, MODELS, REGIONS, [], [], 4.0)
    files = Files(tmp_path, "beat", {"2026-10-28.json": p})
    sid = Files(tmp_path, "station", {"2026-10-27.json": station_puzzle("KXXX")})
    monkeypatch.setattr(daily.iem, "fetch_cli", lambda d: {})
    failing_icon(monkeypatch)
    # The 10:30Z run, started at 14:05Z as GitHub did on 2026-10-24: an error, and nothing written,
    # so the backup run tries again, however late the first one was
    _, errors = daily.run_beat(date(2026, 10, 27), files, sid, DEFAULT_CONFIG_DIR, at(2026, 10, 28, 14, 5))
    assert any("ICON's run" in e for e in errors)
    assert files.read("2026-10-28.models.json") is None
    # The backup (the last try), started at 16:14Z: still an error, but the four that were read are written
    _, errors = daily.run_beat(date(2026, 10, 27), files, sid, DEFAULT_CONFIG_DIR, at(2026, 10, 28, 16, 14),
                               last_try=True)
    assert any("ICON's run" in e for e in errors)
    assert [m["id"] for m in files.read("2026-10-28.models.json")["models"]] == ["gfs", "gefs", "ecmwf", "gdps"]


def test_a_day_still_without_its_models_calls_gets_them_the_next_morning(monkeypatch, tmp_path):
    cs = station.load_cities(DEFAULT_CONFIG_DIR)
    p = beat.build_puzzle(date(2026, 10, 28), cs, 0, MODELS, REGIONS, [], [], 4.0)
    files = Files(tmp_path, "beat", {"2026-10-28.json": p})
    sid = Files(tmp_path, "station", {"2026-10-28.json": station_puzzle("KXXX")})
    monkeypatch.setattr(daily.iem, "fetch_cli", lambda d: {cs[0]["id"]: {"high": 66}} if d == date(2026, 10, 28) else {})
    failing_icon(monkeypatch)
    # Both of Oct 28's runs missed (no backup): the first run on Oct 29 writes them with its verdict, not a last try
    _, errors = daily.run_beat(date(2026, 10, 28), files, sid, DEFAULT_CONFIG_DIR, at(2026, 10, 29, 10, 30))
    assert any("ICON's run" in e for e in errors)
    assert len(files.read("2026-10-28.models.json")["models"]) == 4
    assert files.read("2026-10-28.result.json")["high"] == 66


def test_replace_remakes_only_the_next_puzzle(monkeypatch, tmp_path):
    cs = station.load_cities(DEFAULT_CONFIG_DIR)
    newest = date(2026, 10, 27)
    old = {"2026-10-27.json": beat.build_puzzle(newest, cs, 0, MODELS, REGIONS, [], [], 4.0),
           "2026-10-27.models.json": {"models": "published"}, "2026-10-27.result.json": {"high": 1},
           "2026-10-28.json": beat.build_puzzle(newest + timedelta(days=1), cs, 1, MODELS, REGIONS, [], [], 4.0),
           "2026-10-28.models.json": {"models": "published"},
           "2026-10-29.json": {"date": "2026-10-29", "city": {"id": "KOLD"}}}
    files = Files(tmp_path, "beat", old)
    sid = Files(tmp_path, "station", {"2026-10-27.json": station_puzzle("KXXX")})
    fake_world(monkeypatch, {newest: {cs[0]["id"]: {"high": 70}}})
    _, errors = daily.run_beat(newest, files, sid, DEFAULT_CONFIG_DIR, at(2026, 10, 28, 13), replace=True)
    assert errors == []
    for name in ("2026-10-27.models.json", "2026-10-27.result.json", "2026-10-28.models.json"):
        assert files.read(name) == old[name]
    assert files.read("2026-10-29.json")["city"]["id"] != "KOLD"


def test_an_earlier_day_run_by_hand_skips_the_puzzle_its_too_late_for(monkeypatch, tmp_path):
    fake_world(monkeypatch, {})
    files, sid = Files(tmp_path, "beat"), Files(tmp_path, "station")
    assert daily.run_beat(date(2026, 10, 27), files, sid, DEFAULT_CONFIG_DIR, at(2026, 11, 2, 10, 30)) == ([], [])


def test_a_late_run_picks_a_city_still_open(monkeypatch, tmp_path):
    fake_world(monkeypatch, {})
    files = Files(tmp_path, "beat")
    sid = Files(tmp_path, "station", {"2026-10-27.json": station_puzzle("KXXX")})
    # 05:30Z on Oct 29: past midnight in the East (04Z in EDT), not yet in Denver or Los Angeles
    _, errors = daily.run_beat(date(2026, 10, 27), files, sid, DEFAULT_CONFIG_DIR, at(2026, 10, 29, 5, 30))
    assert errors == []
    p = files.read("2026-10-29.json")
    assert at(2026, 10, 29, 5, 30) < datetime.fromisoformat(p["lock"].replace("Z", "+00:00"))


def test_no_puzzle_before_the_first_day(monkeypatch, tmp_path):
    fake_world(monkeypatch, {})
    files, sid = Files(tmp_path, "beat"), Files(tmp_path, "station")
    assert daily.run_beat(beat.EPOCH - timedelta(days=3), files, sid, DEFAULT_CONFIG_DIR,
                          at(2026, 10, 25, 10, 30)) == ([], [])
    assert files.remote.objects == {}


def test_station_id_avoids_beat_the_models_cities(monkeypatch):
    from .test_station import SPOT_SHOWN, US, world

    cs, reports, obs = world()
    first = station.build_puzzle(date(2026, 10, 23), cs, reports, obs, SPOT_SHOWN, US)
    answer = first["cities"][first["answer"]][0]
    again = station.build_puzzle(date(2026, 10, 23), cs, reports, obs, SPOT_SHOWN, US, avoid={answer})
    assert again["cities"][again["answer"]][0] != answer
    # make_station reads Beat the Models' puzzles for the day and the next
    seen = []
    monkeypatch.setattr(daily.iem, "fetch_cli", lambda d: reports)
    monkeypatch.setattr(daily.iem, "fetch_daily", lambda d: obs)
    monkeypatch.setattr(daily.station, "load_cities", lambda c: cs)

    def beat_puzzle(d):
        seen.append(d)
        return {"city": {"id": answer}} if d == date(2026, 10, 24) else None

    spot = {"date": "2026-10-23", "rounds": [{"kind": k} for k in ("coldest", "gust", "wettest", "muggiest", "warmup")]}
    made = daily.make_station(date(2026, 10, 23), US, spot, lambda d: None, DEFAULT_CONFIG_DIR, beat_puzzle=beat_puzzle)
    assert seen == [date(2026, 10, 23), date(2026, 10, 24), date(2026, 10, 25)]
    assert made["cities"][made["answer"]][0] != answer


def test_the_cli_runs_the_day(monkeypatch, tmp_path):
    got = {}

    def run(newest, files, station_files, config_dir, now, replace=False, last_try=False):
        got.update(newest=newest, now=now, replace=replace, last_try=last_try, beat=files.remote,
                   station=station_files.remote)
        return ["ok"], []

    monkeypatch.setattr(daily, "run_beat", run)
    monkeypatch.setattr(cli.R2Store, "from_env", classmethod(lambda cls, prefix: prefix))
    assert cli.main(["--data-dir", str(tmp_path), "game", "beat", "--now", "2026-10-28T10:30:00Z", "--publish"]) == 0
    assert got == {"newest": date(2026, 10, 27), "now": at(2026, 10, 28, 10, 30), "replace": False,
                   "last_try": False, "beat": "games/beat", "station": "games/station"}
    assert cli.main(["--data-dir", str(tmp_path), "game", "beat", "--now", "2026-10-28T12:45:00Z", "--last-try"]) == 0
    assert got["last_try"] is True
    monkeypatch.setattr(daily, "run_beat", lambda *a, **k: ([], ["puzzle for 2026-10-29: boom"]))
    assert cli.main(["--data-dir", str(tmp_path), "game", "beat", "--now", "2026-10-28T10:30:00Z"]) == 1
