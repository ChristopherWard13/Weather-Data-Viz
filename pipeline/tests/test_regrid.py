"""regrid.py against analytic fields, whose value at every display point is known exactly."""

import numpy as np
import pytest

from wxtrend import regrid
from wxtrend.config import Grid
from wxtrend.regrid import build_weights, display_points, grid_key, weights_for

# A small display grid at 0.25°, and a 0.5° source over it (GEFS's spacing)
TARGET = Grid("t025", lat_min=30.0, lat_max=40.0, lon_min=-110.0, lon_max=-95.0, resolution=0.25)
SRC_LATS = np.arange(50.0, 19.9, -0.5)  # north to south, as GRIB delivers it
SRC_LONS_360 = np.arange(0.0, 360.0, 0.5)  # 0..359.5, as NCEP publishes it
H_DEG = 0.5

RAD = np.pi / 180


def smooth(lat, lon):
    """sin φ cos 2λ: smooth, periodic in longitude, amplitude 1."""
    return np.sin(lat * RAD) * np.cos(2 * lon * RAD)


def source(fn, lats=SRC_LATS, lons=SRC_LONS_360):
    la, lo = np.meshgrid(lats, lons, indexing="ij")
    return fn(la, lo)


def test_linear_fields_are_reproduced_exactly():
    # Barycentric interpolation is exact for a + b λ + c φ (λ in the target's -180..180 convention)
    w = build_weights(SRC_LATS, SRC_LONS_360, TARGET)
    lin = lambda la, lo: 3.0 + 0.2 * (((lo + 180) % 360) - 180) - 0.7 * la  # noqa: E731
    tlat, tlon = display_points(TARGET)
    np.testing.assert_allclose(w.apply(source(lin)), lin(tlat, tlon), atol=1e-9)


def test_smooth_field_error_is_inside_the_interpolation_bound():
    """Linear interpolation on a triangle errs by at most ½·M·d², with d its longest
    edge and M a bound on the second directional derivative.

    For f = sin φ cos 2λ (degrees), |f_λλ| ≤ 4k, |f_φφ| ≤ k, |f_λφ| ≤ 2k with
    k = (π/180)², so any second directional derivative is at most
    (4 + 1 + 2·2)k = 9k. The triangles are half squares of side 0.5°, so
    d² = 2 · 0.5² = 0.5 deg²: the bound is ½ · 9k · 0.5 ≈ 6.9e-4.
    """
    bound = 0.5 * 9 * RAD**2 * 2 * H_DEG**2
    w = build_weights(SRC_LATS, SRC_LONS_360, TARGET)
    tlat, tlon = display_points(TARGET)
    err = np.abs(w.apply(source(smooth)) - smooth(tlat, tlon))
    assert err.max() <= bound
    assert err.max() > 0  # it is an interpolation, not a copy
    # Display points that are also source points (every other row and column) are exact
    np.testing.assert_allclose(err[::2, ::2], 0, atol=1e-12)


def test_longitude_conventions_give_the_same_weights_result():
    lons180 = ((SRC_LONS_360 + 180) % 360) - 180
    order = np.argsort(lons180)
    a = build_weights(SRC_LATS, SRC_LONS_360, TARGET).apply(source(smooth))
    b = build_weights(SRC_LATS, lons180[order], TARGET).apply(source(smooth, lons=lons180[order]))
    np.testing.assert_allclose(a, b, atol=1e-12)


def test_display_grid_across_the_dateline():
    grid = Grid("dl", lat_min=50.0, lat_max=55.0, lon_min=170.0, lon_max=190.0, resolution=0.25)
    w = build_weights(np.arange(60.0, 44.9, -0.5), SRC_LONS_360, grid)
    tlat, tlon = display_points(grid)
    got = w.apply(source(smooth, lats=np.arange(60.0, 44.9, -0.5)))
    assert np.isfinite(got).all()
    assert np.abs(got - smooth(tlat, tlon)).max() <= 0.5 * 9 * RAD**2 * 2 * H_DEG**2


