"""How each stored field is computed from GRIB messages.

To add a field: put its search regex and bands in config.json, list the GRIB
variables it needs in GRIB_KEYS, and add a compute function to COMPUTE that
returns physical values for every band. See docs/adding-a-field.md.
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np

from .fields import (
    MS_TO_KT,
    classify_ptype,
    direction_from,
    kelvin_to_f,
    mm_to_in,
    pa_to_hpa,
    speed_kt,
)

# Logical name -> (GRIB shortName, typeOfLevel, level or None). Matched against
# cfgrib's GRIB_* attributes, never its variable names, which can change.
GRIB_KEYS: dict[str, tuple[str, str, float | None]] = {
    "u250": ("u", "isobaricInhPa", 250.0),
    "v250": ("v", "isobaricInhPa", 250.0),
    "t2m": ("2t", "heightAboveGround", 2.0),
    "d2m": ("2d", "heightAboveGround", 2.0),
    "u10": ("10u", "heightAboveGround", 10.0),
    "v10": ("10v", "heightAboveGround", 10.0),
    "gust": ("gust", "surface", None),
    # MSLET (NCEP's membrane reduction) rather than PRMSL: far smoother over
    # high terrain, which keeps isobars over the Rockies readable.
    "mslet": ("mslet", "meanSea", None),
    "tp": ("tp", "surface", None),
    "crain": ("crain", "surface", None),
    "csnow": ("csnow", "surface", None),
    "cicep": ("cicep", "surface", None),
    "cfrzr": ("cfrzr", "surface", None),
}

Arrays = dict[str, np.ndarray]

# field id -> (GRIB variables needed, function of cropped variables -> band values)
COMPUTE: dict[str, tuple[tuple[str, ...], Callable[[Arrays], Arrays]]] = {
    "wspd250": (("u250", "v250"), lambda g: {"speed": speed_kt(g["u250"], g["v250"])}),
    "wdir250": (("u250", "v250"), lambda g: {"dir": direction_from(g["u250"], g["v250"])}),
    "t2m": (("t2m",), lambda g: {"temp": kelvin_to_f(g["t2m"])}),
    "d2m": (("d2m",), lambda g: {"dewpt": kelvin_to_f(g["d2m"])}),
    "wspd10": (("u10", "v10"), lambda g: {"speed": speed_kt(g["u10"], g["v10"])}),
    "wdir10": (("u10", "v10"), lambda g: {"dir": direction_from(g["u10"], g["v10"])}),
    "gust": (("gust",), lambda g: {"gust": np.asarray(g["gust"], dtype=np.float64) * MS_TO_KT}),
    "mslp": (("mslet",), lambda g: {"mslp": pa_to_hpa(g["mslet"])}),
    "precip": (("tp", "crain", "csnow", "cicep", "cfrzr"), lambda g: _precip(g)),
}


def _precip(g: Arrays) -> Arrays:
    qpf = np.clip(mm_to_in(g["tp"]), 0, None)  # tiny negative packing noise -> 0
    return {"qpf": qpf, "ptype": classify_ptype(qpf, g["crain"], g["csnow"], g["cicep"], g["cfrzr"])}


def grib_vars_for(field_ids: list[str]) -> set[str]:
    return {v for fid in field_ids for v in COMPUTE[fid][0]}
