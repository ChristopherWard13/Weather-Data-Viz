import copy
import json
import shutil

import pytest

from wxtrend.alignment import utc
from wxtrend.config import DEFAULT_CONFIG_DIR, ConfigError, load_config, parse_config, read_config


def raw():
    return read_config(DEFAULT_CONFIG_DIR)


def test_defaults_match_spec(product):
    assert product.id == "gfs"
    assert (product.model.id, product.model.name) == ("gfs", "GFS")
    assert product.model.adapter == "herbie"
    assert (product.model.herbie_model, product.model.herbie_product) == ("gfs", "pgrb2.0p25")
    assert product.grid.id == "na025"
    assert [f.id for f in product.fields] == [
        "wspd250", "wdir250", "t2m", "d2m", "wspd10", "wdir10", "gust", "mslp", "precip", "snow",
        "hgt500", "vort500", "t850",
    ]
    assert product.lags == (6, 12, 24, 48)
    assert product.default_lag == 48
    assert product.display_hours == list(range(0, 385, 6))  # GFS's full range


def test_ecmwf_products():
    cfg = load_config()
    ifs, aifs = cfg.product("ecmwf"), cfg.product("aifs")
    assert (ifs.model.name, aifs.model.name) == ("ECMWF", "AIFS")
    assert ifs.model.adapter == aifs.model.adapter == "ecmwf_opendata"
    # IFS: only the 00/12Z runs reach 360 h
    assert (ifs.cycle_interval_hours, ifs.lags, ifs.retained_runs) == (12, (12, 24, 48), 5)
    assert (aifs.cycle_interval_hours, aifs.lags, aifs.retained_runs) == (6, (6, 12, 24, 48), 9)
    for p in (ifs, aifs):
        assert p.display_hours == p.fetch_hours == list(range(0, 361, 6))
        assert p.workers <= 4 and p.model.max_connections == 4  # the bucket throttles bursts
        assert all(f.search is None for f in p.fields)
    assert "gust" not in [f.id for f in aifs.fields]  # AIFS has no gust output
    assert ifs.field("gust").min_fhr == 6  # 10fg is 0 at step 0
    assert ifs.model.index_url_for(utc(2026, 10, 9, 12), 6) == (
        "https://storage.googleapis.com/ecmwf-open-data/20261009/12z/ifs/0p25/oper/20261009120000-6h-oper-fc.index"
    )
    assert aifs.model.index_url_for(utc(2026, 10, 9, 6), 360).endswith(
        "/20261009/06z/aifs-single/0p25/oper/20261009060000-360h-oper-fc.index"
    )


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


def test_fetch_hours_stop_at_the_models_last_hour(product):
    # Showing the full range: nothing past F384 to fetch for 48-hour comparisons
    assert product.fetch_hours == product.display_hours
    assert product.fetch_hours[-1] == 384
    assert len(product.fetch_hours) == 65


