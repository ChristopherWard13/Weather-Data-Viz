"""Field math: unit conversions, derived quantities, band encoding, Δ, and domain cropping."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import Band, Grid

MS_TO_KT = 1.94384
MM_PER_IN = 25.4
EARTH_RADIUS_M = 6_371_000.0
EARTH_OMEGA = 7.2921e-5  # rotation rate, rad s-1


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


def kelvin_to_c(k) -> np.ndarray:
    return np.asarray(k, dtype=np.float64) - 273.15


# Magnus formula constants over water (Alduchov and Eskridge 1996), T in °C
MAGNUS_A = 17.625
MAGNUS_B = 243.04


def dewpoint_magnus(t_k, rh_pct) -> np.ndarray:
    """Dew point (K) from temperature (K) and relative humidity (%), by the Magnus formula.

        γ = ln(RH / 100) + a T / (b + T),   Td = b γ / (a − γ)

    with T and Td in °C. RH is clipped to 1–100 %: ensemble-mean RH can
    exceed 100 % slightly, and 0 % has no dew point.
    """
    t_c = np.asarray(t_k, dtype=np.float64) - 273.15
    rh = np.clip(np.asarray(rh_pct, dtype=np.float64), 1.0, 100.0)
    gamma = np.log(rh / 100.0) + MAGNUS_A * t_c / (MAGNUS_B + t_c)
    return MAGNUS_B * gamma / (MAGNUS_A - gamma) + 273.15


def pa_to_hpa(pa) -> np.ndarray:
    return np.asarray(pa, dtype=np.float64) / 100.0


def mm_to_in(mm) -> np.ndarray:
    return np.asarray(mm, dtype=np.float64) / MM_PER_IN


def absolute_vorticity(u, v, grid: Grid) -> np.ndarray:
    """Absolute vorticity ζ + f (s⁻¹) from earth-relative u/v (m s⁻¹) on a display grid.

    Rows run north to south, as on every display grid. Relative vorticity in
    flux form on the sphere, with centred differences:

        ζ = (∂v/∂λ − ∂(u cos φ)/∂φ) / (R cos φ)

    which is ∂v/∂x − ∂u/∂y + (u/R) tan φ with dx = R cos φ Δλ. The outermost
    rows and columns have no centred difference, so they are NaN (nodata), and
    so is any point next to a NaN input.
    """
    u = np.asarray(u, dtype=np.float64)
    v = np.asarray(v, dtype=np.float64)
    if u.shape != v.shape or u.shape != (grid.ny, grid.nx):
        raise ValueError(f"u {u.shape} and v {v.shape} must both be the grid's shape ({grid.ny}, {grid.nx})")
    step = np.radians(grid.resolution)
    phi = np.radians(grid.lat_max - grid.resolution * np.arange(grid.ny))[:, None]
    cos = np.cos(phi)
    dv_dlam = (v[1:-1, 2:] - v[1:-1, :-2]) / (2 * step)
    ucos = u * cos
    ducos_dphi = (ucos[:-2, 1:-1] - ucos[2:, 1:-1]) / (2 * step)  # row j-1 is one step north
    out = np.full(u.shape, np.nan)
    out[1:-1, 1:-1] = (dv_dlam - ducos_dphi) / (EARTH_RADIUS_M * cos[1:-1]) + 2 * EARTH_OMEGA * np.sin(phi[1:-1])
    return out


def accumulation_delta(total, earlier) -> np.ndarray:
    """Amount between two running totals, total(f) − total(f − 6). Small negative
    differences (packing noise) become 0."""
    return np.clip(np.asarray(total, dtype=np.float64) - np.asarray(earlier, dtype=np.float64), 0, None)


PTYPE_NONE, PTYPE_RAIN, PTYPE_SNOW, PTYPE_SLEET, PTYPE_FZRA, PTYPE_UNSPECIFIED = 0, 1, 2, 3, 4, 5
MEASURABLE_IN = 0.005  # below this the type is "none"


def classify_ptype(qpf_in, rain, snow, sleet, frzr, measurable: float = MEASURABLE_IN) -> np.ndarray:
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


def snow_share_ptype(qpf_in, liquid, snow, measurable: float = MEASURABLE_IN) -> np.ndarray:
    """Rain or snow from the snow share of the 6-hour amount (AIFS, ICON, and
    IFS before its overrides): snow where snowfall is at least half the
    liquid-equivalent total, else rain. ``liquid`` and ``snow`` are in the same
    units (water equivalent); below ``measurable`` inches the type is none."""
    liquid = np.asarray(liquid, dtype=np.float64)
    snow = np.asarray(snow, dtype=np.float64)
    out = np.where(snow >= 0.5 * liquid, PTYPE_SNOW, PTYPE_RAIN).astype(np.uint8)
    out[np.asarray(qpf_in) < measurable] = PTYPE_NONE
    return out


def unspecified_ptype(qpf_in, measurable: float = MEASURABLE_IN) -> np.ndarray:
    """Models with no type output (AIGFS, AIGEFS, HGEFS): "unspecified" where
    precipitation is measurable, else none. Never guessed from temperature."""
    return np.where(np.asarray(qpf_in) >= measurable, PTYPE_UNSPECIFIED, PTYPE_NONE).astype(np.uint8)


# ECMWF's instantaneous precipitation-type codes (GRIB2 code table 4.201,
# ECMWF local use): 1 rain, 3 freezing rain, 5 snow, 6 wet snow, 7 rain and
# snow, 8 ice pellets, 12 freezing drizzle.
ECMWF_FREEZING = (3, 12)
ECMWF_ICE_PELLETS = (8,)


def ecmwf_ptype_override(base, instants) -> np.ndarray:
    """IFS precipitation type: ``base`` (rain or snow from the snow share),
    overridden by freezing rain where any instantaneous ``ptype`` (at f, and
    at f − 3 where that step exists) says freezing rain or drizzle, else by
    sleet where any says ice pellets. Freezing rain wins a tie, as the more
    impactful type. Points with no precipitation (type none) stay none."""
    out = np.asarray(base).astype(np.uint8).copy()
    codes = [np.rint(np.nan_to_num(np.asarray(p, dtype=np.float64))).astype(int) for p in instants]
    sleet = np.zeros(out.shape, dtype=bool)
    frz = np.zeros(out.shape, dtype=bool)
    for c in codes:
        sleet |= np.isin(c, ECMWF_ICE_PELLETS)
        frz |= np.isin(c, ECMWF_FREEZING)
    wet = out != PTYPE_NONE
    out[wet & sleet] = PTYPE_SLEET
    out[wet & frz] = PTYPE_FZRA
    return out


def encode_band(values: np.ndarray, band: Band) -> np.ndarray:
    """Physical values -> stored integers for ``band``.

    Rounds to the nearest step. Wrapped bands (directions) are taken modulo the
    wrap; everything else is clipped to the valid range. A band with ``nodata``
    (frame format v3) stores NaN as that value and clips valid values to one
    below it. A band without ``nodata`` refuses NaN.
    """
    values = np.asarray(values, dtype=np.float64)
    missing = np.isnan(values)
    if missing.any() and band.nodata is None:
        raise ValueError(f"{band.name}: values contain NaN and the band has no nodata value; refusing to encode")
    q = np.rint((np.where(missing, band.offset, values) - band.offset) / band.scale)
    if band.wrap is not None:
        q = np.mod(q, round(band.wrap / band.scale))
    q = np.clip(q, 0, band.max_stored)
    if band.nodata is not None:
        q[missing] = band.nodata
    return q.astype(np.uint8 if band.dtype == "uint8" else np.uint16)


def decode_band(stored: np.ndarray, band: Band) -> np.ndarray:
    """Stored integers -> physical values; ``nodata`` samples become NaN."""
    stored = np.asarray(stored)
    values = stored.astype(np.float64) * band.scale + band.offset
    if band.nodata is not None:
        values[stored == band.nodata] = np.nan
    return values


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


def crop_to_domain(field: np.ndarray, lats: np.ndarray, lons: np.ndarray, grid: Grid) -> CropResult:
    """Crop a regular global lat/lon field to the display ``grid`` at native resolution.

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

    res = grid.resolution
    tol = res * 1e-3

    dlat = lats[1] - lats[0]
    dlon = lons[1] - lons[0]
    if abs(abs(dlat) - res) > tol or abs(dlon - res) > tol:
        raise ValueError(f"source grid spacing ({dlat}, {dlon}) does not match grid resolution {res}")

    want_lats = grid.lat_max - res * np.arange(grid.ny)
    want_lons = grid.lon_min + res * np.arange(grid.nx)

    rows = np.rint((want_lats - lats[0]) / dlat).astype(int)
    if rows.min() < 0 or rows.max() >= lats.size:
        raise ValueError("grid latitude range falls outside the source grid")

    n_lon = int(round(360.0 / res))
    if lons.size != n_lon:
        raise ValueError(f"expected a global longitude axis of {n_lon} points, got {lons.size}")
    cols = np.rint(((want_lons - lons[0]) % 360.0) / dlon).astype(int) % n_lon

    if not np.allclose(lats[rows], want_lats, atol=tol):
        raise AssertionError("latitude selection does not match the grid")
    got_lons = ((lons[cols] - want_lons + 180.0) % 360.0) - 180.0
    if not np.allclose(got_lons, 0.0, atol=tol):
        raise AssertionError("longitude selection does not match the grid")

    data = field[np.ix_(rows, cols)]
    return CropResult(data=np.ascontiguousarray(data), lats=want_lats, lons=want_lons)
