import numpy as np
import pytest

from wxtrend.config import Band
from wxtrend.fields import (
    MS_TO_KT,
    PTYPE_UNSPECIFIED,
    classify_ptype,
    decode_band,
    dewpoint_magnus,
    delta_kt,
    direction_from,
    encode_band,
    kelvin_to_f,
    mm_to_in,
    pa_to_hpa,
    speed_kt,
    unspecified_ptype,
)

KT = Band("speed", "kt", "uint8", 1.0, 0.0)

from .conftest import load_vectors


def test_conversion_factor():
    assert MS_TO_KT == 1.94384
    # 1 kt = 1852 m / 3600 s; the spec's factor agrees to 5 significant figures
    assert MS_TO_KT == pytest.approx(3600 / 1852, rel=1e-5)


@pytest.mark.parametrize(
    "u,v,kt",
    [
        (0.0, 0.0, 0.0),
        (1.0, 0.0, 1.94384),
        (0.0, -1.0, 1.94384),
        (30.0, 40.0, 50.0 * 1.94384),  # 3-4-5 triangle
        (-30.0, -40.0, 50.0 * 1.94384),
        (51.4444, 0.0, 100.0),
    ],
)
def test_speed_kt(u, v, kt):
    assert speed_kt(u, v) == pytest.approx(kt, abs=1e-3)


def test_speed_kt_is_elementwise():
    u = np.array([[3.0, 0.0], [-6.0, 10.0]])
    v = np.array([[4.0, 2.0], [8.0, 0.0]])
    np.testing.assert_allclose(speed_kt(u, v), np.array([[5, 2], [10, 10]]) * MS_TO_KT)


def test_encode_rounds_to_nearest_and_clips():
    got = encode_band(np.array([-3.0, 0.4, 0.6, 97.192, 254.4, 254.6, 388.0]), KT)
    assert got.dtype == np.uint8
    assert got.tolist() == [0, 0, 1, 97, 254, 255, 255]


def test_encode_rejects_nan():
    with pytest.raises(ValueError):
        encode_band(np.array([1.0, np.nan]), KT)


def test_encode_scale_offset_roundtrip():
    temp = Band("temp", "F", "uint8", 1.0, -80.0)
    q = encode_band(np.array([-80.0, -40.4, 32.0, 98.6, 175.0, 200.0]), temp)
    assert q.tolist() == [0, 40, 112, 179, 255, 255]
    assert decode_band(q, temp).tolist() == [-80, -40, 32, 99, 175, 175]
    mslp = Band("mslp", "hPa", "uint16", 0.1, 0.0)
    q = encode_band(np.array([1013.25, 870.04]), mslp)
    assert q.dtype == np.uint16 and q.tolist() == [10132, 8700]  # 1013.25 -> 10132 (banker's rounding)
    assert np.allclose(decode_band(q, mslp), [1013.2, 870.0])


def test_nodata_band_stores_nan_as_the_top_value_and_clips_below_it():
    speed = Band("speed", "kt", "uint8", 1.0, 0.0, nodata=255)
    q = encode_band(np.array([0.0, 254.0, 255.0, 400.0, np.nan]), speed)
    assert q.tolist() == [0, 254, 254, 254, 255]
    back = decode_band(q, speed)
    assert back[:4].tolist() == [0, 254, 254, 254] and np.isnan(back[4])
    qpf = Band("qpf", "in", "uint16", 0.01, 0.0, nodata=65535)
    q = encode_band(np.array([[np.nan, 655.34], [655.35, 1.0]]), qpf)
    assert q.dtype == np.uint16 and q.tolist() == [[65535, 65534], [65534, 100]]


def test_nodata_band_with_a_short_wrap():
    d = Band("dir", "deg", "uint8", 2.0, 0.0, wrap=360.0, nodata=255)  # 180 codes, 255 free
    assert encode_band(np.array([0.0, 90.0, 359.0, np.nan]), d).tolist() == [0, 45, 0, 255]


def test_encode_wraps_directions_instead_of_clipping():
    d = Band("dir", "deg", "uint8", 1.40625, 0.0, wrap=360.0)
    q = encode_band(np.array([0.0, 90.0, 270.0, 359.5, 360.0]), d)
    assert q.tolist() == [0, 64, 192, 0, 0]  # 359.5 rounds to 256 -> wraps to 0 (north)


@pytest.mark.parametrize(
    "u,v,deg",
    [(10, 0, 270), (-10, 0, 90), (0, 10, 180), (0, -10, 0), (10, 10, 225), (-5, -5, 45)],
)
def test_direction_is_where_wind_blows_from(u, v, deg):
    # u > 0 is a westerly (from 270); v > 0 is a southerly (from 180)
    assert direction_from(u, v) == pytest.approx(deg)


def test_unit_conversions():
    assert kelvin_to_f(273.15) == pytest.approx(32)
    assert kelvin_to_f(373.15) == pytest.approx(212)
    assert kelvin_to_f(233.15) == pytest.approx(-40)
    assert pa_to_hpa(101325) == pytest.approx(1013.25)
    assert mm_to_in(25.4) == pytest.approx(1)


