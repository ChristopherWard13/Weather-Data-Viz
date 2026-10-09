from datetime import datetime, timezone

import pytest

from wxtrend.alignment import comparison_frame, pair, utc, valid_time

from .conftest import load_vectors

CASES = load_vectors("alignment.json")


def parse(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


@pytest.mark.parametrize("case", CASES, ids=lambda c: f"{c['init']}-f{c['fhr']}-L{c['lag']}")
def test_vectors(case):
    p = pair(parse(case["init"]), case["fhr"], case["lag"])
    assert p.valid == parse(case["valid"])
    assert p.older_init == parse(case["older_init"])
    assert p.older_fhr == case["older_fhr"]
    assert p.current_fhr == case["fhr"]


@pytest.mark.parametrize("lag", [6, 12, 24, 48])
@pytest.mark.parametrize("fhr", range(0, 241, 6))
def test_every_lag_and_hour_is_valid_at_the_same_time(lag, fhr):
    init = utc(2026, 10, 8, 18)
    older_init, older_fhr = comparison_frame(init, fhr, lag)
    assert (init - older_init).total_seconds() == lag * 3600
    assert older_fhr == fhr + lag
    assert valid_time(older_init, older_fhr) == valid_time(init, fhr)


def test_every_lag_is_covered_by_vectors(cfg):
    assert {c["lag"] for c in CASES} == set(cfg.lags)


def test_naive_datetimes_rejected():
    with pytest.raises(ValueError):
        valid_time(datetime(2026, 10, 8, 18), 0)


@pytest.mark.parametrize("lag", [0, -6])
def test_non_positive_lag_rejected(lag):
    with pytest.raises(ValueError):
        comparison_frame(utc(2026, 10, 8), 0, lag)


def test_non_utc_aware_rejected():
    from datetime import timedelta

    est = timezone(timedelta(hours=-5))
    with pytest.raises(ValueError):
        valid_time(datetime(2026, 10, 8, 18, tzinfo=est), 0)
