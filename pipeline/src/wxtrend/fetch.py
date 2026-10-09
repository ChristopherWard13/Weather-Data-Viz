"""Fetch every needed GRIB message for one (run, forecast hour) in a single
byte-range download, then compute each field's bands.

Herbie reads the ``.idx`` inventory and downloads only the matching messages
(~6.5 MB per hour for all fields, instead of ~500 MB per file). Decoding is
done by cfgrib; variables are identified by their GRIB attributes (shortName,
typeOfLevel, level) via ``catalog.GRIB_KEYS``. The update step runs this in
worker processes, so ecCodes is never shared between threads.
"""

from __future__ import annotations

import logging
import threading
import warnings
from datetime import datetime
from pathlib import Path

import numpy as np

from .catalog import COMPUTE, GRIB_KEYS, grib_vars_for
from .config import Config
from .fields import crop_to_domain

log = logging.getLogger(__name__)

_DECODE_LOCK = threading.Lock()

Values = dict[str, dict[str, np.ndarray]]  # field id -> band name -> physical values


class UpstreamMissing(RuntimeError):
    """The requested GRIB2 file, inventory, or messages are not published."""


def fetch_hour(cfg: Config, init: datetime, fhr: int, field_ids: list[str], work_dir: Path) -> Values:
    from herbie import Herbie  # deferred: slow import, and tests don't need it

    search = cfg.search_for(fhr, field_ids)
    if not search:
        raise ValueError(f"no fields {field_ids} exist at f{fhr:03d}")
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
    tag = f"{cfg.model} {init:%Y%m%d%H} f{fhr:03d}"
    if H.grib is None or H.idx is None:
        raise UpstreamMissing(f"{tag} not found on {cfg.source}")

    path = H.download(search, verbose=False, errors="raise")
    if path is None or not Path(path).exists():
        raise UpstreamMissing(f"{tag}: no messages matched {search!r}")
    path = Path(path)
    try:
        with _DECODE_LOCK:
            grib, lats, lons = read_grib_vars(path, grib_vars_for(field_ids))
    finally:
        path.unlink(missing_ok=True)

    cropped = {k: crop_to_domain(v, lats, lons, cfg.domain).data for k, v in grib.items()}
    return {fid: COMPUTE[fid][1](cropped) for fid in field_ids}


def read_grib_vars(path: Path, wanted: set[str]):
    """Return ({logical name: 2-D array}, lats, lons) for the ``wanted`` variables."""
    import cfgrib

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FutureWarning)
        datasets = cfgrib.open_datasets(str(path), backend_kwargs={"indexpath": ""})
    found: dict[str, np.ndarray] = {}
    lats = lons = None
    try:
        for ds in datasets:
            for da in ds.data_vars.values():
                name = match_grib_key(da.attrs, ds.coords)
                if name is None or name not in wanted or name in found:
                    continue  # duplicates (e.g. F006's two identical APCP messages): first wins
                if da.dims != ("latitude", "longitude"):
                    raise ValueError(f"{path.name}: {name} has dims {da.dims}")
                found[name] = da.values.astype(np.float64)
                lats = da["latitude"].values
                lons = da["longitude"].values
    finally:
        for ds in datasets:
            ds.close()
    missing = sorted(wanted - found.keys())
    if missing:
        raise UpstreamMissing(f"{path.name}: GRIB variables not found: {missing}")
    return found, lats, lons


def match_grib_key(attrs, coords) -> str | None:
    short = attrs.get("GRIB_shortName")
    tol = attrs.get("GRIB_typeOfLevel")
    for name, (k_short, k_tol, k_level) in GRIB_KEYS.items():
        if short != k_short or tol != k_tol:
            continue
        if k_level is not None:
            if tol not in coords or float(coords[tol]) != k_level:
                continue
        return name
    return None

