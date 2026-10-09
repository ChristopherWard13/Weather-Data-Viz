"""Field math: unit conversions, band encoding, Δ, and domain cropping."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import Band, Domain

MS_TO_KT = 1.94384
MM_PER_IN = 25.4


def speed_kt(u, v) -> np.ndarray:
    """Wind speed in knots from u/v components in m/s."""
    u = np.asarray(u, dtype=np.float64)
    v = np.asarray(v, dtype=np.float64)
    return np.hypot(u, v) * MS_TO_KT


def direction_from(u, v) -> np.ndarray:
    """Meteorological wind direction in degrees: where the wind blows FROM,
    clockwise from north (a westerly is 270). u/v are earth-relative."""
    u = np.asarray(u, dtype=np.float64)
    v = np.asarray(v, dtype=np.float64)
    return np.degrees(np.arctan2(-u, -v)) % 360.0


def kelvin_to_f(k) -> np.ndarray:
    return (np.asarray(k, dtype=np.float64) - 273.15) * 9.0 / 5.0 + 32.0


def pa_to_hpa(pa) -> np.ndarray:
    return np.asarray(pa, dtype=np.float64) / 100.0


def mm_to_in(mm) -> np.ndarray:
    return np.asarray(mm, dtype=np.float64) / MM_PER_IN


PTYPE_NONE, PTYPE_RAIN, PTYPE_SNOW, PTYPE_SLEET, PTYPE_FZRA = 0, 1, 2, 3, 4


def classify_ptype(qpf_in, rain, snow, sleet, frzr, measurable: float = 0.005) -> np.ndarray:
    """Dominant precipitation type over the window.

    GFS's "ave" categorical fields are the fraction of the window each type
    was diagnosed. The largest fraction wins; ties go to the more impactful
    type (freezing rain > sleet > snow > rain). Where precipitation is below
    ``measurable`` inches the type is 0 (none); where it fell but no type was
    flagged, it is called rain.
    """
    stack = np.stack([np.asarray(x, dtype=np.float64) for x in (frzr, sleet, snow, rain)])
    codes = np.array([PTYPE_FZRA, PTYPE_SLEET, PTYPE_SNOW, PTYPE_RAIN], dtype=np.uint8)
    out = codes[np.argmax(stack, axis=0)]
    out = np.where(stack.max(axis=0) > 0, out, PTYPE_RAIN).astype(np.uint8)
    out[np.asarray(qpf_in) < measurable] = PTYPE_NONE
    return out


def encode_band(values: np.ndarray, band: Band) -> np.ndarray:
    """Physical values -> stored integers for ``band``.

    Rounds to the nearest step. Wrapped bands (directions) are taken modulo the
    wrap; everything else is clipped to the dtype's range. NaNs are refused:
    the format has no missing-value sentinel.
    """
    values = np.asarray(values, dtype=np.float64)
    if np.isnan(values).any():
        raise ValueError(f"{band.name}: values contain NaN; refusing to encode")
    q = np.rint((values - band.offset) / band.scale)
    if band.wrap is not None:
        q = np.mod(q, round(band.wrap / band.scale))
    q = np.clip(q, 0, band.max_stored)
    return q.astype(np.uint8 if band.dtype == "uint8" else np.uint16)


def decode_band(stored: np.ndarray, band: Band) -> np.ndarray:
    return np.asarray(stored, dtype=np.float64) * band.scale + band.offset


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
