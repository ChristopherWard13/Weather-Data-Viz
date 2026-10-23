"""Station ID's puzzle (games/station.py): clues, cards, the answer and the split with Wx Marks the Spot."""

import json
from datetime import date, datetime, timedelta, timezone

import pytest

from wxtrend import cli
from wxtrend.config import DEFAULT_CONFIG_DIR
from wxtrend.games import daily, draft, iem, station

from .test_games import FakeRemote

US = {r["id"]: r for r in json.loads((DEFAULT_CONFIG_DIR / "regions.json").read_text())["regions"]}["us"]
DAY = date(2026, 10, 23)
MADE = datetime(2026, 10, 24, 10, 30, tzinfo=timezone.utc)
# A pin game that left Station ID the high
SPOT_SHOWN = {"low", "gust", "rain", "dew", "change"}


def city(i, lat=40.0, lon=-100.0):
    return {"id": f"K{i:03d}", "city": f"City {i}", "state": "KS", "station": f"CITY {i} MUNI", "lat": lat, "lon": lon,
            "elev": 300 + i}


def report(i, **over):
    """A complete climate report, its numbers varying with i."""
    return {"high": 60 + i % 30, "high_depart": i % 7 - 3, "low": 40 + i % 20, "low_depart": 1, "precip": 0.25,
            "highest_gust_speed": 20 + i % 15, "highest_gust_direction": 270, "average_wind_speed": 5 + i % 10,
            "high_time": "329 PM", "low_time": "509 AM", "average_sky_cover": 0.4, "precip_month": 1.2,
            "precip_month_normal": 2.0, "high_normal": 63, "low_normal": 41, "precip_jan1": 30.1,
            "precip_jan1_normal": 31.5, "high_record": 85, "high_record_years": [1931, 2003], "low_record": 20,
            "low_record_years": [1952], **over}


def asos(i):
    return {"max_dwpf": 40.0 + i % 12, "min_dwpf": 30.0 + i % 8, "min_rh": 25.4 + i % 30, "tmpf_est": False}


def world(n=40, **over):
    cities = [city(i, 30 + i % 15, -120 + 1.3 * i) for i in range(n)]
    reports = {c["id"]: report(i, **over) for i, c in enumerate(cities)}
    obs = {c["id"][1:]: asos(i) for i, c in enumerate(cities)}
    return cities, reports, obs


def build(cities, reports, obs, shown=SPOT_SHOWN, day=DAY, used=()):
    return station.build_puzzle(day, cities, reports, obs, shown, US, list(used), made=MADE)


def test_report_values():
    v = station.city_values(city(0), report(0, precip="T", high_time="1158 PM", low_time="1201 AM",
                                            average_sky_cover="M", high_record_years=[1931, 2003]), asos(0))
    assert v["rain"] == 0.001 and v["sky"] is None
    assert (v["high_time"], v["low_time"]) == (23 * 60 + 58, 1)
    assert v["record_high_year"] == 2003 and "change" not in v
    assert v["dew_max"] == 40 and isinstance(v["dew_max"], int) and v["humid"] == 25
    assert station.city_values(city(0), None, None)["high"] is None


def test_only_reports_for_the_whole_day_count():
    day = date(2026, 10, 22)
    rows = [{"station": "KCAE", "valid": "2026-10-22", "product": "202610222138-KCAE-CDUS42-CLICAE"},  # as of 5 PM
            {"station": "KTYS", "valid": "2026-10-22", "product": "202610231437-KMRX-CDUS44-CLITYS"},  # late, whole day
            {"station": "KDEN", "valid": "2026-10-22", "product": "202610230733-KBOU-CDUS45-CLIDEN"},
            {"station": "KBOS", "valid": "2026-10-23", "product": "202610240600-KBOX-CDUS41-CLIBOS"}]
    assert sorted(iem.whole_day(day, rows)) == ["KDEN", "KTYS"]


def test_noon_and_midnight():
    assert station._minutes("1200 PM") == 12 * 60 and station._minutes("1200 AM") == 0
    assert station._minutes("MM") is None and station._minutes("1260 PM") is None


def test_the_puzzle_keeps_to_the_families_the_pin_game_left():
    p = build(*world())
    assert (p["v"], p["game"], p["date"], p["number"], p["made"]) == (1, "station", "2026-10-23", 1, "2026-10-24T10:30:00Z")
    assert p["guesses"] == 6 and len(p["cards"]) == 6 and p["bands"] == [200, 500, 1000]
    ids = [c["id"] for c in p["cards"]]
    # The temperature first, the normals 4th or 5th, the records last
    assert ids[0] == "high" and ids[-1] == "records" and ids.index("normals") in (3, 4)
    assert sorted(ids[1:5]) == ["clock", "humid", "normals", "wind"]
    shown_items = {i for f in SPOT_SHOWN for i in station.FAMILY_ITEMS.get(f, [])}
    assert not shown_items & set(p["values"])
    assert p["spot"] == ["low", "gust", "rain", "dew", "change"]
    assert set(p["values"]) == {i for c in p["cards"] for i in c["items"]}
    assert all(len(v) == len(p["cities"]) for v in p["values"].values())
    assert p["used"] == []


