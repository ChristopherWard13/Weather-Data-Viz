"""Measured weather on a grid, for Modeled or Measured (build plan G2).

No dataset is raw observations on a grid. These are NOAA's analyses of them,
and the game says so:

- **URMA**, the Unrestricted Mesoscale Analysis (AWS ``noaa-urma-pds``): an
  hourly 2.5 km analysis of station observations over the Lower 48, on a model
  first guess, rerun about 6 hours late to take in late reports. 2 m
  temperature and dew point, and the 10 m gust. Each field is a byte range of
  the hour's file, found through its ``.idx``.
- **MRMS**, Multi-Radar Multi-Sensor (AWS ``noaa-mrms-pds``): radar rainfall
  over the past 24 hours corrected to rain gauges (``MultiSensor_QPE_24H_Pass2``),
  0.01°, gzipped. Points with no radar coverage are missing.

Both are averaged onto the game's 0.25° grid (the site's display spacing), each
cell from the points that fall in it, then smoothed with a Gaussian to about
the level of detail GFS has on that grid (``SMOOTH_CELLS``): left sharp, the
measured map's speckle gives it away before the weather does.
"""

from __future__ import annotations

import gzip
import logging
from datetime import datetime

import numpy as np
import requests
from scipy.ndimage import gaussian_filter

from ..net import retrying_session

log = logging.getLogger(__name__)

URMA_URL = ("https://noaa-urma-pds.s3.amazonaws.com/urma2p5.{t:%Y%m%d}/"
            "urma2p5.t{t:%H}z.2dvaranl_ndfd.grb2_wexp")
MRMS_URL = ("https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MultiSensor_QPE_24H_Pass2_00.00/{t:%Y%m%d}/"
            "MRMS_MultiSensor_QPE_24H_Pass2_00.00_{t:%Y%m%d-%H%M%S}.grib2.gz")

# URMA's .idx line for each variable, and its conversion to the site's units
URMA_VARS = {
    "t2m": (":TMP:2 m above ground:anl:", lambda k: (k - 273.15) * 9 / 5 + 32),  # °F
    "d2m": (":DPT:2 m above ground:anl:", lambda k: (k - 273.15) * 9 / 5 + 32),  # °F
    "gust": (":GUST:10 m above ground:anl:", lambda ms: ms * 3600 / 1852),  # kt
}
MM_PER_IN = 25.4

# Gaussian sigma, in 0.25° cells, that brings each measured field's fine detail
# down to GFS's on the same grid. Measured 2026-10-22 on Oct 19 and 21 (temperature
# at 12Z and 21Z, dew point and gust at 21Z) and Oct 20 and 22 (rain): the RMS of
# what a 2-cell blur removes, over Lower 48 land, matched GFS's at its F000-F003,
# about 3.5 days and 5 days ahead (build plan G2). Temperature: GFS 1.7-2.1 °F,
# URMA 2.1 sharp and 1.7-1.8 at 0.5; rain: GFS 0.009-0.038 in, MRMS 0.008-0.042 at 1.
SMOOTH_CELLS = {"t2m": 0.5, "d2m": 0.5, "gust": 0.5, "rain": 1.0}

# A cell is measured when at least this share of the points in it are
MIN_COVER = 0.5


def grid_axes(grid: dict) -> tuple[np.ndarray, np.ndarray]:
    """Cell centres: latitudes north to south, longitudes west to east."""
    lats = grid["lat0"] + grid["dlat"] * np.arange(grid["ny"])
    lons = grid["lon0"] + grid["dlon"] * np.arange(grid["nx"])
    return lats, lons


def block_mean(values: np.ndarray, lats: np.ndarray, lons: np.ndarray, grid: dict) -> np.ndarray:
    """The mean of the points in each cell of ``grid``; NaN where under MIN_COVER of them are valid.

    ``values``, ``lats`` and ``lons`` share a shape (any); NaN values are missing."""
    v = np.ravel(values)
    lat = np.ravel(lats)
    lon = (np.ravel(lons) + 180) % 360 - 180
    row = np.rint((grid["lat0"] - lat) / -grid["dlat"]).astype(np.int64)
    col = np.rint((lon - grid["lon0"]) / grid["dlon"]).astype(np.int64)
    inside = (row >= 0) & (row < grid["ny"]) & (col >= 0) & (col < grid["nx"])
    cell = row[inside] * grid["nx"] + col[inside]
    vv = v[inside]
    ok = ~np.isnan(vv)
    n = grid["ny"] * grid["nx"]
    total = np.bincount(cell, minlength=n)
    count = np.bincount(cell[ok], minlength=n)
    sums = np.bincount(cell[ok], weights=vv[ok], minlength=n)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = sums / count
    mean[(total == 0) | (count < MIN_COVER * total)] = np.nan
    return mean.reshape(grid["ny"], grid["nx"])


