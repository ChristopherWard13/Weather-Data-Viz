"""Modeled or Measured's puzzle: the measured grids, the land mask, leads, fairness and rounds (games/)."""

import gzip
import json
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pytest
import requests

from wxtrend.config import DEFAULT_CONFIG_DIR
from wxtrend.fetch import UpstreamMissing
from wxtrend.games import daily, maps, measured, obsgrid
from wxtrend.games.land import StateOutlines

OUTLINES = StateOutlines()
US = {r["id"]: r for r in json.loads((DEFAULT_CONFIG_DIR / "regions.json").read_text())["regions"]}["us"]
GRID = measured.game_grid(US)
LAND = OUTLINES.land_mask(*obsgrid.grid_axes(GRID))
DAY = date(2026, 10, 21)
UTC = timezone.utc
SMALL = {"lat0": 40.0, "lon0": -100.0, "dlat": -1.0, "dlon": 1.0, "ny": 2, "nx": 3}
ROWS, COLS = np.mgrid[0:GRID["ny"], 0:GRID["nx"]]


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


def grib(values: np.ndarray, lat1: float, lon1: float, step: float, south_up: bool, missing=None) -> bytes:
    """A real GRIB2 message on a regular lat/lon grid, from eccodes' own sample."""
    import eccodes

    nj, ni = values.shape
    h = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
    try:
        lat_n = lat1 + (step if south_up else -step) * (nj - 1)
        for key, v in [("Ni", ni), ("Nj", nj), ("jScansPositively", int(south_up)),
                       ("latitudeOfFirstGridPointInDegrees", lat1), ("latitudeOfLastGridPointInDegrees", lat_n),
                       ("longitudeOfFirstGridPointInDegrees", lon1),
                       ("longitudeOfLastGridPointInDegrees", lon1 + step * (ni - 1)),
                       ("iDirectionIncrementInDegrees", step), ("jDirectionIncrementInDegrees", step)]:
            eccodes.codes_set(h, key, v)
        if missing is not None:
            eccodes.codes_set(h, "bitmapPresent", 1)
            eccodes.codes_set(h, "missingValue", missing)
        eccodes.codes_set_values(h, values.ravel())
        return eccodes.codes_get_message(h)
    finally:
        eccodes.codes_release(h)


def test_decode_grib_reads_a_north_to_south_grid_east_of_180_onto_the_game_grid():
    # MRMS's layout: first point in the north-west, scanning south, longitudes 0..360
    values = np.arange(12, dtype=float).reshape(3, 4) * 10  # rows 40, 39, 38 N; columns 260..263 E (100..97 W)
    vals, lats, lons = obsgrid.decode_grib(grib(values, 40.0, 260.0, 1.0, south_up=False))
    assert lats[0, 0] == pytest.approx(40) and lats[2, 0] == pytest.approx(38)
    assert lons[0, 0] == pytest.approx(260) and lons[0, 3] == pytest.approx(263)
    got = obsgrid.block_mean(vals, lats, lons, SMALL)  # 40 and 39 N, 100 to 98 W
    assert got[0].tolist() == pytest.approx([0, 10, 20], abs=1e-6)
    assert got[1].tolist() == pytest.approx([40, 50, 60], abs=1e-6)
    # Scanning north instead puts the first row in the south
    vals, lats, lons = obsgrid.decode_grib(grib(values, 38.0, 260.0, 1.0, south_up=True))
    got = obsgrid.block_mean(vals, lats, lons, SMALL)
    assert got[0].tolist() == pytest.approx([80, 90, 100], abs=1e-6)
    assert got[1].tolist() == pytest.approx([40, 50, 60], abs=1e-6)


def test_decode_grib_marks_bitmapped_points_missing():
    values = np.array([[1.0, 9999.0], [3.0, 4.0]])
    vals, _, _ = obsgrid.decode_grib(grib(values, 40.0, 260.0, 1.0, south_up=False, missing=9999.0))
    assert np.isnan(vals[0, 1]) and vals[1, 1] == pytest.approx(4)


def test_land_mask_matches_state_at():
    lats, lons = obsgrid.grid_axes(GRID)
    assert LAND.shape == (GRID["ny"], GRID["nx"]) == (113, 241)
    assert 13000 < LAND.sum() < 14000  # the Lower 48 is about 13,300 cells of 0.25°
    rng = np.random.default_rng(1)
    for r, c in zip(rng.integers(0, GRID["ny"], 300), rng.integers(0, GRID["nx"], 300)):
        assert LAND[r, c] == (OUTLINES.state_at(lons[c], lats[r]) is not None), (lats[r], lons[c])


