"""Modeled or Measured's puzzle: the measured grids, the land mask, leads and rounds (games/)."""

import gzip
import json
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pytest

from wxtrend.config import DEFAULT_CONFIG_DIR
from wxtrend.games import daily, maps, measured, obsgrid
from wxtrend.games.land import StateOutlines

OUTLINES = StateOutlines()
US = {r["id"]: r for r in json.loads((DEFAULT_CONFIG_DIR / "regions.json").read_text())["regions"]}["us"]
DAY = date(2026, 10, 21)
UTC = timezone.utc
SMALL = {"lat0": 40.0, "lon0": -100.0, "dlat": -1.0, "dlon": 1.0, "ny": 2, "nx": 3}


def test_block_mean_averages_each_cell_and_drops_thin_ones():
    # Cell (0, 0) at 40N 100W gets two points, (1, 2) one valid and one missing, (0, 1) none
    lats = np.array([40.2, 39.8, 39.1, 38.9])
    lons = np.array([-100.1, 260.3, -97.9, -98.2])  # 260.3 is 99.7W
    values = np.array([10.0, 20.0, 5.0, np.nan])
    got = obsgrid.block_mean(values, lats, lons, SMALL)
    assert got[0, 0] == 15.0
    assert got[1, 2] == 5.0  # one of two points: exactly MIN_COVER
    assert np.isnan(got[0, 1])
    obsgrid.MIN_COVER, before = 0.6, obsgrid.MIN_COVER
    try:
        assert np.isnan(obsgrid.block_mean(values, lats, lons, SMALL)[1, 2])
    finally:
        obsgrid.MIN_COVER = before


def test_smooth_ignores_missing_cells_and_keeps_them_missing():
    v = np.full((9, 9), 50.0)
    v[4, 4] = 90.0
    v[0, :] = np.nan
    out = obsgrid.smooth(v, 1.0)
    assert np.isnan(out[0]).all()
    assert 50 < out[4, 4] < 90 and out[4, 3] > 50
    assert out[1, 8] == pytest.approx(50.0, rel=1e-3)  # next to the missing row: not pulled toward 0
    assert np.array_equal(obsgrid.smooth(v, 0), v, equal_nan=True)


def test_land_mask_matches_state_at():
    grid = measured.game_grid(US)
    lats, lons = obsgrid.grid_axes(grid)
    mask = OUTLINES.land_mask(lats, lons)
    assert mask.shape == (grid["ny"], grid["nx"]) == (113, 241)
    assert 13000 < mask.sum() < 14000  # the Lower 48 is about 13,300 cells of 0.25°
    rng = np.random.default_rng(1)
    for r, c in zip(rng.integers(0, grid["ny"], 300), rng.integers(0, grid["nx"], 300)):
        assert mask[r, c] == (OUTLINES.state_at(lons[c], lats[r]) is not None), (lats[r], lons[c])


@pytest.mark.parametrize("hour, leads", [
    (12, [120, 108, 96, 84, 72]),
    (21, [117, 105, 93, 81]),
    (30, [114, 102, 90, 78]),  # rain: the 24 hours ending 06Z the next day
])
def test_candidate_runs_are_00z_and_12z_runs_3_to_5_days_ahead(hour, leads):
    valid = datetime(2026, 10, 21, tzinfo=UTC) + timedelta(hours=hour)
    runs = measured.candidate_runs(valid)
    assert [round((valid - t).total_seconds() / 3600) for t in runs] == leads
    assert all(t.hour in (0, 12) for t in runs)