def smooth(values: np.ndarray, sigma: float) -> np.ndarray:
    """A Gaussian blur that ignores missing cells and leaves them missing."""
    if sigma <= 0:
        return values.copy()
    ok = ~np.isnan(values)
    num = gaussian_filter(np.where(ok, values, 0.0), sigma, mode="constant")
    den = gaussian_filter(ok.astype(float), sigma, mode="constant")
    with np.errstate(invalid="ignore", divide="ignore"):
        out = num / den
    out[~ok] = np.nan
    return out


def decode_grib(data: bytes) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """One GRIB2 message's values (NaN where missing) and each point's latitude and longitude."""
    import eccodes

    h = eccodes.codes_new_from_message(data)
    try:
        ni, nj = eccodes.codes_get(h, "Ni"), eccodes.codes_get(h, "Nj")
        values = eccodes.codes_get_values(h).astype(np.float64)
        if eccodes.codes_get(h, "bitmapPresent"):
            values[values == eccodes.codes_get(h, "missingValue")] = np.nan
        if eccodes.codes_get(h, "gridType") == "regular_ll":
            # MRMS: 24.5 million points, so build the axes rather than ask for every point's
            lat1 = eccodes.codes_get(h, "latitudeOfFirstGridPointInDegrees")
            lon1 = eccodes.codes_get(h, "longitudeOfFirstGridPointInDegrees")
            dlat = eccodes.codes_get(h, "jDirectionIncrementInDegrees")
            dlon = eccodes.codes_get(h, "iDirectionIncrementInDegrees")
            south_up = eccodes.codes_get(h, "jScansPositively")
            lat_axis = lat1 + (dlat if south_up else -dlat) * np.arange(nj)
            lon_axis = lon1 + dlon * np.arange(ni)
            lats, lons = np.meshgrid(lat_axis, lon_axis, indexing="ij")
        else:
            lats = eccodes.codes_get_array(h, "latitudes").reshape(nj, ni)
            lons = eccodes.codes_get_array(h, "longitudes").reshape(nj, ni)
        return values.reshape(nj, ni), lats, lons
    finally:
        eccodes.codes_release(h)


def _get(session: requests.Session, url: str, **kw) -> requests.Response:
    r = session.get(url, timeout=120, **kw)
    if r.status_code == 404:
        raise FileNotFoundError(url)
    r.raise_for_status()
    return r


def urma(valid: datetime, var: str, grid: dict, session: requests.Session | None = None) -> np.ndarray:
    """URMA's analysis of ``var`` (t2m, d2m or gust) at ``valid``, in the site's units, on ``grid``, unsmoothed."""
    session = session or retrying_session()
    url = URMA_URL.format(t=valid)
    line, convert = URMA_VARS[var]
    idx = _get(session, url + ".idx").text.splitlines()
    starts = [int(x.split(":")[1]) for x in idx]
    k = next((k for k, x in enumerate(idx) if line in x), None)
    if k is None:
        raise KeyError(f"{url}: no {line.strip(':')}")
    end = f"{starts[k + 1] - 1}" if k + 1 < len(starts) else ""
    data = _get(session, url, headers={"Range": f"bytes={starts[k]}-{end}"}).content
    values, lats, lons = decode_grib(data)
    return block_mean(convert(values), lats, lons, grid)


def mrms_rain_24h(ending: datetime, grid: dict, session: requests.Session | None = None) -> np.ndarray:
    """MRMS's gauge-corrected 24-hour rainfall ending at ``ending`` (inches) on ``grid``, unsmoothed."""
    session = session or retrying_session()
    data = gzip.decompress(_get(session, MRMS_URL.format(t=ending)).content)
    values, lats, lons = decode_grib(data)
    values[values < 0] = np.nan  # -1: no radar coverage, -3: missing
    return block_mean(values / MM_PER_IN, lats, lons, grid)