def test_categories_take_the_nearest_source_point():
    # A checkerboard of codes: any weighted mean would produce values between them
    codes = source(lambda la, lo: ((np.rint(la / H_DEG) + np.rint(lo / H_DEG)) % 2) * 3 + 1)  # 1 or 4
    w = build_weights(SRC_LATS, SRC_LONS_360, TARGET)
    got = w.apply_nearest(codes)
    assert set(np.unique(got)) == {1.0, 4.0}
    tlat, tlon = display_points(TARGET)
    # On a source point, its own code
    on = codes[np.searchsorted(-SRC_LATS, -tlat[::2, ::2]), np.searchsorted(SRC_LONS_360, tlon[::2, ::2] % 360)]
    np.testing.assert_array_equal(got[::2, ::2], on)


def test_points_outside_the_source_are_nodata():
    w = build_weights(np.arange(36.0, 19.9, -0.5), SRC_LONS_360, TARGET)  # covers 20-36 N only
    got = w.apply(source(smooth, lats=np.arange(36.0, 19.9, -0.5)))
    tlat, _ = display_points(TARGET)
    assert np.isnan(got[tlat > 36]).all()
    assert np.isfinite(got[tlat <= 36]).all()
    assert np.isnan(w.apply_nearest(np.ones((33, 720)))[tlat > 36]).all()


def test_curvilinear_sources_take_2d_coordinates():
    la, lo = np.meshgrid(SRC_LATS, SRC_LONS_360, indexing="ij")
    a = build_weights(SRC_LATS, SRC_LONS_360, TARGET).apply(source(smooth))
    b = build_weights(la, lo, TARGET).apply(source(smooth))
    np.testing.assert_allclose(a, b, atol=1e-12)


def test_wrong_sized_field_is_refused():
    w = build_weights(SRC_LATS, SRC_LONS_360, TARGET)
    with pytest.raises(ValueError, match="points"):
        w.apply(np.zeros((10, 10)))


def test_weights_are_cached_by_grid_hash(tmp_path, monkeypatch):
    monkeypatch.setattr(regrid, "_memo", {})
    w1 = weights_for(SRC_LATS, SRC_LONS_360, TARGET, tmp_path)
    files = list(tmp_path.glob("*.npz"))
    assert len(files) == 1 and files[0].name == f"t025-{grid_key(SRC_LATS, SRC_LONS_360, TARGET)}.npz"

    # A new process (empty memo) reads the file instead of rebuilding
    monkeypatch.setattr(regrid, "_memo", {})
    monkeypatch.setattr(regrid, "build_weights", lambda *a, **k: pytest.fail("rebuilt cached weights"))
    w2 = weights_for(SRC_LATS, SRC_LONS_360, TARGET, tmp_path)
    np.testing.assert_array_equal(w1.vertices, w2.vertices)
    np.testing.assert_array_equal(w1.weights, w2.weights)
    np.testing.assert_array_equal(w1.nearest, w2.nearest)
    assert w2.shape == (TARGET.ny, TARGET.nx)


def test_cache_key_changes_with_either_grid():
    k = grid_key(SRC_LATS, SRC_LONS_360, TARGET)
    assert grid_key(SRC_LATS + 0.25, SRC_LONS_360, TARGET) != k
    assert grid_key(SRC_LATS, SRC_LONS_360, Grid("t025", 30.0, 40.0, -110.0, -94.0, 0.25)) != k


def test_unreadable_cache_file_is_rebuilt(tmp_path, monkeypatch):
    monkeypatch.setattr(regrid, "_memo", {})
    path = tmp_path / f"t025-{grid_key(SRC_LATS, SRC_LONS_360, TARGET)}.npz"
    path.write_bytes(b"not an npz")
    w = weights_for(SRC_LATS, SRC_LONS_360, TARGET, tmp_path)
    assert w.shape == (TARGET.ny, TARGET.nx)
    assert regrid.load_weights(path).shape == w.shape  # replaced with a good file