class Fake:
    """Measured fields of 50 (rain: 0.5 in) over everything; each run's forecast off by its lead's share."""

    def __init__(self, dry=False, missing=()):
        self.dry = dry
        self.missing = set(missing)
        self.calls = []

    def measure(self, field, valid):
        if field in self.missing:
            raise FileNotFoundError(field)
        g = measured.game_grid(US)
        if field == "rain" and self.dry:
            return np.zeros((g["ny"], g["nx"]))
        base = np.full((g["ny"], g["nx"]), 0.5 if field == "rain" else 50.0)
        base[:, : g["nx"] // 2] += 1.0 if field == "rain" else 10.0  # some spread to measure a miss against
        return base

    def forecast(self, field, init, fhr):
        self.calls.append((field, init, fhr))
        g = measured.game_grid(US)
        off = fhr / 10  # a longer lead misses by more
        if field == "precip":
            if self.dry:
                return np.zeros((g["ny"], g["nx"]))
            out = np.full((g["ny"], g["nx"]), 0.125 + off / 400)  # four of these: the measured total, plus a miss
            out[:, : g["nx"] // 2] += 0.25
            return out
        out = np.full((g["ny"], g["nx"]), 50.0 + off)
        out[:3] = np.nan  # the model is missing a few rows: neither map shows them
        return out


def decoded(r, k, grid):
    return maps.decode(r["maps"][k], r["scale"], r["offset"], (grid["ny"], grid["nx"]))


def test_build_puzzle():
    fake = Fake()
    p = measured.build_puzzle(DAY, US, fake.measure, fake.forecast, OUTLINES, made=datetime(2026, 10, 22, 10, 30, tzinfo=UTC))
    assert p["game"] == "measured" and p["v"] == 1 and p["date"] == "2026-10-21"
    assert p["number"] == (DAY - measured.EPOCH).days + 1
    assert [r["kind"] for r in p["rounds"]] == measured.PLAN
    g = p["grid"]
    land = OUTLINES.land_mask(*obsgrid.grid_axes(g))
    for r in p["rounds"]:
        a, b = decoded(r, 0, g), decoded(r, 1, g)
        # The same footprint: Lower 48 land, less the rows the model lacks
        assert np.array_equal(np.isnan(a), np.isnan(b))
        assert np.array_equal(~np.isnan(a), land & (np.arange(g["ny"]) >= 3)[:, None])
        # The measured side is the one that matches the measured field (smoothed: away from the step)
        meas = decoded(r, r["answer"], g)
        assert np.nanmax(meas) == pytest.approx(1.5 if r["field"] == "rain" else 60, abs=r["scale"])
        assert r["model"]["id"] == "gfs"
    # The median miss: of five runs, the 96-hour one; of four, the third shortest lead
    assert [r["model"]["lead"] for r in p["rounds"]] == [96, 105, 105, 105, 102]
    assert p["rounds"][4]["from"] == "2026-10-21T06:00Z" and p["rounds"][4]["valid"] == "2026-10-22T06:00Z"
    # Rain sums four 6-hour amounts of the one run
    rain_calls = sorted(fhr for f, init, fhr in fake.calls if f == "precip" and init == datetime(2026, 10, 18, 0, tzinfo=UTC))
    assert rain_calls == [84, 90, 96, 102]


def test_the_answers_are_fixed_by_the_day():
    one = measured.build_puzzle(DAY, US, Fake().measure, Fake().forecast, OUTLINES)
    two = measured.build_puzzle(DAY, US, Fake().measure, Fake().forecast, OUTLINES)
    other = measured.build_puzzle(date(2026, 10, 22), US, Fake().measure, Fake().forecast, OUTLINES)
    answers = [r["answer"] for r in one["rounds"]]
    assert answers == [r["answer"] for r in two["rounds"]]
    assert set(answers) | {r["answer"] for r in other["rounds"]} == {0, 1}


def test_a_dry_day_swaps_the_rain_round_for_morning_dew_point():
    fake = Fake(dry=True)
    p = measured.build_puzzle(DAY, US, fake.measure, fake.forecast, OUTLINES)
    assert [r["kind"] for r in p["rounds"]] == ["morning", "afternoon", "dewpoint", "gust", "morningdew"]


def test_missing_data_uses_the_spare_once_then_fails():
    p = measured.build_puzzle(DAY, US, Fake(missing={"gust"}).measure, Fake().forecast, OUTLINES)
    assert [r["kind"] for r in p["rounds"]] == ["morning", "afternoon", "dewpoint", "morningdew", "rain"]
    with pytest.raises(ValueError, match="no rain round"):
        fake = Fake(dry=True, missing={"gust"})
        measured.build_puzzle(DAY, US, fake.measure, fake.forecast, OUTLINES)


def test_a_run_that_cant_be_fetched_is_skipped():
    fake = Fake()

    def forecast(field, init, fhr):
        if init.hour == 12:
            raise FileNotFoundError(init)
        return fake.forecast(field, init, fhr)

    p = measured.build_puzzle(DAY, US, fake.measure, forecast, OUTLINES)
    assert all(r["model"]["run"].endswith("00") for r in p["rounds"])


class Session:
    def __init__(self, responses):
        self.responses = responses
        self.asked = []

    def get(self, url, timeout=None, headers=None):
        self.asked.append((url, headers))
        status, body = self.responses[url]

        class R:
            status_code = status
            content = body if isinstance(body, bytes) else body.encode()
            text = body if isinstance(body, str) else ""

            def raise_for_status(self):
                if status >= 400:
                    raise RuntimeError(status)

        return R()


def test_urma_reads_one_field_by_byte_range_in_site_units(monkeypatch):
    url = obsgrid.URMA_URL.format(t=datetime(2026, 10, 21, 21, tzinfo=UTC))
    idx = "1:0:d=2026102121:HGT:surface:anl:\n2:100:d=2026102121:TMP:2 m above ground:anl:\n3:250:d=2026102121:DPT:2 m above ground:anl:\n"
    session = Session({url + ".idx": (200, idx), url: (200, b"grib")})
    lats, lons = np.array([[40.0, 40.0]]), np.array([[-100.0, -99.0]])
    monkeypatch.setattr(obsgrid, "decode_grib", lambda data: (np.array([[273.15, 293.15]]), lats, lons))
    got = obsgrid.urma(datetime(2026, 10, 21, 21, tzinfo=UTC), "t2m", SMALL, session)
    assert session.asked[1] == (url, {"Range": "bytes=100-249"})
    assert got[0, 0] == pytest.approx(32) and got[0, 1] == pytest.approx(68)


def test_mrms_marks_no_coverage_missing_and_converts_to_inches(monkeypatch):
    t = datetime(2026, 10, 22, 6, tzinfo=UTC)
    session = Session({obsgrid.MRMS_URL.format(t=t): (200, gzip.compress(b"grib"))})
    lats, lons = np.array([[40.0, 40.0, 39.0]]), np.array([[-100.0, -99.0, -98.0]])
    monkeypatch.setattr(obsgrid, "decode_grib", lambda data: (np.array([[25.4, -1.0, -3.0]]), lats, lons))
    got = obsgrid.mrms_rain_24h(t, SMALL, session)
    assert got[0, 0] == pytest.approx(1.0)
    assert np.isnan(got[0, 1]) and np.isnan(got[1, 2])


def test_a_missing_file_is_file_not_found():
    url = obsgrid.URMA_URL.format(t=datetime(2026, 10, 21, 21, tzinfo=UTC))
    with pytest.raises(FileNotFoundError):
        obsgrid.urma(datetime(2026, 10, 21, 21, tzinfo=UTC), "gust", SMALL, Session({url + ".idx": (404, "")}))


def test_summary_names_each_round_s_run():
    p = measured.build_puzzle(DAY, US, Fake().measure, Fake().forecast, OUTLINES)
    line = daily.summary(p)
    assert line.startswith(f"Modeled or Measured #{p['number']} (2026-10-21): Early-morning temperature: GFS 2026101712 (96 h)")


def test_the_cli_makes_a_measured_puzzle(monkeypatch, tmp_path):
    from wxtrend import cli

    fake = Fake()
    monkeypatch.setattr(daily, "make_measured", lambda day, area, config_dir=None: measured.build_puzzle(
        day, area, fake.measure, fake.forecast, OUTLINES))
    assert cli.main(["--data-dir", str(tmp_path), "game", "measured", "--date", "2026-10-21", "--now", "2026-10-22T10:30:00Z"]) == 0
    assert json.loads((tmp_path / "games/measured/latest.json").read_text())["date"] == "2026-10-21"
