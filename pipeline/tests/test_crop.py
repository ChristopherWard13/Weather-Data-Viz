import numpy as np
import pytest

from wxtrend.config import Domain
from wxtrend.fields import crop_to_domain

RES = 0.25


def gfs_like_grid(lat_descending=True, lon_convention="0-360"):
    """A global 0.25 deg grid whose value encodes its own coordinates."""
    lats = np.linspace(90, -90, 721) if lat_descending else np.linspace(-90, 90, 721)
    if lon_convention == "0-360":
        lons = np.arange(1440) * RES
    else:
        lons = -180 + np.arange(1440) * RES
    lon360 = lons % 360
    field = lats[:, None] * 1000.0 + lon360[None, :]
    return field, lats, lons


DOMAIN = Domain(lat_min=15.0, lat_max=70.0, lon_min=-170.0, lon_max=-50.0, resolution=RES)


def expected_field(domain):
    lats = domain.lat_max - RES * np.arange(domain.ny)
    lons360 = (domain.lon_min + RES * np.arange(domain.nx)) % 360
    return lats[:, None] * 1000.0 + lons360[None, :]


@pytest.mark.parametrize("lat_descending", [True, False])
@pytest.mark.parametrize("lon_convention", ["0-360", "-180-180"])
def test_crop_shape_and_orientation(lat_descending, lon_convention):
    field, lats, lons = gfs_like_grid(lat_descending, lon_convention)
    out = crop_to_domain(field, lats, lons, DOMAIN)
    assert out.data.shape == (221, 481)
    # Row 0 is the northern edge regardless of source orientation
    assert out.lats[0] == 70.0 and out.lats[-1] == 15.0
    assert out.lons[0] == -170.0 and out.lons[-1] == -50.0
    np.testing.assert_array_equal(out.data, expected_field(DOMAIN))


def test_crop_corners_explicit():
    field, lats, lons = gfs_like_grid()
    d = crop_to_domain(field, lats, lons, DOMAIN).data
    assert d[0, 0] == 70 * 1000 + 190.0      # NW corner: 70N 170W
    assert d[0, -1] == 70 * 1000 + 310.0     # NE corner: 70N 50W
    assert d[-1, 0] == 15 * 1000 + 190.0     # SW corner: 15N 170W
    assert d[-1, -1] == 15 * 1000 + 310.0    # SE corner: 15N 50W
    assert d[1, 0] == 69.75 * 1000 + 190.0   # second row is 0.25 deg further south


def test_crop_across_prime_meridian():
    field, lats, lons = gfs_like_grid()
    dom = Domain(lat_min=40.0, lat_max=50.0, lon_min=-10.0, lon_max=10.0, resolution=RES)
    out = crop_to_domain(field, lats, lons, dom)
    assert out.data.shape == (41, 81)
    np.testing.assert_array_equal(out.data, expected_field(dom))


def test_crop_rejects_resolution_mismatch():
    lats = np.linspace(90, -90, 361)
    lons = np.arange(720) * 0.5
    with pytest.raises(ValueError):
        crop_to_domain(np.zeros((361, 720)), lats, lons, DOMAIN)


def test_crop_rejects_shape_mismatch():
    _, lats, lons = gfs_like_grid()
    with pytest.raises(ValueError):
        crop_to_domain(np.zeros((10, 10)), lats, lons, DOMAIN)


def test_crop_preserves_uint8_dtype():
    field, lats, lons = gfs_like_grid()
    out = crop_to_domain((field % 256).astype(np.uint8), lats, lons, DOMAIN)
    assert out.data.dtype == np.uint8
    assert out.data.flags["C_CONTIGUOUS"]
