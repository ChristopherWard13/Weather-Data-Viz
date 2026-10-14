"""How each stored field is computed from GRIB messages, per model.

To add a field: put its label and bands in config/fields.json, list it in the
model's file (config/models/<id>.json, with a search regex for Herbie sources),
list the GRIB variables it needs in GRIB_KEYS, and add a recipe to the model's
table in RECIPES that returns physical values for every band. See
docs/adding-a-field.md.

A recipe names the GRIB variables it needs. A need may read another forecast
step of the same run (``offset``): ECMWF's precipitation is a running total, so
the 6-hour amount at f is total(f) minus total(f-6). Inputs read at an offset
are keyed ``"<var>@<offset>"``, e.g. ``"tp@-6"``.

A need also says which messages it reads (``kind``): the step's one message
(``fc``), the mean of every ensemble member's message (``members``), or the
ensemble's own published mean (``em``). Only the ECMWF adapter reads the last
two, for the ECMWF ensemble.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from .config import Grid
from .fields import (
    MS_TO_KT,
    absolute_vorticity,
    accumulation_delta,
    classify_ptype,
    dewpoint_magnus,
    direction_from,
    ecmwf_ptype_override,
    kelvin_to_c,
    kelvin_to_f,
    mm_to_in,
    pa_to_hpa,
    snow_share_ptype,
    speed_kt,
    unspecified_ptype,
)

# Logical name -> (GRIB shortName, typeOfLevel, level or None). Matched against
# cfgrib's GRIB_* attributes, never its variable names, which can change. For
# ECMWF open data, shortName is also the index's "param".
GRIB_KEYS: dict[str, tuple[str, str, float | None]] = {
    "u250": ("u", "isobaricInhPa", 250.0),
    "v250": ("v", "isobaricInhPa", 250.0),
    "ws250": ("ws", "isobaricInhPa", 250.0),  # ECMWF ensemble mean: speed only, no components
    "u500": ("u", "isobaricInhPa", 500.0),
    "v500": ("v", "isobaricInhPa", 500.0),
    "gh500": ("gh", "isobaricInhPa", 500.0),
    "t850": ("t", "isobaricInhPa", 850.0),
    "t2m": ("2t", "heightAboveGround", 2.0),
    "d2m": ("2d", "heightAboveGround", 2.0),
    "rh2m": ("2r", "heightAboveGround", 2.0),  # GEFS mean: no 2 m dew point, so it's derived from T and RH
    "u10": ("10u", "heightAboveGround", 10.0),
    "v10": ("10v", "heightAboveGround", 10.0),
    "gust": ("gust", "surface", None),  # GFS: instantaneous
    "fg10": ("10fg", "heightAboveGround", 10.0),  # IFS: maximum since the previous post-processing
    "fg10_3h": ("10fg3", "heightAboveGround", 10.0),  # IFS: maximum in the last 3 hours
    # MSLET (NCEP's membrane reduction) rather than PRMSL: far smoother over
    # high terrain, which keeps isobars over the Rockies readable.
    "mslet": ("mslet", "meanSea", None),
    "msl": ("msl", "meanSea", None),  # ECMWF
    "prmsl": ("prmsl", "meanSea", None),  # GEFS, AIGFS, AIGEFS, HGEFS: the only sea-level pressure they publish
    # Water amounts are read in mm (fetch.WATER_TO_MM): GFS per 6-h bucket,
    # IFS and AIFS accumulated from T0
    "tp": ("tp", "surface", None),
    "sf": ("sf", "surface", None),  # ECMWF snowfall, water equivalent
    "ptype": ("ptype", "surface", None),  # ECMWF instantaneous precipitation type code
    "crain": ("crain", "surface", None),
    "csnow": ("csnow", "surface", None),
    "cicep": ("cicep", "surface", None),
    "cfrzr": ("cfrzr", "surface", None),
}

# Inputs that are codes, not quantities: a regridded product takes the nearest
# source point's value, never a weighted mean (regrid.py).
CATEGORICAL_VARS = frozenset({"ptype"})

Arrays = dict[str, np.ndarray]

# IFS posts hourly to F090, 3-hourly to F144, then 6-hourly.
IFS_HOURLY_UNTIL = 90
IFS_THREE_HOURLY_UNTIL = 144


# What a Need reads: the step's message (fc), the mean of the ensemble members'
# messages, or the ensemble's own published mean (em).
NEED_KINDS = ("fc", "members", "em")


@dataclass(frozen=True)
class Need:
    """One GRIB variable a recipe reads, optionally at another step of the run."""

    var: str  # a GRIB_KEYS name
    offset: int = 0  # hours from f: -6 reads the f-6 file
    when: Callable[[int], bool] | None = None  # only at hours where this is true
    kind: str = "fc"  # one of NEED_KINDS

    def __post_init__(self):
        if self.kind not in NEED_KINDS:
            raise ValueError(f"Need kind must be one of {NEED_KINDS}, got {self.kind!r}")

    @property
    def key(self) -> str:
        return self.var if self.offset == 0 else f"{self.var}@{self.offset}"

    def applies(self, fhr: int) -> bool:
        return self.when is None or self.when(fhr)


@dataclass(frozen=True)
class Recipe:
    needs: tuple[Need, ...]
    compute: Callable[[Arrays, Grid], Arrays]  # inputs by Need.key, display grid -> band values

    def needs_at(self, fhr: int) -> list[Need]:
        return [n for n in self.needs if n.applies(fhr)]


def recipe(needs: tuple[str | Need, ...], compute: Callable[[Arrays, Grid], Arrays]) -> Recipe:
    return Recipe(tuple(n if isinstance(n, Need) else Need(n) for n in needs), compute)


# ------------------------------------------------------------------ shared

def _vort500(g: Arrays, grid: Grid) -> Arrays:
    # From earth-relative u/v on the display grid, the same way for every model.
    return {"vort": absolute_vorticity(g["u500"], g["v500"], grid) * 1e5}


UPPER_AND_SURFACE: dict[str, Recipe] = {
    "wspd250": recipe(("u250", "v250"), lambda g, _: {"speed": speed_kt(g["u250"], g["v250"])}),
    "wdir250": recipe(("u250", "v250"), lambda g, _: {"dir": direction_from(g["u250"], g["v250"])}),
    "t2m": recipe(("t2m",), lambda g, _: {"temp": kelvin_to_f(g["t2m"])}),
    "d2m": recipe(("d2m",), lambda g, _: {"dewpt": kelvin_to_f(g["d2m"])}),
    "wspd10": recipe(("u10", "v10"), lambda g, _: {"speed": speed_kt(g["u10"], g["v10"])}),
    "wdir10": recipe(("u10", "v10"), lambda g, _: {"dir": direction_from(g["u10"], g["v10"])}),
    "hgt500": recipe(("gh500",), lambda g, _: {"hgt": np.asarray(g["gh500"], dtype=np.float64)}),  # gpm
    "vort500": recipe(("u500", "v500"), _vort500),
    "t850": recipe(("t850",), lambda g, _: {"temp": kelvin_to_c(g["t850"])}),
}

# ------------------------------------------------------------------ GFS


def _gfs_precip(g: Arrays, _grid: Grid) -> Arrays:
    qpf = np.clip(mm_to_in(g["tp"]), 0, None)  # tiny negative packing noise -> 0
    return {"qpf": qpf, "ptype": classify_ptype(qpf, g["crain"], g["csnow"], g["cicep"], g["cfrzr"])}


GFS: dict[str, Recipe] = {
    **UPPER_AND_SURFACE,
    "gust": recipe(("gust",), lambda g, _: {"gust": np.asarray(g["gust"], dtype=np.float64) * MS_TO_KT}),
    "mslp": recipe(("mslet",), lambda g, _: {"mslp": pa_to_hpa(g["mslet"])}),
    "precip": recipe(("tp", "crain", "csnow", "cicep", "cfrzr"), _gfs_precip),
}

# ------------------------------------------------------------------ ECMWF IFS and AIFS

def _six_hour_amounts(g: Arrays) -> tuple[np.ndarray, np.ndarray]:
    """6-h liquid-equivalent precipitation and snowfall (mm) from running totals (mm)."""
    return accumulation_delta(g["tp"], g["tp@-6"]), accumulation_delta(g["sf"], g["sf@-6"])


def _aifs_precip(g: Arrays, _grid: Grid) -> Arrays:
    liquid, snow = _six_hour_amounts(g)
    qpf = mm_to_in(liquid)
    return {"qpf": qpf, "ptype": snow_share_ptype(qpf, liquid, snow)}


def _ifs_precip(g: Arrays, _grid: Grid) -> Arrays:
    liquid, snow = _six_hour_amounts(g)
    qpf = mm_to_in(liquid)
    base = snow_share_ptype(qpf, liquid, snow)
    instants = [g["ptype"]] + ([g["ptype@-3"]] if "ptype@-3" in g else [])
    return {"qpf": qpf, "ptype": ecmwf_ptype_override(base, instants)}


_TOTALS = (Need("tp"), Need("sf"), Need("tp", -6), Need("sf", -6))

AIFS: dict[str, Recipe] = {
    **UPPER_AND_SURFACE,
    "mslp": recipe(("msl",), lambda g, _: {"mslp": pa_to_hpa(g["msl"])}),
    "precip": recipe(_TOTALS, _aifs_precip),
}

def _in_3h_gust_range(fhr: int) -> bool:
    return IFS_HOURLY_UNTIL < fhr <= IFS_THREE_HOURLY_UNTIL


def _ifs_gust(g: Arrays, _grid: Grid) -> Arrays:
    gust = g["fg10_3h"] if "fg10_3h" in g else g["fg10"]
    return {"gust": np.asarray(gust, dtype=np.float64) * MS_TO_KT}


IFS: dict[str, Recipe] = {
    **AIFS,
    # The gust window follows the output step, and so does its name: 10fg is
    # the maximum in the last hour to F090 and in the last 6 hours from F150
    # (stepRange 144-150); F093-F144 publish 10fg3, the last 3 hours. 10fg is
    # 0 at F000 (min_fhr 6).
    "gust": recipe(
        (Need("fg10", when=lambda f: not _in_3h_gust_range(f)), Need("fg10_3h", when=_in_3h_gust_range)),
        _ifs_gust,
    ),
    "precip": recipe(
        _TOTALS + (Need("ptype"), Need("ptype", -3, when=lambda f: f - 3 <= IFS_THREE_HOURLY_UNTIL)),
        _ifs_precip,
    ),
}

# ------------------------------------------------------------------ NOAA AI: AIGFS, AIGEFS and HGEFS means

def _prmsl(g: Arrays, _grid: Grid) -> Arrays:
    return {"mslp": pa_to_hpa(g["prmsl"])}


def _untyped_precip(g: Arrays, _grid: Grid) -> Arrays:
    qpf = np.clip(mm_to_in(g["tp"]), 0, None)  # the 6-h APCP bucket
    return {"qpf": qpf, "ptype": unspecified_ptype(qpf)}


# Their surface files have 10 m wind, 2 m temperature, PRMSL and 6-h APCP only:
# no dew point (nor humidity to derive it from), gust or precipitation type.
NOAA_AI: dict[str, Recipe] = {
    **{k: r for k, r in UPPER_AND_SURFACE.items() if k != "d2m"},
    "mslp": recipe(("prmsl",), _prmsl),
    "precip": recipe(("tp",), _untyped_precip),
}

# ------------------------------------------------------------------ GEFS mean (pgrb2ap5, 0.5°)


def _magnus_d2m(g: Arrays, _grid: Grid) -> Arrays:
    return {"dewpt": kelvin_to_f(dewpoint_magnus(g["t2m"], g["rh2m"]))}


GEFS: dict[str, Recipe] = {
    **UPPER_AND_SURFACE,
    "d2m": recipe(("t2m", "rh2m"), _magnus_d2m),
    "mslp": recipe(("prmsl",), _prmsl),
    # The member-mean CRAIN/CSNOW/CICEP/CFRZR at each 6-hourly step are 6-hour
    # averages, as GFS's are, so GFS's rule applies unchanged.
    "precip": recipe(("tp", "crain", "csnow", "cicep", "cfrzr"), _gfs_precip),
}

# ------------------------------------------------------------------ ECMWF ensemble mean (decision 14)

def _members(*names: str, offset: int = 0) -> tuple[Need, ...]:
    return tuple(Need(n, offset, kind="members") for n in names)


def _em(name: str) -> tuple[Need, ...]:
    return (Need(name, kind="em"),)


# The surface fields are means of the 50 open members: ECMWF's own mean files
# have none of them. Upper air and MSLP use ECMWF's mean (51 members, with the
# control), which has 250 mb speed but no direction. Means are linear, so the
# 6-h amount from member-mean totals equals the mean of each member's 6-h
# amount, and AIFS's snow-share rule applies to it as is.
ECMWF_ENS: dict[str, Recipe] = {
    "wspd250": recipe(_em("ws250"), lambda g, _: {"speed": np.asarray(g["ws250"], dtype=np.float64) * MS_TO_KT}),
    "t2m": recipe(_members("t2m"), UPPER_AND_SURFACE["t2m"].compute),
    "d2m": recipe(_members("d2m"), UPPER_AND_SURFACE["d2m"].compute),
    # Speed and direction of the mean wind vector, as the GEFS mean's winds are
    "wspd10": recipe(_members("u10", "v10"), UPPER_AND_SURFACE["wspd10"].compute),
    "wdir10": recipe(_members("u10", "v10"), UPPER_AND_SURFACE["wdir10"].compute),
    "mslp": recipe(_em("msl"), AIFS["mslp"].compute),
    "precip": recipe(_members("tp", "sf") + _members("tp", "sf", offset=-6), _aifs_precip),
    "hgt500": recipe(_em("gh500"), UPPER_AND_SURFACE["hgt500"].compute),
    "t850": recipe(_em("t850"), UPPER_AND_SURFACE["t850"].compute),
}

# The dry run (`wxtrend fetch`) checks the members' mean against the ensemble's
# own mean for one variable: model id -> (GRIB_KEYS name, largest allowed mean
# |difference| over the display grid, in its GRIB units). ECMWF's mean includes
# the control member, which isn't published, so the two differ by
# (members' mean - control) / 51, which grows with lead time. Measured on
# 2026-10-12 00Z and 12Z MSLP, F000-F360: mean |difference| 0.01-0.15 hPa, the
# largest single point 1.03 hPa (in a deep low), so the check limits the mean.
# Missing members, wrong units or a misaligned grid exceed it by far.
MEAN_CHECKS: dict[str, tuple[str, float]] = {"ecmwf-ens": ("msl", 30.0)}  # Pa: 0.3 hPa

# model id (config/models/<id>.json) -> field id -> recipe
RECIPES: dict[str, dict[str, Recipe]] = {
    "gfs": GFS, "ecmwf": IFS, "aifs": AIFS,
    "aigfs": NOAA_AI, "gefs": GEFS, "aigefs": NOAA_AI, "hgefs": NOAA_AI,
    "ecmwf-ens": ECMWF_ENS,
}


def recipes_for(model_id: str) -> dict[str, Recipe]:
    try:
        return RECIPES[model_id]
    except KeyError:
        raise KeyError(f"no recipes for model {model_id!r} in catalog.RECIPES") from None


def needs_for(model_id: str, field_ids: list[str], fhr: int) -> list[Need]:
    """Every distinct GRIB input the fields need at this hour."""
    recipes = recipes_for(model_id)
    out: dict[str, Need] = {}
    for fid in field_ids:
        for n in recipes[fid].needs_at(fhr):
            if out.setdefault(n.key, n).kind != n.kind:
                raise ValueError(f"{model_id}: {n.key} is read as both {out[n.key].kind} and {n.kind}")
    return list(out.values())


def grib_vars_for(model_id: str, field_ids: list[str], fhr: int = 6) -> set[str]:
    return {n.key for n in needs_for(model_id, field_ids, fhr)}