def test_the_change_is_never_a_clue_and_the_kept_temperature_leads():
    both = ["high", "low", "change"]
    for k in range(20):
        day = DAY + timedelta(days=k)
        ids = [c["id"] for c in station.plan_cards(day, both, False)]
        assert "change" not in ids and ids[0] == draft.station_temperature(day)
        assert ids.index({"high": "low", "low": "high"}[ids[0]]) in (1, 2, 3, 4)


def test_short_of_cards_the_month_and_the_records_fill_in():
    # The high alone on a dry day with rain left: the clock, this month's rain and the records in the middle
    ids = [c["id"] for c in station.plan_cards(DAY, ["high", "rain", "change"], True)]
    assert ids[0] == "high" and sorted(ids[1:5]) == ["clock", "month", "normals", "record"]
    assert ids[-1] == "elevation" and len(ids) == 6


def test_the_middle_cards_are_shuffled_by_the_date():
    left = ["high", "wind", "humid"]
    orders = {tuple(c["id"] for c in station.plan_cards(DAY + timedelta(days=k), left, False)) for k in range(40)}
    assert len(orders) > 4
    assert all(o[0] == "high" and o[-1] == "records" and o.index("normals") in (3, 4) for o in orders)
    assert station.plan_cards(DAY, left, False) == station.plan_cards(DAY, left, False)
    # A day before the draw, with no temperature left: six cards all the same
    assert len(station.plan_cards(DAY, ["dew", "wind", "humid"], False)) == 6


def test_a_dry_day_puts_the_month_s_rain_in_place_of_rain():
    cities, reports, obs = world(precip=0.0)
    p = build(cities, reports, obs, shown={"low", "gust", "dew", "wind", "change"})
    ids = [c["id"] for c in p["cards"]]
    assert ids[0] == "high" and "rain" not in ids and "month" in ids and len(ids) == 6


def test_the_answer_needs_every_clue():
    cities, reports, obs = world()
    first = build(cities, reports, obs)["answer"]
    reports[cities[first]["id"]]["high_normal"] = "M"
    again = build(cities, reports, obs)
    assert again["answer"] != first
    # A missing record is fine on the last card: it still shows the elevation
    reports[cities[again["answer"]]["id"]].update(high_record="M", low_record="M")
    assert build(cities, reports, obs)["answer"] == again["answer"]


def test_a_card_with_nothing_to_show_rules_a_city_out():
    record = {"id": "record", "items": station.RECORD_ITEMS}
    v = {i: None for i in station.RECORD_ITEMS}
    assert not station.complete([record], v)
    assert station.complete([record], {**v, "record_high": 80})


def play(cities, reports, obs, days, skip=None):
    """Make ``days`` puzzles in a row, each reading the ones before; ``skip``: (day index, city id) missing a clue."""
    made = {}
    for k in range(days):
        day = DAY + timedelta(days=k)
        rows = {i: dict(r) for i, r in reports.items()}
        if skip and skip[0] == k:
            rows[skip[1]]["average_wind_speed"] = "M"
        used = station.used_before(day, len(cities), lambda d: made.get(d))
        made[day] = build(cities, rows, obs, day=day, used=used)
    return [p["cities"][p["answer"]][0] for p in made.values()]


def test_answers_cycle_without_repeats():
    cities, reports, obs = world(12)
    answers = play(cities, reports, obs, 12)
    assert sorted(answers) == sorted(c["id"] for c in cities)
    assert station.cycle_order(["A", "B", "C"], 0) == station.cycle_order(["C", "B", "A"], 0)


def test_a_skipped_city_doesn_t_make_tomorrow_repeat_today():
    cities, reports, obs = world(12)
    due = station.cycle_order([c["id"] for c in cities], 0)[3]  # the fourth day's city
    answers = play(cities, reports, obs, 12, skip=(3, due))
    assert len(set(answers)) == 12  # the skipped city comes round later in the cycle
    assert answers[3] != due


def test_used_comes_from_the_latest_puzzle_this_cycle():
    p = {"number": 5, "cities": [["KA"], ["KB"]], "answer": 1, "used": ["KC"]}
    assert station.used_before(DAY + timedelta(days=5), 40, lambda d: p if d == DAY + timedelta(days=2) else None) == ["KC", "KB"]
    assert station.used_before(DAY + timedelta(days=40), 40, lambda d: p if d == DAY + timedelta(days=39) else None) == []
    assert station.used_before(DAY + timedelta(days=20), 40, lambda d: None) == []


