"""Field math: wind speed in knots, uint8 encoding, Δ, and domain cropping."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import Domain

MS_TO_KT = 1.94384


def speed_kt(u, v) -> np.ndarray:
    """Wind speed in knots from u/v components in m/s."""
    u = np.asarray(u, dtype=np.float64)
    v = np.asarray(v, dtype=np.float64)
    return np.hypot(u, v) * MS_TO_KT


def encode_uint8(speed: np.ndarray) -> np.ndarray:
    """Round to the nearest knot and clip to 0..255.

    There is no missing-value sentinel in the format, so NaNs are an error
    rather than being silently written as 0 kt.
    """
    speed = np.asarray(speed, dtype=np.float64)
    if np.isnan(speed).any():
        raise ValueError("speed field contains NaN; refusing to encode")
    return np.clip(np.rint(speed), 0, 255).astype(np.uint8)


def delta_kt(current: np.ndarray, older: np.ndarray) -> np.ndarray:
    """Δ|V| = current - older. Positive means the current run is faster.

    Inputs are usually uint8 frames; widen first so 10 - 200 is -190, not 66.
    """
    current = np.asarray(current)
    older = np.asarray(older)
    if current.shape != older.shape:
        raise ValueError(f"shape mismatch: {current.shape} vs {older.shape}")
    return current.astype(np.int16) - older.astype(np.int16)


@dataclass(frozen=True)
class CropResult:
    data: np.ndarray  # (ny, nx), row 0 = northernmost latitude
    lats: np.ndarray  # descending, north to south
    lons: np.ndarray  # ascending, west to east, in domain convention (-180..180)


def crop_to_domain(field: np.ndarray, lats: np.ndarray, lons: np.ndarray, domain: Domain) -> CropResult:
    """Crop a regular global lat/lon field to ``domain`` at native resolution.

    Works whatever the source orientation (latitude ascending or descending,
    longitude 0..360 or -180..180) and always returns rows north-to-south and
    columns west-to-east. Grid points are located by index arithmetic, never by
    float equality, and every selected point is checked against the expected
    coordinate.
    """
    field = np.asarray(field)
    lats = np.asarray(lats, dtype=np.float64)
    lons = np.asarray(lons, dtype=np.float64)
    if field.shape != (lats.size, lons.size):
        raise ValueError(f"field shape {field.shape} does not match coords ({lats.size}, {lons.size})")

    res = domain.resolution
    tol = res * 1e-3

    dlat = lats[1] - lats[0]
    dlon = lons[1] - lons[0]
    if abs(abs(dlat) - res) > tol or abs(dlon - res) > tol:
        raise ValueError(f"source grid spacing ({dlat}, {dlon}) does not match domain resolution {res}")

    want_lats = domain.lat_max - res * np.arange(domain.ny)
    want_lons = domain.lon_min + res * np.arange(domain.nx)

    rows = np.rint((want_lats - lats[0]) / dlat).astype(int)
    if rows.min() < 0 or rows.max() >= lats.size:
        raise ValueError("domain latitude range falls outside the source grid")

    n_lon = int(round(360.0 / res))
    if lons.size != n_lon:
        raise ValueError(f"expected a global longitude axis of {n_lon} points, got {lons.size}")
    cols = np.rint(((want_lons - lons[0]) % 360.0) / dlon).astype(int) % n_lon

    if not np.allclose(lats[rows], want_lats, atol=tol):
        raise AssertionError("latitude selection does not match the domain")
    got_lons = ((lons[cols] - want_lons + 180.0) % 360.0) - 180.0
    if not np.allclose(got_lons, 0.0, atol=tol):
        raise AssertionError("longitude selection does not match the domain")

    data = field[np.ix_(rows, cols)]
    return CropResult(data=np.ascontiguousarray(data), lats=want_lats, lons=want_lons)
