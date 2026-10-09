import numpy as np
import pytest

from wxtrend.catalog import COMPUTE, GRIB_KEYS, grib_vars_for
from wxtrend.fetch import match_grib_key

from .helpers import physical


def test_every_configured_field_has_a_compute_function(cfg):
    assert {f.id for f in cfg.fields} == set(COMPUTE)
    for fid, (needs, _) in COMPUTE.items():
        assert set(needs) <= set(GRIB_KEYS), fid


def test_compute_returns_every_band(cfg):
    shape = (3, 4)
    grib = {name: np.full(shape, 1.0) for name in GRIB_KEYS}
    grib["t2m"] = grib["d2m"] = np.full(shape, 273.15)
    grib["mslet"] = np.full(shape, 101325.0)
    grib["tp"] = np.full(shape, 25.4)
    for f in cfg.fields:
        needs, fn = COMPUTE[f.id]
        out = fn({k: grib[k] for k in needs})
        assert set(out) == {b.name for b in f.bands}, f.id
        for v in out.values():
            assert np.asarray(v).shape == shape
    assert COMPUTE["t2m"][1]({"t2m": grib["t2m"]})["temp"][0, 0] == pytest.approx(32)
    assert COMPUTE["mslp"][1]({"mslet": grib["mslet"]})["mslp"][0, 0] == pytest.approx(1013.25)
    precip = COMPUTE["precip"][1]({k: grib[k] for k in COMPUTE["precip"][0]})
    assert precip["qpf"][0, 0] == pytest.approx(1.0)
    assert precip["ptype"][0, 0] == 4  # all four flags tie -> freezing rain


def test_precip_clips_negative_packing_noise():
    needs, fn = COMPUTE["precip"]
    g = {k: np.zeros((1, 2)) for k in needs}
    g["tp"] = np.array([[-0.001, 0.0]])
    out = fn(g)
    assert out["qpf"].min() == 0 and out["ptype"].tolist() == [[0, 0]]


def test_grib_vars_for():
    assert grib_vars_for(["wspd250", "wdir250"]) == {"u250", "v250"}
    assert grib_vars_for(["precip"]) == {"tp", "crain", "csnow", "cicep", "cfrzr"}


@pytest.mark.parametrize(
    "attrs,coords,expected",
    [
        ({"GRIB_shortName": "u", "GRIB_typeOfLevel": "isobaricInhPa"}, {"isobaricInhPa": 250.0}, "u250"),
        ({"GRIB_shortName": "u", "GRIB_typeOfLevel": "isobaricInhPa"}, {"isobaricInhPa": 500.0}, None),
        ({"GRIB_shortName": "2t", "GRIB_typeOfLevel": "heightAboveGround"}, {"heightAboveGround": 2.0}, "t2m"),
        ({"GRIB_shortName": "10u", "GRIB_typeOfLevel": "heightAboveGround"}, {"heightAboveGround": 10.0}, "u10"),
        ({"GRIB_shortName": "mslet", "GRIB_typeOfLevel": "meanSea"}, {}, "mslet"),
        ({"GRIB_shortName": "prmsl", "GRIB_typeOfLevel": "meanSea"}, {}, None),
        ({"GRIB_shortName": "tp", "GRIB_typeOfLevel": "surface"}, {}, "tp"),
        ({"GRIB_shortName": "t", "GRIB_typeOfLevel": "isobaricInhPa"}, {"isobaricInhPa": 2.0}, None),
    ],
)
def test_match_grib_key(attrs, coords, expected):
    assert match_grib_key(attrs, coords) == expected


def test_helper_physical_matches_bands(cfg):
    assert set(physical(cfg, "precip")) == {"qpf", "ptype"}
