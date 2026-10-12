import numpy as np
import pytest

from wxtrend.catalog import GRIB_KEYS, IFS_THREE_HOURLY_UNTIL, RECIPES, grib_vars_for, needs_for, recipes_for
from wxtrend.config import load_config
from wxtrend.fetch import match_grib_key

from .helpers import physical

CFG = load_config()
PRODUCTS = sorted(CFG.products.values(), key=lambda p: p.id)


@pytest.mark.parametrize("product", PRODUCTS, ids=lambda p: p.id)
def test_every_configured_field_has_a_recipe(product):
    recipes = recipes_for(product.model.id)
    assert {f.id for f in product.fields} <= set(recipes)
    for fid, r in recipes.items():
        assert {n.var for n in r.needs} <= set(GRIB_KEYS), fid


def test_every_model_has_recipes():
    assert set(CFG.models) <= set(RECIPES)


def _inputs(product, fhr, shape=(3, 4)):
    """Plausible physical inputs (water amounts in mm) for every need at this hour."""
    g = {}
    for n in needs_for(product.model.id, [f.id for f in product.fields_for_hour(fhr)], fhr):
        g[n.key] = np.full(shape, {
            "t2m": 273.15, "d2m": 273.15, "t850": 273.15, "mslet": 101325.0, "msl": 101325.0,
            "gh500": 5640.0, "ptype": 1.0,
        }.get(n.var, 1.0))
    return g


@pytest.mark.parametrize("product", PRODUCTS, ids=lambda p: p.id)
@pytest.mark.parametrize("fhr", [0, 6, 150])
def test_recipes_return_every_band(product, fhr):
    grid = product.grid
    shape = (grid.ny, grid.nx)
    g = _inputs(product, fhr, shape)
    for f in product.fields_for_hour(fhr):
        r = recipes_for(product.model.id)[f.id]
        out = r.compute({n.key: g[n.key] for n in r.needs_at(fhr)}, grid)
        assert set(out) == {b.name for b in f.bands}, f.id
        for v in out.values():
            assert np.asarray(v).shape == shape


def test_unit_conversions(product):
    grid = product.grid
    shape = (grid.ny, grid.nx)
    g = _inputs(product, 6, shape)
    gfs = RECIPES["gfs"]
    assert gfs["t2m"].compute(g, grid)["temp"][0, 0] == pytest.approx(32)
    assert gfs["t850"].compute(g, grid)["temp"][0, 0] == pytest.approx(0)
    assert gfs["hgt500"].compute(g, grid)["hgt"][0, 0] == pytest.approx(5640)
    assert gfs["mslp"].compute(g, grid)["mslp"][0, 0] == pytest.approx(1013.25)
    ecmwf = _inputs(CFG.product("ecmwf"), 6, shape)
    assert RECIPES["ecmwf"]["mslp"].compute(ecmwf, grid)["mslp"][0, 0] == pytest.approx(1013.25)
    assert RECIPES["ecmwf"]["gust"].compute(ecmwf, grid)["gust"][0, 0] == pytest.approx(1.94384)


def test_gfs_precip():
    fn = RECIPES["gfs"]["precip"].compute
    g = {k: np.ones((1, 1)) for k in ("crain", "csnow", "cicep", "cfrzr")}
    g["tp"] = np.full((1, 1), 25.4)
    out = fn(g, None)
    assert out["qpf"][0, 0] == pytest.approx(1.0)
    assert out["ptype"][0, 0] == 4  # all four flags tie -> freezing rain


def test_gfs_precip_clips_negative_packing_noise():
    fn = RECIPES["gfs"]["precip"].compute
    g = {k: np.zeros((1, 2)) for k in ("crain", "csnow", "cicep", "cfrzr")}
    g["tp"] = np.array([[-0.001, 0.0]])
    out = fn(g, None)
    assert out["qpf"].min() == 0 and out["ptype"].tolist() == [[0, 0]]


def test_ecmwf_precip_is_the_six_hour_difference_of_running_totals():
    # Running totals in mm at f and f-6, hand-computed 6-h amounts:
    #   point 0: 30.4 - 5.0 = 25.4 mm = 1.00 in, snow 20 of 25.4 -> snow
    #   point 1: 12.7 - 0.0 = 12.7 mm = 0.50 in, snow 2 of 12.7 -> rain
    #   point 2: packing noise (total went down) -> 0, none
    g = {
        "tp": np.array([[30.4, 12.7, 3.0]]), "tp@-6": np.array([[5.0, 0.0, 3.0001]]),
        "sf": np.array([[21.0, 2.0, 0.0]]), "sf@-6": np.array([[1.0, 0.0, 0.0]]),
        "ptype": np.array([[5.0, 1.0, 0.0]]),
    }
    out = RECIPES["aifs"]["precip"].compute(g, None)
    np.testing.assert_allclose(out["qpf"], [[1.0, 0.5, 0.0]], atol=1e-9)
    assert out["ptype"].tolist() == [[2, 1, 0]]
    ifs = RECIPES["ecmwf"]["precip"].compute(g, None)  # no freezing or pellet codes: same answer
    assert ifs["ptype"].tolist() == [[2, 1, 0]]