def test_ptype_dominant_type_with_tie_priority():
    qpf = np.array([0.0, 0.2, 0.2, 0.2, 0.2, 0.2, 0.004])
    rain = np.array([1.0, 1.0, 0.5, 0.0, 0.25, 0.0, 1.0])
    snow = np.array([0.0, 0.0, 0.5, 0.0, 0.75, 0.0, 0.0])
    sleet = np.array([0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0])
    frzr = np.array([0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0])
    got = classify_ptype(qpf, rain, snow, sleet, frzr).tolist()
    # dry; rain; rain/snow tie -> snow; sleet/fzra tie -> fzra; mostly snow; no flags -> rain; trace -> none
    assert got == [0, 1, 2, 4, 2, 1, 0]


@pytest.mark.parametrize("case", load_vectors("delta.json"), ids=lambda c: f"{c['current']}-{c['older']}")
def test_delta_vectors(case):
    cur = np.array([case["current"]], dtype=np.uint8)
    old = np.array([case["older"]], dtype=np.uint8)
    d = delta_kt(cur, old)
    assert int(d[0]) == case["delta"]
    sign = {"faster": 1, "slower": -1, "unchanged": 0}[case["meaning"]]
    assert np.sign(d[0]) == sign


def test_delta_sign_convention_current_minus_older():
    current = np.array([[150, 80]], dtype=np.uint8)
    older = np.array([[120, 100]], dtype=np.uint8)
    d = delta_kt(current, older)
    assert d.tolist() == [[30, -20]]  # current faster -> positive
    assert d.dtype == np.int16


def test_delta_shape_mismatch():
    with pytest.raises(ValueError):
        delta_kt(np.zeros((2, 2), np.uint8), np.zeros((2, 3), np.uint8))


# ------------------------------------------------------------------ derived quantities

from wxtrend.config import Grid  # noqa: E402
from wxtrend.fields import (  # noqa: E402
    EARTH_OMEGA,
    EARTH_RADIUS_M,
    absolute_vorticity,
    accumulation_delta,
    ecmwf_ptype_override,
    kelvin_to_c,
    snow_share_ptype,
)

NA025 = Grid(id="na025", lat_min=15.0, lat_max=70.0, lon_min=-170.0, lon_max=-50.0, resolution=0.25)


def _lats(grid):
    return np.radians(grid.lat_max - grid.resolution * np.arange(grid.ny))[:, None] * np.ones((1, grid.nx))


def _lons(grid):
    return np.radians(grid.lon_min + grid.resolution * np.arange(grid.nx))[None, :] * np.ones((grid.ny, 1))


def test_vorticity_of_solid_body_rotation():
    # The atmosphere turning eastward like a solid body, u = U cos(phi), v = 0,
    # has relative vorticity 2U sin(phi) / R (Holton). Absolute adds f = 2 Omega sin(phi).
    U = 40.0
    phi = _lats(NA025)
    out = absolute_vorticity(U * np.cos(phi), np.zeros_like(phi), NA025)
    expected = (2 * U / EARTH_RADIUS_M + 2 * EARTH_OMEGA) * np.sin(phi)
    inner = (slice(1, -1), slice(1, -1))
    np.testing.assert_allclose(out[inner], expected[inner], rtol=1e-4)
    # Row 100 is 45N. In 1e-5 s-1: f = 10.31, plus 2U sin(phi)/R = 0.89
    assert out[100, 240] * 1e5 == pytest.approx(11.20, abs=0.01)


def test_vorticity_of_meridional_wind_varying_with_longitude():
    # v = A sin(lambda), u = 0: zeta = (1 / (R cos phi)) dv/dlambda = A cos(lambda) / (R cos phi)
    A = 20.0
    phi, lam = _lats(NA025), _lons(NA025)
    out = absolute_vorticity(np.zeros_like(phi), A * np.sin(lam), NA025)
    expected = A * np.cos(lam) / (EARTH_RADIUS_M * np.cos(phi)) + 2 * EARTH_OMEGA * np.sin(phi)
    np.testing.assert_allclose(out[1:-1, 1:-1], expected[1:-1, 1:-1], rtol=1e-4)


def test_vorticity_hand_computed_on_a_3x3_grid():
    # 1-degree grid at 1N, 0N, 1S. Centre point (0N, 0E): cos(phi) = 1, f = 0.
    # v rises 4 m/s per degree eastward: dv/dlambda = 8 / (2 deg) = 4 / deg.
    # u cos(phi) is 10 to the north and 4 to the south: d(u cos)/dphi = 6 / (2 deg) = 3 / deg.
    # zeta = (4 - 3) / (deg R) = 57.2958 / 6371000 = 0.8993e-5 s-1 (cyclonic).
    g = Grid(id="t", lat_min=-1.0, lat_max=1.0, lon_min=-1.0, lon_max=1.0, resolution=1.0)
    c = np.cos(np.radians(1.0))
    u = np.array([[10 / c] * 3, [7.0] * 3, [4 / c] * 3])
    v = np.array([[-4.0, 0.0, 4.0]] * 3)
    out = absolute_vorticity(u, v, g)
    assert out[1, 1] * 1e5 == pytest.approx(0.8993, abs=1e-4)
    assert np.isnan(out[0]).all() and np.isnan(out[:, 0]).all()


