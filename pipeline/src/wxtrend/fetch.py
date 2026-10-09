"""Fetch 250 mb U/V for one (run, forecast hour) and reduce it to a uint8 frame.

Herbie reads the GRIB2 ``.idx`` inventory and downloads only the two matching
messages by HTTP byte range (~1.2 MB instead of ~500 MB per file). Downloads
run in parallel threads; GRIB decoding goes through a lock because ecCodes is
not guaranteed to be thread-safe.
"""

from __future__ import annotations

import logging
import threading
import warnings
from datetime import datetime
from pathlib import Path

import numpy as np

from .config import Config
from .fields import crop_to_domain, encode_uint8, speed_kt

log = logging.getLogger(__name__)

_DECODE_LOCK = threading.Lock()


class UpstreamMissing(RuntimeError):
    """The requested GRIB2 file or inventory is not published."""


def fetch_frame(cfg: Config, init: datetime, fhr: int, work_dir: Path) -> np.ndarray:
    """Download, decode, crop, and encode one frame. Returns (ny, nx) uint8."""
    from herbie import Herbie  # deferred: slow import, and tests don't need it

    H = Herbie(
        init.replace(tzinfo=None),  # Herbie wants naive UTC
        model=cfg.model,
        product=cfg.product,
        fxx=fhr,
        priority=[cfg.source],
        save_dir=work_dir,
        overwrite=True,
        verbose=False,
    )
    if H.grib is None or H.idx is None:
        raise UpstreamMissing(f"{cfg.model} {init:%Y%m%d%H} f{fhr:03d} not found on {cfg.source}")

    path = H.download(cfg.search, verbose=False, errors="raise")
    if path is None or not Path(path).exists():
        raise UpstreamMissing(f"no messages matched {cfg.search!r} for {init:%Y%m%d%H} f{fhr:03d}")
    path = Path(path)
    try:
        with _DECODE_LOCK:
            u, v, lats, lons = _read_uv(path)
    finally:
        path.unlink(missing_ok=True)

    spd = speed_kt(u, v)
    cropped = crop_to_domain(spd, lats, lons, cfg.domain)
    return encode_uint8(cropped.data)


def _read_uv(path: Path):
    import cfgrib

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FutureWarning)
        datasets = cfgrib.open_datasets(str(path), backend_kwargs={"indexpath": ""})
    u = v = None
    for ds in datasets:
        if "u" in ds and u is None:
            u = ds["u"]
        if "v" in ds and v is None:
            v = ds["v"]
    if u is None or v is None:
        found = [list(ds.data_vars) for ds in datasets]
        raise ValueError(f"{path.name}: expected u and v, found {found}")
    for da in (u, v):
        level = float(da.coords["isobaricInhPa"]) if "isobaricInhPa" in da.coords else None
        if level != 250.0:
            raise ValueError(f"{path.name}: expected the 250 hPa level, got {level}")
    if u.dims != ("latitude", "longitude") or v.dims != u.dims:
        raise ValueError(f"{path.name}: unexpected dims {u.dims} / {v.dims}")
    lats = u["latitude"].values
    lons = u["longitude"].values
    u_vals = u.values.astype(np.float64)
    v_vals = v.values.astype(np.float64)
    for ds in datasets:
        ds.close()
    return u_vals, v_vals, lats, lons
