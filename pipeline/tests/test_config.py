import copy
import json

import pytest

from wxtrend.config import DEFAULT_CONFIG_PATH, ConfigError, parse_config


def raw():
    return json.loads(DEFAULT_CONFIG_PATH.read_text())


def test_defaults_match_spec(cfg):
    assert cfg.model == "gfs" and cfg.product == "pgrb2.0p25"
    assert [f.id for f in cfg.fields] == [
        "wspd250", "wdir250", "t2m", "d2m", "wspd10", "wdir10", "gust", "mslp", "precip"
    ]
    assert cfg.lags == (6, 12, 24, 48)
    assert cfg.default_lag == 48
    assert cfg.display_hours == list(range(0, 241, 6))


def test_retention_covers_longest_lag(cfg):
    # 00Z current plus 18,12,06,00Z of the previous two days
    assert cfg.retained_runs == 9


def test_fetch_hours_extend_by_longest_lag(cfg):
    # f=240 at lag 48 needs the older run's F288
    assert cfg.fetch_hours[0] == 0
    assert cfg.fetch_hours[-1] == 288
    assert len(cfg.fetch_hours) == 49


def test_domain_dimensions(cfg):
    assert (cfg.domain.ny, cfg.domain.nx) == (221, 481)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r.update(default_lag_hours=36),
        lambda r: r.update(lags_hours=[9]),
        lambda r: r["domain"].update(lat_max=70.1),
        lambda r: r["domain"].update(lat_min=80),
        lambda r: r.pop("model"),
    ],
)
def test_invalid_configs_rejected(mutate):
    r = copy.deepcopy(raw())
    mutate(r)
    with pytest.raises(ConfigError):
        parse_config(r)


def test_precip_search_uses_the_six_hour_bucket(cfg):
    precip = cfg.field("precip")
    assert precip.min_fhr == 6
    s = precip.search_for(120, cfg.fhr_step)
    assert ":APCP:surface:114-120 hour acc" in s
    assert ":(?:CRAIN|CSNOW|CICEP|CFRZR):surface:114-120 hour ave" in s


def test_search_for_hour_skips_fields_not_yet_available(cfg):
    assert "APCP" not in cfg.search_for(0)
    assert "APCP" in cfg.search_for(6)
    assert cfg.search_for(6, ["t2m"]) == ":TMP:2 m above ground:"
    assert [f.id for f in cfg.fields_for_hour(0)] == [f.id for f in cfg.fields if f.id != "precip"]


def test_band_encodings_fit_their_physical_range(cfg):
    t = cfg.field("t2m").bands[0]
    assert t.offset == -80 and t.offset + t.max_stored * t.scale >= 170  # -80..175 F
    p = cfg.field("mslp").bands[0]
    assert p.max_stored * p.scale >= 1084  # well above any observed MSLP
    d = cfg.field("wdir250").bands[0]
    assert d.wrap == 360 and round(d.wrap / d.scale) == 256


def test_frame_bytes(cfg):
    assert cfg.field("wspd250").frame_bytes(481, 221) == 106_301
    assert cfg.field("precip").frame_bytes(481, 221) == 3 * 106_301  # uint16 + uint8


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r["fields"]["t2m"]["bands"][0].update(dtype="float32"),
        lambda r: r["fields"]["t2m"]["bands"][0].update(scale=0),
        lambda r: r["fields"]["wdir250"]["bands"][0].update(offset=5),
        lambda r: r["fields"]["t2m"].update(search=":TMP:{nope}:"),
        lambda r: r["fields"]["t2m"].update(bands=[]),
    ],
)
def test_invalid_fields_rejected(mutate):
    r = copy.deepcopy(raw())
    mutate(r)
    with pytest.raises(ConfigError):
        parse_config(r)