@pytest.mark.parametrize("hour, leads", [
    (12, [120, 108, 96, 84, 72]),
    (21, [117, 105, 93, 81]),
    (30, [114, 102, 90, 78]),  # rain: the 24 hours ending 06Z the next day
    (6, [114, 102, 90, 78]),  # the spare, overnight dew point
    (18, [114, 102, 90, 78]),  # midday dew point
])
def test_candidate_runs_are_00z_and_12z_runs_3_to_5_days_ahead(hour, leads):
    valid = datetime(2026, 10, 21, tzinfo=UTC) + timedelta(hours=hour)
    runs = measured.candidate_runs(valid)
    assert [round((valid - t).total_seconds() / 3600) for t in runs] == leads
    assert all(t.hour in (0, 12) for t in runs)


def test_no_two_instant_rounds_share_an_hour():
    """A dew point can't top its hour's temperature, so a revealed map at one hour mustn't pair with
    another round's at the same hour, the spare's included."""
    instant = [measured.KINDS[k] for k in measured.PLAN + [measured.SPARE] if measured.KINDS[k].field != "rain"]
    by_hour = {}
    for k in instant:
        by_hour.setdefault(k.hour, set()).add(k.field)
    assert all(not ({"t2m", "d2m"} <= fields) for fields in by_hour.values())
    assert measured.KINDS[measured.SPARE].hour not in {k.hour for k in instant if k.id != measured.SPARE}


PATTERN = 50 + 10 * np.sin(COLS / 20) + 5 * np.cos(ROWS / 15)
ERROR = 3 * np.sin(ROWS / 7 + COLS / 11)
RAIN = np.clip(0.6 + 0.5 * np.sin(COLS / 9) * np.cos(ROWS / 13), 0, None)


class Fake:
    """A measured pattern; each run's forecast is it, a steady offset, and an error that grows with its lead."""

    OFFSET = 5.0

    def __init__(self, dry=False, missing=(), fails=None):
        self.dry = dry
        self.missing = set(missing)
        self.fails = fails  # an exception the measured fetch raises
        self.calls = []

    def measure(self, field, valid):
        if self.fails is not None:
            raise self.fails
        if field in self.missing:
            raise FileNotFoundError(field)
        if field == "rain":
            return np.zeros_like(PATTERN) if self.dry else RAIN.copy()
        return PATTERN.copy()

    def forecast(self, field, init, fhr):
        self.calls.append((field, init, fhr))
        lead = fhr if field != "precip" else fhr  # each 6-hour amount carries its own lead's error
        k = (lead - 60) / 60
        if field == "precip":
            return np.zeros_like(PATTERN) if self.dry else np.clip(RAIN + 0.3 * k * np.sin(ROWS / 7), 0, None) / 4
        out = PATTERN + self.OFFSET + k * ERROR
        out[:3] = np.nan  # the model is missing a few rows: neither map shows them
        return out


def decoded(r, k, grid=GRID):
    return maps.decode(r["maps"][k], r["scale"], r["offset"], (grid["ny"], grid["nx"]))


