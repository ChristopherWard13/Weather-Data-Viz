import numpy as np
import pytest

from wxtrend.config import Band
from wxtrend.fields import (
    MS_TO_KT,
    classify_ptype,
    decode_band,
    delta_kt,
    direction_from,
    encode_band,
    kelvin_to_f,
    mm_to_in,
    pa_to_hpa,
    speed_kt,
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
