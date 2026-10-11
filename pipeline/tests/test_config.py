import copy
import json
import shutil

import pytest

from wxtrend.config import DEFAULT_CONFIG_DIR, ConfigError, load_config, parse_config, read_config


def raw():
    return read_config(DEFAULT_CONFIG_DIR)


def test_defaults_match_spec(product):
    assert product.id == "gfs"
    assert (product.model.id, product.model.name) == ("gfs", "GFS")
    assert (product.model.herbie_model, product.model.herbie_product) == ("gfs", "pgrb2.0p25")
    assert product.grid.id == "na025"
    assert [f.id for f in product.fields] == [
        "wspd250", "wdir250", "t2m", "d2m", "wspd10", "wdir10", "gust", "mslp", "precip"
    ]
    assert product.lags == (6, 12, 24, 48)
    assert product.default_lag == 48
    assert product.display_hours == list(range(0, 241, 6))


def test_config_lists_every_model_file():
    cfg = load_config()
    assert set(cfg.models) == {p.stem for p in (DEFAULT_CONFIG_DIR / "models").glob("*.json")}
    assert set(cfg.grids) == set(json.loads((DEFAULT_CONFIG_DIR / "grids.json").read_text()))
    assert cfg.product("gfs").model is cfg.models["gfs"]
    with pytest.raises(ConfigError, match="unknown product"):
        cfg.product("nope")


def test_config_dir_can_be_moved(tmp_path):
    shutil.copytree(DEFAULT_CONFIG_DIR, tmp_path / "config")
    assert load_config(tmp_path / "config").product("gfs").grid.nx == 481


def test_retention_covers_longest_lag(product):
    # 00Z current plus 18,12,06,00Z of the previous two days
    assert product.retained_runs == 9


def test_fetch_hours_extend_by_longest_lag(product):
    # f=240 at lag 48 needs the older run's F288
    assert product.fetch_hours[0] == 0
    assert product.fetch_hours[-1] == 288
    assert len(product.fetch_hours) == 49


def test_grid_dimensions(product):
    assert (product.grid.ny, product.grid.nx) == (221, 481)


def test_fields_are_limited_to_what_the_model_provides():
    r = raw()
    del r["models"]["gfs"]["fields"]["gust"]
    product = parse_config(r).product("gfs")
    assert "gust" not in [f.id for f in product.fields]
    # catalog order, whatever order the model file lists them in
    r["models"]["gfs"]["fields"] = dict(reversed(r["models"]["gfs"]["fields"].items()))
    assert [f.id for f in parse_config(r).product("gfs").fields] == [f.id for f in product.fields]


def test_products_of_one_model_share_its_settings():
    r = raw()
    r["grids"]["na05"] = {**r["grids"]["na025"], "resolution_deg": 0.5}
    r["models"]["gfs"]["products"]["gfs-half"] = {"grid": "na05"}
    cfg = parse_config(r)
    a, b = cfg.product("gfs"), cfg.product("gfs-half")
    assert (a.grid.nx, b.grid.nx) == (481, 241)
    assert a.model is b.model and a.fields == b.fields and a.lags == b.lags


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r["models"]["gfs"].update(default_lag_hours=36),
        lambda r: r["models"]["gfs"].update(lags_hours=[9]),
        lambda r: r["grids"]["na025"].update(lat_max=70.1),
        lambda r: r["grids"]["na025"].update(lat_min=80),
        lambda r: r["models"]["gfs"].pop("source"),
        lambda r: r.pop("models"),
        lambda r: r.update(models={}),
        lambda r: r["models"]["gfs"].update(products={}),
        lambda r: r["models"]["gfs"]["products"]["gfs"].update(grid="nowhere"),
        lambda r: r["models"]["gfs"]["products"].update(NAM={"grid": "na025"}),
        lambda r: r["models"].update(other=copy.deepcopy(r["models"]["gfs"])),  # product gfs twice
        lambda r: r["models"]["gfs"].update(fields={}),
        lambda r: r["models"]["gfs"]["fields"].update(cape={"search": ":CAPE:surface:"}),  # not in the catalog
    ],
)
def test_invalid_configs_rejected(mutate):
    r = copy.deepcopy(raw())
    mutate(r)
    with pytest.raises(ConfigError):
        parse_config(r)


def test_precip_search_uses_the_six_hour_bucket(product):
    precip = product.field("precip")
    assert precip.min_fhr == 6
    s = precip.search_for(120, product.fhr_step)
    assert ":APCP:surface:114-120 hour acc" in s
    assert ":(?:CRAIN|CSNOW|CICEP|CFRZR):surface:114-120 hour ave" in s


def test_search_for_hour_skips_fields_not_yet_available(product):
    assert "APCP" not in product.search_for(0)
    assert "APCP" in product.search_for(6)
    assert product.search_for(6, ["t2m"]) == ":TMP:2 m above ground:"
    assert [f.id for f in product.fields_for_hour(0)] == [f.id for f in product.fields if f.id != "precip"]


def test_band_encodings_fit_their_physical_range(product):
    t = product.field("t2m").bands[0]
    assert t.offset == -80 and t.offset + t.max_stored * t.scale >= 170  # -80..175 F
    p = product.field("mslp").bands[0]
    assert p.max_stored * p.scale >= 1084  # well above any observed MSLP
    d = product.field("wdir250").bands[0]
    assert d.wrap == 360 and round(d.wrap / d.scale) == 256


def test_existing_fields_have_no_nodata(product):
    # Declaring nodata clips valid values one step lower: an encoding change,
    # which needs a new field id (frames are cached as immutable).
    assert all(b.nodata is None for f in product.fields for b in f.bands)


def test_nodata_reserves_the_top_value():
    r = raw()
    r["fields"]["t2m"]["bands"][0]["nodata"] = 255
    r["fields"]["mslp"]["bands"][0]["nodata"] = 65535
    product = parse_config(r).product("gfs")
    t, p = product.field("t2m").bands[0], product.field("mslp").bands[0]
    assert (t.nodata, t.max_stored) == (255, 254)
    assert (p.nodata, p.max_stored) == (65535, 65534)
    assert t.manifest()["nodata"] == 255


def test_frame_bytes(product):
    assert product.field("wspd250").frame_bytes(481, 221) == 106_301
    assert product.field("precip").frame_bytes(481, 221) == 3 * 106_301  # uint16 + uint8


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r["fields"]["t2m"]["bands"][0].update(dtype="float32"),
        lambda r: r["fields"]["t2m"]["bands"][0].update(scale=0),
        lambda r: r["fields"]["wdir250"]["bands"][0].update(offset=5),
        lambda r: r["models"]["gfs"]["fields"]["t2m"].update(search=":TMP:{nope}:"),
        lambda r: r["fields"]["t2m"].update(bands=[]),
        lambda r: r["fields"]["t2m"]["bands"][0].update(nodata=0),
        lambda r: r["fields"]["mslp"]["bands"][0].update(nodata=255),
        # 360/1.40625 = 256 codes leaves none free for nodata
        lambda r: r["fields"]["wdir250"]["bands"][0].update(nodata=255),
    ],
)
def test_invalid_fields_rejected(mutate):
    r = copy.deepcopy(raw())
    mutate(r)
    with pytest.raises(ConfigError):
        parse_config(r)