def test_fetch_hours_extend_by_longest_lag_when_the_model_runs_longer():
    # min(display max + max lag, model max): f=240 at lag 48 needs the older run's F288
    r = raw()
    r["models"]["gfs"]["forecast_hours"]["max"] = 240
    p = parse_config(r).product("gfs")
    assert (p.fetch_hours[0], p.fetch_hours[-1], len(p.fetch_hours)) == (0, 288, 49)
    r["models"]["gfs"]["forecast_hours"]["max"] = 360
    assert parse_config(r).product("gfs").fetch_hours[-1] == 384


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
        lambda r: r["models"]["gfs"]["forecast_hours"].update(model_max=378),  # below max
        lambda r: r["models"]["gfs"]["forecast_hours"].pop("model_max"),
        lambda r: r["models"]["gfs"]["source"].update(adapter="ftp"),
        lambda r: r["models"]["gfs"]["source"].update(index_url="https://x/{nope}.idx"),
        lambda r: r["models"]["gfs"]["source"].update(max_connections=-1),
        lambda r: r["models"]["gfs"]["fields"].update(t2m={}),  # Herbie needs a search regex
        lambda r: r["models"]["ecmwf"]["fields"].update(t2m={"search": ":2t:"}),  # ECMWF picks by recipe
        lambda r: r["models"]["aigfs"]["source"].update(files={}),  # NOMADS needs its files
        lambda r: r["models"]["aigfs"]["fields"]["t2m"].pop("file"),  # ... and each field's file
        lambda r: r["models"]["aigfs"]["fields"]["t2m"].update(file="flx"),  # not one of them
        lambda r: r["models"]["gfs"]["fields"]["t2m"].update(file="sfc"),  # only NOMADS fields name a file
        lambda r: r["models"]["aigfs"]["source"].update(requests_per_minute=0),
        lambda r: r["models"]["aigfs"]["fields"].pop("precip"),  # precip_type false without precip
        lambda r: r["models"]["aigfs"]["source"]["files"].update(sfc="https://x/{nope}.grib2"),
        lambda r: r["models"]["gfs"]["products"]["gfs"].update(archive="all"),
        lambda r: r["models"]["gfs"]["source"].update(mean_index_urls={"384": "https://x/{fhr}.index"}),  # ECMWF only
        lambda r: r["models"]["ecmwf-ens"]["source"]["mean_index_urls"].pop("360"),  # steps past 240 uncovered
        lambda r: r["models"]["ecmwf-ens"]["source"]["mean_index_urls"].update({"360": "https://x/{nope}.index"}),
        lambda r: r["models"]["ecmwf-ens"]["source"].update(members=0),
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
    assert [f.id for f in product.fields_for_hour(0)] == [f.id for f in product.fields if f.id not in ("precip", "snow")]


def test_band_encodings_fit_their_physical_range(product):
    t = product.field("t2m").bands[0]
    assert t.offset == -80 and t.offset + t.max_stored * t.scale >= 170  # -80..175 F
    p = product.field("mslp").bands[0]
    assert p.max_stored * p.scale >= 1084  # well above any observed MSLP
    d = product.field("wdir250").bands[0]
    assert d.wrap == 360 and round(d.wrap / d.scale) == 256


def test_existing_fields_keep_their_encoding(product):
    # Changing an encoding (declaring nodata clips valid values one step lower)
    # needs a new field id: frames are cached as immutable.
    phase0 = {"wspd250", "wdir250", "t2m", "d2m", "wspd10", "wdir10", "gust", "mslp", "precip"}
    assert all(b.nodata is None for f in product.fields if f.id in phase0 for b in f.bands)


def test_upper_air_encodings(product):
    h = product.field("hgt500").bands[0]
    assert (h.dtype, h.scale, h.offset, h.units) == ("uint16", 1, 0, "m")
    v = product.field("vort500").bands[0]
    # 1e-5 s-1 steps from -50; the edges have no centred difference: nodata
    assert (v.dtype, v.scale, v.offset, v.nodata) == ("uint8", 1, -50, 255)
    assert v.offset + v.max_stored * v.scale == 204
    t = product.field("t850").bands[0]
    assert (t.dtype, t.scale, t.offset, t.units) == ("uint8", 0.5, -60, "C")
    assert t.offset + t.max_stored * t.scale == 67.5  # -60..67.5 C


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


def test_archive_keeps_every_frame_only_where_the_source_forgets():
    """NOMADS keeps days, DWD a day and MSC a month; AWS and Google Cloud keep years, so the
    analysis hour is enough there."""
    cfg = load_config()
    assert {pid: p.archive for pid, p in cfg.products.items()} == {
        "aifs": "f000", "aigefs": "full", "aigfs": "full", "ecmwf": "f000", "ecmwf-ens": "f000", "gefs": "f000",
        "gfs": "f000", "hgefs": "full", "gdps": "full", "icon": "full",
    }