def test_build_puzzle():
    fake = Fake()
    p = measured.build_puzzle(DAY, US, fake.measure, fake.forecast, OUTLINES, made=datetime(2026, 10, 22, 10, 30, tzinfo=UTC))
    assert p["game"] == "measured" and p["v"] == 1 and p["date"] == "2026-10-21"
    assert p["number"] == 1  # numbered from Oct 21
    assert [r["kind"] for r in p["rounds"]] == measured.PLAN
    for r in p["rounds"]:
        a, b = decoded(r, 0), decoded(r, 1)
        # The same footprint: Lower 48 land, less the rows the model lacks
        assert np.array_equal(np.isnan(a), np.isnan(b))
        assert np.array_equal(~np.isnan(a), LAND & (ROWS >= 3))
        meas, model = decoded(r, r["answer"]), decoded(r, 1 - r["answer"])
        if r["field"] == "rain":
            assert r["shift"] == 0.0
        else:
            # The forecast's steady offset is gone from its map, and reported in full
            assert abs(np.nanmean(model) - np.nanmean(meas)) < r["scale"]
            assert r["shift"] == pytest.approx(Fake.OFFSET, abs=0.3)
            assert r["miss"]["bias"] == pytest.approx(Fake.OFFSET, abs=0.3)
        assert r["model"]["id"] == "gfs"
        assert r["blur"]["model"] == measured.SHARED_BLUR and r["blur"]["measured"] >= measured.SHARED_BLUR
    # The median miss: of five runs, the 96-hour one; of four, the third shortest lead
    assert [r["model"]["lead"] for r in p["rounds"]] == [96, 105, 102, 105, 102]
    assert p["rounds"][4]["from"] == "2026-10-21T06:00Z" and p["rounds"][4]["valid"] == "2026-10-22T06:00Z"
    # Rain sums four 6-hour amounts of the one run
    rain_calls = sorted(fhr for f, init, fhr in fake.calls if f == "precip" and init == datetime(2026, 10, 18, 0, tzinfo=UTC))
    assert rain_calls == [84, 90, 96, 102]


def test_rain_is_stored_up_to_a_foot():
    r = measured.KINDS["rain"]
    big = np.array([[0.0, 3.14, 11.0, 20.0]])
    back = maps.decode(maps.encode(big, r), r.scale, r.offset, big.shape)
    assert back[0, :3].tolist() == pytest.approx([0, 3.15, 11.0], abs=r.scale / 2 + 1e-9)
    assert back[0, 3] == pytest.approx(12.7)


def test_match_blur_evens_out_texture():
    rng = np.random.default_rng(3)
    inner = measured.interior(LAND)
    smooth_model = obsgrid.smooth(PATTERN, measured.SHARED_BLUR)
    grainy = obsgrid.smooth(PATTERN + rng.normal(0, 1.5, PATTERN.shape), measured.SHARED_BLUR)
    # The model: the same kind of grain, blurred by another 0.625 cells (blurs add in quadrature)
    model = obsgrid.smooth(PATTERN + rng.normal(0, 1.5, PATTERN.shape), np.hypot(measured.SHARED_BLUR, 0.625))
    extra, out = measured.match_blur(grainy, model, inner)
    assert extra == pytest.approx(0.625, abs=0.125)
    lap_a, hp_a = measured.texture(out, inner)
    lap_b, hp_b = measured.texture(model, inner)
    assert lap_a == pytest.approx(lap_b, rel=0.25) and hp_a == pytest.approx(hp_b, rel=0.25)
    # A measured map already as smooth as the model's gets nothing extra
    assert measured.match_blur(smooth_model, smooth_model, inner)[0] == 0


def test_the_answers_are_fixed_by_the_day():
    one = measured.build_puzzle(DAY, US, Fake().measure, Fake().forecast, OUTLINES)
    two = measured.build_puzzle(DAY, US, Fake().measure, Fake().forecast, OUTLINES)
    other = measured.build_puzzle(date(2026, 10, 22), US, Fake().measure, Fake().forecast, OUTLINES)
    answers = [r["answer"] for r in one["rounds"]]
    assert answers == [r["answer"] for r in two["rounds"]]
    assert set(answers) | {r["answer"] for r in other["rounds"]} == {0, 1}


def test_a_dry_day_swaps_the_rain_round_for_overnight_dew_point():
    fake = Fake(dry=True)
    p = measured.build_puzzle(DAY, US, fake.measure, fake.forecast, OUTLINES)
    assert [r["kind"] for r in p["rounds"]] == ["morning", "afternoon", "dewpoint", "gust", "nightdew"]
    assert p["rounds"][4]["valid"] == "2026-10-21T06:00Z"


def test_missing_data_uses_the_spare_once_then_fails():
    p = measured.build_puzzle(DAY, US, Fake(missing={"gust"}).measure, Fake().forecast, OUTLINES)
    assert [r["kind"] for r in p["rounds"]] == ["morning", "afternoon", "dewpoint", "nightdew", "rain"]
    with pytest.raises(ValueError, match="no rain round"):
        fake = Fake(dry=True, missing={"gust"})
        measured.build_puzzle(DAY, US, fake.measure, fake.forecast, OUTLINES)


