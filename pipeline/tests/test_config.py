import copy
import json

import pytest

from wxtrend.config import DEFAULT_CONFIG_PATH, ConfigError, parse_config


def raw():
    return json.loads(DEFAULT_CONFIG_PATH.read_text())


def test_defaults_match_spec(cfg):
    assert cfg.model == "gfs" and cfg.product == "pgrb2.0p25"
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
