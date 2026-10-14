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
ensemble's own published mean (``em``). The ECMWF adapter reads all three, for
the ECMWF ensemble; the Herbie adapter also reads ``members``, for the GEFS
mean's snowfall. A ``members`` need may name a ``MEMBER_PRODUCTS`` variable,
worked out from each member's own messages before the mean is taken.
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
    snowfall_from_flag,
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

# Per-file sources (GDPS, ICON) put one message in each file, so the file says
# which variable it holds (the model's source.variables), and their variables
# are named here rather than in GRIB_KEYS. Each message is checked against its
# variable's WMO parameter (discipline, category, number: any of these), level
# and time window (FILE_WINDOWS), which, unlike ecCodes' shortNames, don't depend
# on ecCodes' tables: GDPS's 6-h total decodes as shortName "unknown". The
# window tells a 6-h bucket from a running total of the same parameter (GDPS
# publishes both, and they differ by up to 52 mm at F006). Accumulations are
# amounts in kg m-2 (mm) even where the parameter is a rate (kg m-2 s-1)
# accumulated over the step: GDPS's ice pellets and ICON's totals. Checked
# 2026-10-14: GDPS's four typed 6-h amounts sum to its total within 0.03 mm,
# and ICON's rain and snow to its tot_prec within 0.003 mm, at every point.
FILE_KEYS: dict[str, tuple[tuple[tuple[int, int, int], ...], str, float | None, str]] = {
    "t2m": (((0, 0, 0),), "heightAboveGround", 2, "instant"),
    "d2m": (((0, 0, 6),), "heightAboveGround", 2, "instant"),
    "u10": (((0, 2, 2),), "heightAboveGround", 10, "instant"),
    "v10": (((0, 2, 3),), "heightAboveGround", 10, "instant"),
    "u250": (((0, 2, 2),), "isobaricInhPa", 250, "instant"),
    "v250": (((0, 2, 3),), "isobaricInhPa", 250, "instant"),
    "u500": (((0, 2, 2),), "isobaricInhPa", 500, "instant"),
    "v500": (((0, 2, 3),), "isobaricInhPa", 500, "instant"),
    "gh500": (((0, 3, 5),), "isobaricInhPa", 500, "instant"),  # GDPS: gpm
    "z500": (((0, 3, 4),), "isobaricInhPa", 500, "instant"),  # ICON: geopotential (m2 s-2), not height
    "t850": (((0, 0, 0),), "isobaricInhPa", 850, "instant"),
    "prmsl": (((0, 3, 1),), "meanSea", None, "instant"),
    "i10fg": (((0, 2, 22),), "heightAboveGround", 10, "instant"),  # GDPS: instantaneous gust
    "vmax10": (((0, 2, 22),), "heightAboveGround", 10, "last_hour"),  # ICON: maximum in the last hour
    # GDPS's 6-h buckets: total, rain, snow, ice pellets, freezing rain
    "tp6": (((0, 1, 8),), "surface", None, "6h"),
    "rain6": (((0, 1, 65),), "surface", None, "6h"),
    "sf6": (((0, 1, 66),), "surface", None, "6h"),
    "icep6": (((0, 1, 68),), "surface", None, "6h"),
    "fzra6": (((0, 1, 67),), "surface", None, "6h"),
    # ICON's running totals: total precipitation, grid-scale and convective snow
    "tp": (((0, 1, 52),), "surface", None, "since_t0"),
    "snow_gsp": (((0, 1, 56),), "surface", None, "since_t0"),
    "snow_con": (((0, 1, 55),), "surface", None, "since_t0"),
}

# What FILE_KEYS' windows mean: the ecCodes stepType, and the (start, end) step
# in hours of a message valid at step f
FILE_WINDOWS: dict[str, tuple[str, Callable[[int], tuple[int, int]]]] = {
    "instant": ("instant", lambda f: (f, f)),
    "6h": ("accum", lambda f: (f - 6, f)),
    "since_t0": ("accum", lambda f: (0, f)),
    "last_hour": ("max", lambda f: (f - 1, f)),
}

# Variables made from each member's own messages before averaging: name ->
# (GRIB_KEYS inputs, function of them). The GEFS mean's snowfall (decision 15)
# is the mean of each of its 30 members' CSNOW x APCP, since a mean of products
# isn't the product of means.
MEMBER_PRODUCTS: dict[str, tuple[tuple[str, ...], Callable[[dict[str, np.ndarray]], np.ndarray]]] = {
    "snow_tp": (("tp", "csnow"), lambda g: snowfall_from_flag(g["tp"], g["csnow"])),  # mm
}


def member_inputs(var: str) -> tuple[str, ...]:
    """The GRIB_KEYS variables a members need reads from each member."""
    return MEMBER_PRODUCTS[var][0] if var in MEMBER_PRODUCTS else (var,)


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


def _flag_snow(g: Arrays, _grid: Grid) -> Arrays:
    # GFS has no snowfall field: the 6-h average snow flag (the share of the
    # window it was snowing) times the 6-h bucket, labelled as derived
    return {"sf": mm_to_in(snowfall_from_flag(g["tp"], g["csnow"]))}