def test_vorticity_edges_and_nan_neighbours_are_nodata():
    phi = _lats(NA025)
    u = 10 * np.cos(phi)
    u[50, 60] = np.nan
    out = absolute_vorticity(u, np.zeros_like(u), NA025)
    assert np.isnan(out[0]).all() and np.isnan(out[-1]).all()
    assert np.isnan(out[:, 0]).all() and np.isnan(out[:, -1]).all()
    assert np.isnan(out[49, 60]) and np.isnan(out[51, 60])  # north and south neighbours use (50, 60)
    assert not np.isnan(out[50, 60])  # its own value uses only its neighbours
    assert np.isfinite(out[1:-1, 1:-1]).sum() == (NA025.ny - 2) * (NA025.nx - 2) - 2


def test_vorticity_rejects_mismatched_shapes():
    with pytest.raises(ValueError):
        absolute_vorticity(np.zeros((3, 3)), np.zeros((3, 3)), NA025)


def test_vorticity_band_encoding_round_trips_with_nodata():
    from wxtrend.config import Band

    band = Band(name="vort", units="1e-5/s", dtype="uint8", scale=1, offset=-50, nodata=255)
    values = np.array([[np.nan, -60.0, 12.4, 300.0]])
    stored = encode_band(values, band)
    assert stored.tolist() == [[255, 0, 62, 254]]  # nodata, clipped low, rounded, clipped one below nodata
    out = decode_band(stored, band)
    assert np.isnan(out[0, 0]) and out[0, 1:].tolist() == [-50, 12, 204]


def test_kelvin_to_c():
    assert kelvin_to_c(273.15) == pytest.approx(0)
    assert kelvin_to_c(np.array([253.15]))[0] == pytest.approx(-20)


def test_accumulation_delta_clips_packing_noise():
    out = accumulation_delta(np.array([5.0, 2.0, 1.0]), np.array([1.5, 2.0, 1.0000001]))
    assert out.tolist() == [3.5, 0.0, 0.0]


def test_snow_share_ptype():
    qpf = np.array([0.5, 0.5, 0.5, 0.001, 0.5])
    liquid = np.array([10.0, 10.0, 10.0, 0.02, 10.0])
    snow = np.array([5.0, 4.99, 11.0, 0.02, 0.0])  # exactly half -> snow; snow > liquid (packing) -> snow
    assert snow_share_ptype(qpf, liquid, snow).tolist() == [2, 1, 2, 0, 1]


def test_ecmwf_ptype_override_leaves_dry_points_alone():
    base = np.array([0, 1, 2, 1, 2], dtype=np.uint8)
    at_f = np.array([3.0, 0.0, 8.0, 5.0, np.nan])
    at_f3 = np.array([12.0, 12.0, 0.0, 7.0, 0.0])
    # dry stays none; fz drizzle at f-3 -> freezing rain; pellets -> sleet; snow/mix codes don't override
    assert ecmwf_ptype_override(base, [at_f, at_f3]).tolist() == [0, 4, 3, 1, 2]


@pytest.mark.parametrize(
    "t_c,rh,td_c",
    [
        # γ = ln(0.5) + 17.625·20/263.04 = −0.693147 + 1.340100 = 0.646953
        # Td = 243.04·0.646953 / (17.625 − 0.646953) = 157.2355 / 16.978047 = 9.2611 °C
        (20.0, 50.0, 9.2611),
        # γ = ln(0.8) + 17.625·(−10)/233.04 = −0.223144 − 0.756308 = −0.979451
        # Td = 243.04·(−0.979451) / (17.625 + 0.979451) = −238.0458 / 18.604451 = −12.7951 °C
        (-10.0, 80.0, -12.7951),
        (30.0, 100.0, 30.0),  # saturated: the dew point is the temperature
    ],
)
def test_dewpoint_magnus_hand_computed(t_c, rh, td_c):
    assert dewpoint_magnus(t_c + 273.15, rh) - 273.15 == pytest.approx(td_c, abs=1e-4)


def test_dewpoint_magnus_clips_humidity():
    t = np.array([290.0, 290.0, 290.0])
    td = dewpoint_magnus(t, np.array([100.4, 0.0, 1.0]))  # ensemble-mean RH can top 100 %
    assert td[0] == pytest.approx(290.0)
    assert np.isfinite(td).all() and td[1] == td[2]


def test_unspecified_ptype_marks_only_measurable_precipitation():
    out = unspecified_ptype(np.array([0.0, 0.004, 0.005, 1.2]))
    assert out.tolist() == [0, 0, PTYPE_UNSPECIFIED, PTYPE_UNSPECIFIED]
    assert PTYPE_UNSPECIFIED == 5 and out.dtype == np.uint8
