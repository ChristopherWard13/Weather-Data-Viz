"""The dry run's check of an ensemble's member-averaged mean (cli.check_member_means)."""

import logging

from wxtrend.alignment import utc
from wxtrend.cli import check_member_means
from wxtrend.config import load_config
from wxtrend.fetch import NotPublished

CFG = load_config()
ENS = CFG.product("ecmwf-ens")
INIT = utc(2026, 10, 12, 0)


# Module level, so the check's spawned worker can import them: (mean, max) |difference| in Pa
def close(product, init, fhr, var, work_dir):
    return 15.0, 103.0  # as measured: the control member makes up the rest


def far(product, init, fhr, var, work_dir):
    return 31.0 if fhr == 12 else 1.0, 120.0


def gone(product, init, fhr, var, work_dir):
    raise NotPublished(f"step {fhr}: no index")


def test_passes_within_the_average_limit_whatever_the_largest_point():
    assert check_member_means(ENS, INIT, [6, 12], ["t2m"], close)


def test_fails_an_hour_past_the_limit(caplog):
    with caplog.at_level(logging.ERROR, logger="wxtrend"):
        assert not check_member_means(ENS, INIT, [6, 12], ["t2m"], far)
    assert "f012 msl" in caplog.text and "f006" not in caplog.text


def test_an_hour_that_cant_be_checked_fails_without_a_traceback(caplog):
    with caplog.at_level(logging.ERROR, logger="wxtrend"):
        assert not check_member_means(ENS, INIT, [6], ["precip"], gone)
    assert "couldn't be checked: NotPublished: step 6: no index" in caplog.text


def test_skipped_unless_a_field_is_averaged_from_members():
    # 850 mb temperature is ECMWF's own mean, and other models aren't checked at all
    assert check_member_means(ENS, INIT, [6], ["t850", "hgt500"], gone)
    assert check_member_means(CFG.product("ecmwf"), INIT, [6], ["t2m"], gone)
