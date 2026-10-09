from datetime import datetime, timezone

import pytest

from wxtrend.cycles import (
    cycle_id,
    find_latest_complete_cycle,
    floor_cycle,
    idx_url,
    parse_cycle_id,
    previous_cycles,
)
from wxtrend.alignment import utc


def test_cycle_id_roundtrip():
    t = utc(2026, 10, 8, 18)
    assert cycle_id(t) == "2026100818"
    assert parse_cycle_id("2026100818") == t
    with pytest.raises(ValueError):
        parse_cycle_id("20261008")


@pytest.mark.parametrize(
    "now,expected",
    [
        (datetime(2026, 10, 9, 5, 10, tzinfo=timezone.utc), utc(2026, 10, 9, 0)),
        (datetime(2026, 10, 9, 0, 0, tzinfo=timezone.utc), utc(2026, 10, 9, 0)),
        (datetime(2026, 10, 9, 23, 59, tzinfo=timezone.utc), utc(2026, 10, 9, 18)),
    ],
)
def test_floor_cycle(now, expected):
    assert floor_cycle(now, 6) == expected


def test_previous_cycles_newest_first_across_midnight():
    got = [cycle_id(t) for t in previous_cycles(utc(2026, 10, 9, 6), 4, 6)]
    assert got == ["2026100906", "2026100900", "2026100818", "2026100812"]


def test_idx_url(cfg):
    assert idx_url(cfg, utc(2026, 10, 8, 6), 120) == (
        "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261008/06/atmos/gfs.t06z.pgrb2.0p25.f120.idx"
    )


class FakeBucket:
    """Pretend AWS: each cycle has published hours up to some limit."""

    def __init__(self, cfg, published: dict[str, int]):
        self.cfg = cfg
        self.published = published
        self.requests = []

    def __call__(self, url: str) -> bool:
        self.requests.append(url)
        for run_id, max_fhr in self.published.items():
            init = parse_cycle_id(run_id)
            for f in range(0, max_fhr + 1, 6):
                if url == idx_url(self.cfg, init, f):
                    return True
        return False


def test_latest_complete_skips_cycle_still_posting(cfg):
    # 00Z has posted through F240 but not F288 yet, so it is not complete
    bucket = FakeBucket(cfg, {"2026100900": 240, "2026100818": 384})
    now = datetime(2026, 10, 9, 4, 45, tzinfo=timezone.utc)
    assert find_latest_complete_cycle(cfg, now, bucket) == utc(2026, 10, 8, 18)


def test_latest_complete_when_newest_is_done(cfg):
    bucket = FakeBucket(cfg, {"2026100900": 288, "2026100818": 384})
    now = datetime(2026, 10, 9, 5, 5, tzinfo=timezone.utc)
    assert find_latest_complete_cycle(cfg, now, bucket) == utc(2026, 10, 9, 0)


def test_hole_in_the_middle_is_incomplete(cfg):
    published = {"2026100818": 384}
    bucket = FakeBucket(cfg, published)
    hole = idx_url(cfg, utc(2026, 10, 8, 18), 150)
    exists = lambda url: url != hole and bucket(url)  # noqa: E731
    now = datetime(2026, 10, 9, 0, 30, tzinfo=timezone.utc)
    assert find_latest_complete_cycle(cfg, now, exists) is None


def test_incomplete_cycle_costs_one_request(cfg):
    bucket = FakeBucket(cfg, {"2026100900": 100, "2026100818": 384})
    now = datetime(2026, 10, 9, 4, 30, tzinfo=timezone.utc)
    find_latest_complete_cycle(cfg, now, bucket)
    first_00z = [u for u in bucket.requests if "gfs.20261009/00" in u]
    assert len(first_00z) == 1 and first_00z[0].endswith("f288.idx")


def test_nothing_published(cfg):
    now = datetime(2026, 10, 9, 5, 0, tzinfo=timezone.utc)
    assert find_latest_complete_cycle(cfg, now, lambda url: False) is None
