import numpy as np
import pytest

from wxtrend.fields import MS_TO_KT, delta_kt, encode_uint8, speed_kt

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
    got = encode_uint8(np.array([-3.0, 0.4, 0.6, 97.192, 254.4, 254.6, 388.0]))
    assert got.dtype == np.uint8
    assert got.tolist() == [0, 0, 1, 97, 254, 255, 255]


def test_encode_rejects_nan():
    with pytest.raises(ValueError):
        encode_uint8(np.array([1.0, np.nan]))


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