def test_ifs_precip_type_overrides_from_instantaneous_codes():
    base = {
        "tp": np.full((1, 4), 10.0), "tp@-6": np.zeros((1, 4)),
        "sf": np.zeros((1, 4)), "sf@-6": np.zeros((1, 4)),
    }
    # f: ice pellets, freezing drizzle, rain, freezing rain; f-3: freezing rain at point 0
    g = {**base, "ptype": np.array([[8.0, 12.0, 1.0, 3.0]]), "ptype@-3": np.array([[3.0, 0.0, 8.0, 8.0]])}
    out = RECIPES["ecmwf"]["precip"].compute(g, None)
    # 0: sleet at f, freezing rain at f-3 -> freezing rain wins; 1: freezing drizzle -> freezing rain;
    # 2: pellets at f-3 -> sleet; 3: freezing rain at f beats pellets at f-3
    assert out["ptype"].tolist() == [[4, 4, 3, 4]]
    # Beyond F144 there's no f-3 step; only the instant at f counts
    out = RECIPES["ecmwf"]["precip"].compute({**base, "ptype": np.array([[8.0, 12.0, 1.0, 3.0]])}, None)
    assert out["ptype"].tolist() == [[3, 4, 1, 4]]


def test_ifs_precip_needs_f_minus_3_only_where_ifs_posts_three_hourly():
    keys = lambda f: {n.key for n in needs_for("ecmwf", ["precip"], f)}  # noqa: E731
    assert keys(6) == {"tp", "sf", "tp@-6", "sf@-6", "ptype", "ptype@-3"}
    assert "ptype@-3" in keys(IFS_THREE_HOURLY_UNTIL)
    assert keys(IFS_THREE_HOURLY_UNTIL + 6) == {"tp", "sf", "tp@-6", "sf@-6", "ptype"}
    assert {n.key for n in needs_for("aifs", ["precip"], 6)} == {"tp", "sf", "tp@-6", "sf@-6"}


def test_ifs_gust_reads_the_parameter_published_at_each_hour():
    gust = lambda f: {n.key for n in needs_for("ecmwf", ["gust"], f)}  # noqa: E731
    assert gust(6) == gust(90) == gust(150) == gust(360) == {"fg10"}  # last 1 h, then last 6 h
    assert gust(96) == gust(144) == {"fg10_3h"}  # last 3 h
    out = RECIPES["ecmwf"]["gust"].compute({"fg10_3h": np.full((1, 1), 10.0)}, None)
    assert out["gust"][0, 0] == pytest.approx(19.4384)


def test_grib_vars_for():
    assert grib_vars_for("gfs", ["wspd250", "wdir250"]) == {"u250", "v250"}
    assert grib_vars_for("gfs", ["precip"]) == {"tp", "crain", "csnow", "cicep", "cfrzr"}
    assert grib_vars_for("gfs", ["vort500", "hgt500", "t850"]) == {"u500", "v500", "gh500", "t850"}
    assert grib_vars_for("ecmwf", ["gust", "mslp"]) == {"fg10", "msl"}
    assert grib_vars_for("ecmwf", ["gust"], 120) == {"fg10_3h"}


def test_gfs_recipes_read_one_step():
    # The Herbie adapter downloads one file per hour
    assert all(n.offset == 0 for r in RECIPES["gfs"].values() for n in r.needs)


@pytest.mark.parametrize(
    "attrs,coords,expected",
    [
        ({"GRIB_shortName": "u", "GRIB_typeOfLevel": "isobaricInhPa"}, {"isobaricInhPa": 250.0}, "u250"),
        ({"GRIB_shortName": "u", "GRIB_typeOfLevel": "isobaricInhPa"}, {"isobaricInhPa": 500.0}, "u500"),
        ({"GRIB_shortName": "u", "GRIB_typeOfLevel": "isobaricInhPa"}, {"isobaricInhPa": 300.0}, None),
        ({"GRIB_shortName": "gh", "GRIB_typeOfLevel": "isobaricInhPa"}, {"isobaricInhPa": 500.0}, "gh500"),
        ({"GRIB_shortName": "t", "GRIB_typeOfLevel": "isobaricInhPa"}, {"isobaricInhPa": 850.0}, "t850"),
        ({"GRIB_shortName": "2t", "GRIB_typeOfLevel": "heightAboveGround"}, {"heightAboveGround": 2.0}, "t2m"),
        ({"GRIB_shortName": "10u", "GRIB_typeOfLevel": "heightAboveGround"}, {"heightAboveGround": 10.0}, "u10"),
        ({"GRIB_shortName": "10fg", "GRIB_typeOfLevel": "heightAboveGround"}, {"heightAboveGround": 10.0}, "fg10"),
        ({"GRIB_shortName": "10fg3", "GRIB_typeOfLevel": "heightAboveGround"}, {"heightAboveGround": 10.0},
         "fg10_3h"),
        ({"GRIB_shortName": "mslet", "GRIB_typeOfLevel": "meanSea"}, {}, "mslet"),
        ({"GRIB_shortName": "msl", "GRIB_typeOfLevel": "meanSea"}, {"meanSea": 0.0}, "msl"),
        ({"GRIB_shortName": "prmsl", "GRIB_typeOfLevel": "meanSea"}, {}, None),
        ({"GRIB_shortName": "tp", "GRIB_typeOfLevel": "surface"}, {}, "tp"),
        ({"GRIB_shortName": "ptype", "GRIB_typeOfLevel": "surface"}, {"surface": 0.0}, "ptype"),
        ({"GRIB_shortName": "t", "GRIB_typeOfLevel": "isobaricInhPa"}, {"isobaricInhPa": 2.0}, None),
    ],
)
def test_match_grib_key(attrs, coords, expected):
    assert match_grib_key(attrs, coords) == expected


def test_helper_physical_matches_bands(product):
    assert set(physical(product, "precip")) == {"qpf", "ptype"}