def test_noaa_ai_and_ensemble_mean_products():
    cfg = load_config()
    aigfs, aigefs, hgefs, gefs = (cfg.product(p) for p in ("aigfs", "aigefs", "hgefs", "gefs"))
    assert [p.model.name for p in (aigfs, aigefs, hgefs, gefs)] == ["AIGFS", "AIGEFS mean", "HGEFS mean", "GEFS mean"]
    for p in (aigfs, aigefs, hgefs):
        assert p.model.adapter == "nomads" and [k for k, _ in p.model.files] == ["sfc", "pres"]
        assert p.model.requests_per_minute == 60  # half of NOMADS's 120 a minute per IP
        assert p.workers == 4 and not p.regrid
        assert "d2m" not in [f.id for f in p.fields] and "gust" not in [f.id for f in p.fields]
    assert aigfs.display_hours == aigefs.display_hours == list(range(0, 385, 6))
    assert hgefs.display_hours == hgefs.fetch_hours == list(range(0, 241, 6))
    # An hour is posted when both files' indexes are
    assert aigfs.model.index_urls_for(utc(2026, 10, 11, 6), 384) == [
        "https://nomads.ncep.noaa.gov/pub/data/nccf/com/aigfs/prod/aigfs.20261011/06/model/atmos/grib2/aigfs.t06z.sfc.f384.grib2.idx",
        "https://nomads.ncep.noaa.gov/pub/data/nccf/com/aigfs/prod/aigfs.20261011/06/model/atmos/grib2/aigfs.t06z.pres.f384.grib2.idx",
    ]
    assert hgefs.model.file_url_for("pres", utc(2026, 10, 11, 0), 6).endswith(
        "/hgefs/prod/hgefs.20261011/00/ensstat/products/atmos/grib2/hgefs.t00z.pres.avg.f006.grib2")
    assert aigfs.searches_by_file(0) == {
        "sfc": ":TMP:2 m above ground:|:(?:UGRD|VGRD):10 m above ground:|:PRMSL:mean sea level:",
        "pres": ":(?:UGRD|VGRD):250 mb:|:HGT:500 mb:|:(?:UGRD|VGRD):500 mb:|:TMP:850 mb:",
    }
    assert aigfs.searches_by_file(12, ["precip"]) == {"sfc": ":APCP:surface:6-12 hour acc"}

    assert (gefs.model.adapter, gefs.model.herbie_product, gefs.model.herbie_member) == ("herbie", "atmos.5", "avg")
    assert gefs.regrid and gefs.display_hours == list(range(0, 385, 6))
    assert "gust" not in [f.id for f in gefs.fields] and "d2m" in [f.id for f in gefs.fields]
    assert gefs.model.index_url_for(utc(2026, 10, 11, 18), 6) == (
        "https://noaa-gefs-pds.s3.amazonaws.com/gefs.20261011/18/atmos/pgrb2ap5/geavg.t18z.pgrb2a.0p50.f006.idx")


def test_ecmwf_ensemble_mean_product():
    p = load_config().product("ecmwf-ens")
    assert (p.model.id, p.model.name, p.model.adapter, p.model.members) == ("ecmwf-ens", "ECMWF ENS mean", "ecmwf_opendata", 50)
    assert p.display_hours == p.fetch_hours == list(range(0, 361, 6)) and p.retained_runs == 5
    # No vorticity (an ensemble mean's is nearly flat), no gust, no 250 mb direction (ECMWF's mean has speed only)
    assert [f.id for f in p.fields] == ["wspd250", "t2m", "d2m", "wspd10", "wdir10", "mslp", "precip", "snow", "hgt500", "t850"]
    # An hour is posted when its members' file and the mean file covering its step are
    base = "https://storage.googleapis.com/ecmwf-open-data/20261012/12z/ifs/0p25/enfo/2026101212"
    assert p.model.index_urls_for(utc(2026, 10, 12, 12), 240) == [
        f"{base}0000-240h-enfo-ef.index", f"{base}0000-240h-enfo-ep.index"]
    assert p.model.index_urls_for(utc(2026, 10, 12, 12), 246) == [
        f"{base}0000-246h-enfo-ef.index", f"{base}0000-360h-enfo-ep.index"]
    assert p.model.mean_index_url_for(utc(2026, 10, 12, 12), 0) == f"{base}0000-240h-enfo-ep.index"