def test_a_run_that_isnt_there_is_skipped():
    fake = Fake()

    def forecast(field, init, fhr):
        if init.hour == 12:
            raise UpstreamMissing(f"gfs {init:%Y%m%d%H} f{fhr:03d} not found on aws")
        return fake.forecast(field, init, fhr)

    p = measured.build_puzzle(DAY, US, fake.measure, forecast, OUTLINES)
    assert all(r["model"]["run"].endswith("00") for r in p["rounds"])


@pytest.mark.parametrize("error", [requests.ConnectionError("reset"), requests.HTTPError("503"), RuntimeError("boom")])
def test_other_errors_stop_the_run_rather_than_publish_a_lesser_puzzle(error):
    with pytest.raises(type(error)):
        measured.build_puzzle(DAY, US, Fake(fails=error).measure, Fake().forecast, OUTLINES)

    def forecast(field, init, fhr):
        raise error

    with pytest.raises(type(error)):
        measured.build_puzzle(DAY, US, Fake().measure, forecast, OUTLINES)


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
                    raise requests.HTTPError(status)

        return R()


URMA_T = datetime(2026, 10, 21, 21, tzinfo=UTC)
URMA_IDX = ("1:0:d=2026102121:HGT:surface:anl:\n2:100:d=2026102121:TMP:2 m above ground:anl:\n"
            "3:250:d=2026102121:DPT:2 m above ground:anl:\n")


def test_urma_reads_one_field_by_byte_range_in_site_units(monkeypatch):
    url = obsgrid.URMA_URL.format(t=URMA_T)
    session = Session({url + ".idx": (200, URMA_IDX), url: (206, b"grib")})
    lats, lons = np.array([[40.0, 40.0]]), np.array([[-100.0, -99.0]])
    monkeypatch.setattr(obsgrid, "decode_grib", lambda data: (np.array([[273.15, 293.15]]), lats, lons))
    got = obsgrid.urma(URMA_T, "t2m", SMALL, session)
    assert session.asked[1] == (url, {"Range": "bytes=100-249"})
    assert got[0, 0] == pytest.approx(32) and got[0, 1] == pytest.approx(68)


def test_urma_refuses_a_whole_file_for_a_byte_range():
    url = obsgrid.URMA_URL.format(t=URMA_T)
    session = Session({url + ".idx": (200, URMA_IDX), url: (200, b"the whole file")})
    with pytest.raises(ValueError, match="byte range"):
        obsgrid.urma(URMA_T, "t2m", SMALL, session)


def test_mrms_marks_no_coverage_missing_and_converts_to_inches():
    t = datetime(2026, 10, 22, 6, tzinfo=UTC)
    values = np.array([[25.4, -1.0, 50.8], [-3.0, 12.7, 0.0]])  # 40 and 39 N, 100 to 98 W
    session = Session({obsgrid.MRMS_URL.format(t=t): (200, gzip.compress(grib(values, 40.0, 260.0, 1.0, False)))})
    got = obsgrid.mrms_rain_24h(t, SMALL, session)
    assert got[0, 0] == pytest.approx(1.0) and np.isnan(got[0, 1]) and got[0, 2] == pytest.approx(2.0)
    assert np.isnan(got[1, 0]) and got[1, 1] == pytest.approx(0.5) and got[1, 2] == 0


def test_a_missing_file_is_file_not_found():
    url = obsgrid.URMA_URL.format(t=URMA_T)
    with pytest.raises(FileNotFoundError):
        obsgrid.urma(URMA_T, "gust", SMALL, Session({url + ".idx": (404, "")}))


def test_summary_names_each_round_s_run():
    p = measured.build_puzzle(DAY, US, Fake().measure, Fake().forecast, OUTLINES)
    line = daily.summary(p)
    assert line.startswith("Modeled or Measured #1 (2026-10-21): Early-morning temperature: GFS 2026101712 (96 h)")


def test_the_cli_makes_a_measured_puzzle(monkeypatch, tmp_path):
    from wxtrend import cli

    fake = Fake()
    monkeypatch.setattr(daily, "make_measured", lambda day, area, config_dir=None: measured.build_puzzle(
        day, area, fake.measure, fake.forecast, OUTLINES))
    assert cli.main(["--data-dir", str(tmp_path), "game", "measured", "--date", "2026-10-21", "--now", "2026-10-22T10:30:00Z"]) == 0
    assert json.loads((tmp_path / "games/measured/latest.json").read_text())["date"] == "2026-10-21"