def test_too_few_reports_is_an_error():
    cities, reports, obs = world()
    for c in cities[:10]:
        del reports[c["id"]]
    with pytest.raises(ValueError, match="only 30 of 40"):
        build(cities, reports, obs)


def test_the_city_list():
    cities = station.load_cities(DEFAULT_CONFIG_DIR)
    assert len(cities) > 300 and len({c["id"] for c in cities}) == len(cities)
    names = {(c["city"], c["state"]) for c in cities}
    assert len(names) == len(cities)  # one station a city
    assert ("Cincinnati", "OH") in names and ("Washington", "DC") in names
    assert all(c["station"] == c["station"].upper() and "_" not in c["station"] for c in cities)
    assert all(24 < c["lat"] < 50 and -125 < c["lon"] < -66 for c in cities)


SPOT_ROUNDS = [{"kind": k} for k in ("coldest", "gust", "wettest", "muggiest", "warmup")]
STATION_ARGS = ["game", "station", "--date", "2026-10-23", "--now", "2026-10-24T10:30:00Z"]


def test_the_cli_makes_station_id_after_the_pin_game(monkeypatch, tmp_path):
    spot_day = tmp_path / "games" / "spot" / "2026-10-23.json"
    spot_day.parent.mkdir(parents=True)
    spot_day.write_text(json.dumps({"date": "2026-10-23", "rounds": SPOT_ROUNDS}))
    got = {}

    def make(day, area, spot_puzzle, earlier, config_dir):
        got["shown"] = draft.families_shown(spot_puzzle)
        return {"game": "station", "date": "2026-10-23", "number": 1}

    monkeypatch.setattr(daily, "make_station", make)
    monkeypatch.setattr(daily, "summary", lambda p: "ok")
    assert cli.main(["--data-dir", str(tmp_path)] + STATION_ARGS) == 0
    assert got["shown"] == {"low", "gust", "rain", "dew", "change"}
    assert (tmp_path / "games" / "station" / "latest.json").exists()


def remotes(monkeypatch, objects):
    """One fake R2 store a prefix ("games/spot", "games/station")."""
    stores = {}

    def from_env(cls, prefix):
        if prefix not in stores:
            stores[prefix] = FakeRemote()
            stores[prefix].objects.update(objects.get(prefix, {}))
        return stores[prefix]

    monkeypatch.setattr(cli.R2Store, "from_env", classmethod(from_env))
    return stores


def test_publishing_station_id_waits_for_the_pin_game(monkeypatch, tmp_path):
    remotes(monkeypatch, {})
    monkeypatch.setattr(daily, "make_station", lambda *a, **k: pytest.fail("made without the pin game"))
    assert cli.main(["--data-dir", str(tmp_path)] + STATION_ARGS + ["--publish"]) == 1


def test_station_id_isn_t_made_before_its_first_day(monkeypatch, tmp_path):
    monkeypatch.setattr(daily, "make_station", lambda *a, **k: pytest.fail("made before #1"))
    assert cli.main(["--data-dir", str(tmp_path), "game", "station", "--date", "2026-10-22",
                     "--now", "2026-10-24T10:30:00Z"]) == 0
    assert not (tmp_path / "games" / "station").exists()


def test_remaking_the_pin_game_can_t_change_station_id_s_fields(monkeypatch, tmp_path):
    published = {"games/station": {"2026-10-23.json": json.dumps({"spot": ["low", "gust", "rain", "dew", "change"]})},
                 "games/spot": {"2026-10-23.json": b'{"date": "2026-10-23"}'}}
    stores = remotes(monkeypatch, published)
    # The rain filled in late, or went away: now a dry day, whose swap shows wind
    swapped = {"game": "spot", "date": "2026-10-23", "number": 23,
               "rounds": [{"kind": k} for k in ("coldest", "gust", "windiest", "muggiest", "warmup")]}
    monkeypatch.setattr(daily, "make_spot", lambda *a, **k: swapped)
    monkeypatch.setattr(daily, "summary", lambda p: "ok")
    args = ["--data-dir", str(tmp_path), "game", "spot", "--date", "2026-10-23", "--now", "2026-10-24T10:30:00Z",
            "--publish", "--replace"]
    assert cli.main(args) == 1
    assert stores["games/spot"].objects["2026-10-23.json"] == b'{"date": "2026-10-23"}'
    # Remade with Station ID next, it goes ahead
    assert cli.main(args + ["--station-follows"]) == 0
    assert json.loads(stores["games/spot"].objects["2026-10-23.json"])["rounds"][2]["kind"] == "windiest"


def test_the_pin_game_s_date_must_match():
    with pytest.raises(ValueError, match="not 2026-10-23"):
        daily.make_station(DAY, US, {"date": "2026-10-22", "rounds": []}, lambda d: None, DEFAULT_CONFIG_DIR)