def test_gdps_and_icon_products():
    cfg = load_config()
    gdps, icon = cfg.product("gdps"), cfg.product("icon")
    assert (gdps.model.name, gdps.model.adapter, icon.model.name, icon.model.adapter) == (
        "GEM", "msc_files", "ICON", "dwd_icon")
    for p in (gdps, icon):
        assert p.regrid and p.archive == "full" and p.retained_runs == 5 and p.cycle_interval_hours == 12
        assert [f.id for f in p.fields] == ["wspd250", "wdir250", "t2m", "d2m", "wspd10", "wdir10", "gust", "mslp",
                                            "precip", "snow", "hgt500", "vort500", "t850"]
    assert gdps.display_hours == gdps.fetch_hours == list(range(0, 241, 6))
    assert icon.display_hours == icon.fetch_hours == list(range(0, 181, 6))
    assert icon.field("gust").min_fhr == 6 and gdps.field("gust").min_fhr == 0  # ICON's is a maximum, none at F000

    init = utc(2026, 10, 13, 12)
    assert gdps.model.var_url_for("tp6", init, 6) == (
        "https://dd.weather.gc.ca/20261013/WXO-DD/model_gdps/15km/12/006/"
        "20261013T12Z_MSC_GDPS_Precip-Accum6h_Sfc_LatLon0.15_PT006H.grib2")
    assert icon.model.var_url_for("z500", init, 180) == (
        "https://opendata.dwd.de/weather/nwp/icon/grib/12/fi/"
        "icon_global_icosahedral_pressure-level_2026101312_180_500_FI.grib2.bz2")
    assert icon.model.grid_url_for("clon", init) == (
        "https://opendata.dwd.de/weather/nwp/icon/grib/12/clon/"
        "icon_global_icosahedral_time-invariant_2026101312_CLON.grib2.bz2")
    # No index: the first variable's file (2 m temperature, there every hour) stands in
    assert gdps.model.index_url_for(init, 0).endswith("_AirTemp_AGL-2m_LatLon0.15_PT000H.grib2")
    assert icon.model.index_url_for(init, 0).endswith("/t_2m/icon_global_icosahedral_single-level_2026101312_000_T_2M.grib2.bz2")


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda m: m["source"].pop("variables"), "file_url and variables"),
        (lambda m: m["source"].pop("grid_files"), "grid_files"),
        (lambda m: m["source"]["grid_files"].pop("clon"), "grid_files"),
        (lambda m: m["source"]["variables"].update(t2m=m["source"]["variables"]["d2m"]), "same file"),
        (lambda m: m["source"]["variables"].update(t2m="t_2m/{nope}"), "template"),
        (lambda m: m["fields"]["t2m"].update(search=":TMP:"), "search"),
    ],
)
def test_invalid_per_file_sources_rejected(mutate, message):
    r = copy.deepcopy(raw())
    mutate(r["models"]["icon"])
    with pytest.raises(ConfigError, match=message):
        parse_config(r)


def test_per_file_keys_only_on_per_file_sources():
    r = copy.deepcopy(raw())
    r["models"]["gfs"]["source"]["file_url"] = "https://example.com/{file}"
    with pytest.raises(ConfigError, match="per-file"):
        parse_config(r)


def test_snowfall_encoding_and_where_it_comes_from(product):
    sf = product.field("snow").bands[0]
    # 0.001 in (Phase 3.8 decision B): at 0.01, light snow under 0.005 in a step rounds to 0
    assert (sf.dtype, sf.scale, sf.offset, sf.units) == ("uint16", 0.001, 0, "in")
    assert product.field("snow").min_fhr == 6
    assert product.field("snow").search_for(12, product.fhr_step) == ":APCP:surface:6-12 hour acc|:CSNOW:surface:6-12 hour ave"
    cfg = load_config()
    has = {pid for pid, p in cfg.products.items() if "snow" in [f.id for f in p.fields]}
    # no snow or type output: AIGFS, AIGEFS, HGEFS
    assert has == {"gfs", "ecmwf", "aifs", "gefs", "ecmwf-ens", "gdps", "icon"}


def test_gefs_members_are_its_30_perturbed_files():
    m = load_config().product("gefs").model
    assert m.members == 30 and m.member_names == [f"p{n:02d}" for n in range(1, 31)]  # geavg leaves out the control
    assert m.member_url_for("p07", utc(2026, 10, 12, 6), 18) == (
        "https://noaa-gefs-pds.s3.amazonaws.com/gefs.20261012/06/atmos/pgrb2ap5/gep07.t06z.pgrb2a.0p50.f018")


def test_member_url_needs_a_herbie_source_with_members():
    r = copy.deepcopy(raw())
    r["models"]["aigfs"]["source"]["member_url"] = "https://x/{member}"
    with pytest.raises(ConfigError, match="member_url"):
        parse_config(r)
