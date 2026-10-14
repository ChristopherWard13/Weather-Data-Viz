from datetime import datetime, timezone

import pytest

from wxtrend.config import load_config
from wxtrend.cycles import (
    cycle_id,
    cycle_is_complete,
    find_latest_complete_cycle,
    listing_exists_fn,
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


def test_idx_url(product):
    assert idx_url(product, utc(2026, 10, 8, 6), 120) == (
        "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261008/06/atmos/gfs.t06z.pgrb2.0p25.f120.idx"
    )


class FakeBucket:
    """Pretend AWS: each cycle has published hours up to some limit."""

    def __init__(self, product, published: dict[str, int]):
        self.product = product
        self.published = published
        self.requests = []

    def __call__(self, url: str) -> bool:
        self.requests.append(url)
        for run_id, max_fhr in self.published.items():
            init = parse_cycle_id(run_id)
            for f in range(0, max_fhr + 1, 6):
                if url == idx_url(self.product, init, f):
                    return True
        return False


def test_latest_complete_skips_cycle_still_posting(product):
    # 00Z has posted through F378 but not F384 yet, so it is not complete
    bucket = FakeBucket(product, {"2026100900": 378, "2026100818": 384})
    now = datetime(2026, 10, 9, 4, 45, tzinfo=timezone.utc)
    assert find_latest_complete_cycle(product, now, bucket) == utc(2026, 10, 8, 18)


def test_latest_complete_when_newest_is_done(product):
    bucket = FakeBucket(product, {"2026100900": 384, "2026100818": 384})
    now = datetime(2026, 10, 9, 5, 35, tzinfo=timezone.utc)
    assert find_latest_complete_cycle(product, now, bucket) == utc(2026, 10, 9, 0)


def test_hole_in_the_middle_is_incomplete(product):
    published = {"2026100818": 384}
    bucket = FakeBucket(product, published)
    hole = idx_url(product, utc(2026, 10, 8, 18), 150)
    exists = lambda url: url != hole and bucket(url)  # noqa: E731
    now = datetime(2026, 10, 9, 0, 30, tzinfo=timezone.utc)
    assert find_latest_complete_cycle(product, now, exists) is None


def test_incomplete_cycle_costs_one_request(product):
    bucket = FakeBucket(product, {"2026100900": 100, "2026100818": 384})
    now = datetime(2026, 10, 9, 4, 30, tzinfo=timezone.utc)
    find_latest_complete_cycle(product, now, bucket)
    first_00z = [u for u in bucket.requests if "gfs.20261009/00" in u]
    assert len(first_00z) == 1 and first_00z[0].endswith("f384.idx")


def test_nothing_published(product):
    now = datetime(2026, 10, 9, 5, 0, tzinfo=timezone.utc)
    assert find_latest_complete_cycle(product, now, lambda url: False) is None


AIGFS = load_config().product("aigfs")


class FakeListing:
    """NOMADS directory listings: a GET per directory, answered from a set of posted files."""

    def __init__(self, posted: set[str]):
        self.posted = posted
        self.requests = []

    def get(self, url, timeout=None):
        self.requests.append(url)
        names = sorted(p.rsplit("/", 1)[1] for p in self.posted if p.rsplit("/", 1)[0] + "/" == url)

        class R:
            status_code = 200 if names else 404
            text = "".join(f'<IMG SRC="/icons/generic.gif"> <A HREF="{n}">{n}</A>  11-Oct-2026 03:41  3k\n'
                           for n in names)
        return R()


def _posted(product, run_id, last_fhr, skip=()):
    init = parse_cycle_id(run_id)
    return {u for f in range(0, last_fhr + 1, 6) for u in product.model.index_urls_for(init, f) if u not in skip}


def _listing_exists(monkeypatch, posted):
    import wxtrend.cycles as cycles

    fake = FakeListing(posted)
    monkeypatch.setattr(cycles, "paced_session", lambda rpm: fake)
    return listing_exists_fn(60), fake


def test_nomads_completeness_reads_one_listing_per_cycle(monkeypatch):
    exists, fake = _listing_exists(monkeypatch, _posted(AIGFS, "2026101100", 384) | _posted(AIGFS, "2026101106", 120))
    now = datetime(2026, 10, 11, 11, 0, tzinfo=timezone.utc)
    assert find_latest_complete_cycle(AIGFS, now, exists) == utc(2026, 10, 11, 0)
    # 06Z (incomplete), then 00Z: one listing each, not a HEAD per hour and file
    assert [u.split("/prod/")[1] for u in fake.requests] == [
        "aigfs.20261011/06/model/atmos/grib2/", "aigfs.20261011/00/model/atmos/grib2/"]


def test_nomads_hour_needs_every_file(monkeypatch):
    pres = AIGFS.model.index_urls_for(utc(2026, 10, 11, 0), 150)[1]
    exists, _ = _listing_exists(monkeypatch, _posted(AIGFS, "2026101100", 384, skip={pres}))
    now = datetime(2026, 10, 11, 5, 0, tzinfo=timezone.utc)
    assert find_latest_complete_cycle(AIGFS, now, exists) is None


def test_ecmwf_ens_hours_need_their_mean_file_checked_once():
    product = load_config().product("ecmwf-ens")
    init = utc(2026, 10, 12, 0)
    asked = []

    def exists(url):
        asked.append(url)
        return "-360h-enfo-ep." not in url  # members all posted; the second mean file isn't yet

    assert not cycle_is_complete(product, init, product.fetch_hours, exists)
    assert asked[-1].endswith("-360h-enfo-ep.index")  # the last hour's files first: one check settles it
    asked.clear()
    assert cycle_is_complete(product, init, product.fetch_hours, lambda u: asked.append(u) or True)
    assert len(asked) == len(product.fetch_hours) + 2 and len(set(asked)) == len(asked)