GFS: dict[str, Recipe] = {
    **UPPER_AND_SURFACE,
    "gust": recipe(("gust",), lambda g, _: {"gust": np.asarray(g["gust"], dtype=np.float64) * MS_TO_KT}),
    "mslp": recipe(("mslet",), lambda g, _: {"mslp": pa_to_hpa(g["mslet"])}),
    "precip": recipe(("tp", "crain", "csnow", "cicep", "cfrzr"), _gfs_precip),
    "snow": recipe(("tp", "csnow"), _flag_snow),
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


def _snowfall(g: Arrays, _grid: Grid) -> Arrays:
    """6-h snowfall (in, liquid equivalent) from the running snowfall totals: the model's own."""
    return {"sf": mm_to_in(accumulation_delta(g["sf"], g["sf@-6"]))}


_TOTALS = (Need("tp"), Need("sf"), Need("tp", -6), Need("sf", -6))

AIFS: dict[str, Recipe] = {
    **UPPER_AND_SURFACE,
    "mslp": recipe(("msl",), lambda g, _: {"mslp": pa_to_hpa(g["msl"])}),
    "precip": recipe(_TOTALS, _aifs_precip),
    "snow": recipe((Need("sf"), Need("sf", -6)), _snowfall),
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
    # The mean of the 30 members' own snow flag x precipitation (decision 15)
    "snow": recipe((Need("snow_tp", kind="members"),), lambda g, _: {"sf": mm_to_in(g["snow_tp"])}),
}

# ------------------------------------------------------------------ GDPS (GEM global, 0.15°)


def _gdps_precip(g: Arrays, _grid: Grid) -> Arrays:
    # 6-h buckets of each type: the largest names the window's type, ties going
    # to the more impactful one, as GFS's fractions do
    qpf = np.clip(mm_to_in(g["tp6"]), 0, None)
    return {"qpf": qpf, "ptype": classify_ptype(qpf, g["rain6"], g["sf6"], g["icep6"], g["fzra6"])}


GDPS: dict[str, Recipe] = {
    **UPPER_AND_SURFACE,  # 500 mb heights are gpm (checked 2026-10-14), so used as they are
    # The instantaneous gust (decision 16), not WindGust-Max, whose window isn't stated
    "gust": recipe(("i10fg",), lambda g, _: {"gust": np.asarray(g["i10fg"], dtype=np.float64) * MS_TO_KT}),
    "mslp": recipe(("prmsl",), _prmsl),
    "precip": recipe(("tp6", "rain6", "sf6", "icep6", "fzra6"), _gdps_precip),
    "snow": recipe(("sf6",), lambda g, _: {"sf": mm_to_in(np.clip(g["sf6"], 0, None))}),  # its own 6-h snow
}

# ------------------------------------------------------------------ ICON (icosahedral, 13 km)

GRAVITY = 9.80665  # m s-2: geopotential to geopotential metres


def _icon_snow_mm(g: Arrays) -> np.ndarray:
    """ICON's 6-h snowfall (mm, liquid equivalent): its grid-scale plus convective snow,
    from their running totals."""
    return accumulation_delta(g["snow_gsp"] + g["snow_con"], g["snow_gsp@-6"] + g["snow_con@-6"])


def _icon_precip(g: Arrays, _grid: Grid) -> Arrays:
    liquid = accumulation_delta(g["tp"], g["tp@-6"])
    qpf = mm_to_in(liquid)
    return {"qpf": qpf, "ptype": snow_share_ptype(qpf, liquid, _icon_snow_mm(g))}


_ICON_SNOW = (Need("snow_gsp"), Need("snow_con"), Need("snow_gsp", -6), Need("snow_con", -6))

ICON: dict[str, Recipe] = {
    **UPPER_AND_SURFACE,
    "hgt500": recipe(("z500",), lambda g, _: {"hgt": np.asarray(g["z500"], dtype=np.float64) / GRAVITY}),
    # The maximum in the last hour, at every step (also where output is 3-hourly)
    "gust": recipe(("vmax10",), lambda g, _: {"gust": np.asarray(g["vmax10"], dtype=np.float64) * MS_TO_KT}),
    "mslp": recipe(("prmsl",), _prmsl),
    "precip": recipe((Need("tp"), Need("tp", -6)) + _ICON_SNOW, _icon_precip),
    "snow": recipe(_ICON_SNOW, lambda g, _: {"sf": mm_to_in(_icon_snow_mm(g))}),
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
    "snow": recipe(_members("sf") + _members("sf", offset=-6), _snowfall),
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
#
# GEFS: the 30 perturbed members' 6-h APCP against geavg's, which averages the
# same 30 (not the control). Measured on 2026-10-12 00Z, F006-F384: mean
# |difference| 0.013-0.019 mm, the largest 0.05 mm (geavg's packing).
MEAN_CHECKS: dict[str, tuple[str, float]] = {
    "ecmwf-ens": ("msl", 30.0),  # Pa: 0.3 hPa
    "gefs": ("tp", 0.05),  # mm
}

# Herbie sources: the field whose search finds the checked variable in the
# ensemble's own file and in each member's.
MEAN_CHECK_FIELDS: dict[str, str] = {"gefs": "snow"}

# model id (config/models/<id>.json) -> field id -> recipe
RECIPES: dict[str, dict[str, Recipe]] = {
    "gfs": GFS, "ecmwf": IFS, "aifs": AIFS,
    "aigfs": NOAA_AI, "gefs": GEFS, "aigefs": NOAA_AI, "hgefs": NOAA_AI,
    "ecmwf-ens": ECMWF_ENS,
    "gdps": GDPS, "icon": ICON,
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
