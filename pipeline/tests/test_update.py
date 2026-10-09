import json
from datetime import datetime, timezone

import numpy as np
import pytest

from wxtrend.alignment import utc
from wxtrend.cycles import cycle_id, idx_url
from wxtrend.store import FrameStore
from wxtrend.update import NoCompleteCycle, run_update, target_cycles

NOW = datetime(2026, 10, 9, 5, 10, tzinfo=timezone.utc)


def always(url):
    return True


class FakeFetch:
    def __init__(self, cfg, fail=()):
        self.cfg = cfg
        self.calls = []
        self.fail = set(fail)

    def __call__(self, cfg, init, fhr, work_dir):
        self.calls.append((cycle_id(init), fhr))
        if (cycle_id(init), fhr) in self.fail:
            raise RuntimeError("boom")
        # Encode the forecast hour so frames are distinguishable
        return np.full((cfg.domain.ny, cfg.domain.nx), fhr % 256, np.uint8)


def no_sleep(_):
    pass


def test_target_cycles(cfg):
    full = [cycle_id(t) for t in target_cycles(cfg, utc(2026, 10, 9, 0))]
    assert full == [
        "2026100900", "2026100818", "2026100812", "2026100806", "2026100800",
        "2026100718", "2026100712", "2026100706", "2026100700",
    ]
    quick = [cycle_id(t) for t in target_cycles(cfg, utc(2026, 10, 9, 0), quick=True)]
    assert quick == ["2026100900", "2026100818", "2026100812", "2026100800", "2026100700"]


def test_backfill_then_noop_then_incremental(tmp_path, cfg):
    store = FrameStore(tmp_path)
    fetch = FakeFetch(cfg)
    hours = [0, 6, 12]

    r1 = run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=hours, sleep=no_sleep)
    assert r1.latest == "2026100900"
    assert len(r1.fetched) == 9 * 3 and r1.changed
    assert (tmp_path / "manifest.json").exists()

    # Same cycle again: nothing to do
    fetch.calls.clear()
    r2 = run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=hours, sleep=no_sleep)
    assert not r2.changed and fetch.calls == []

    # Next cycle: fetch only the new run, prune the oldest
    later = datetime(2026, 10, 9, 11, 10, tzinfo=timezone.utc)
    r3 = run_update(cfg, store, now=later, exists=always, fetch=fetch, hours=hours, sleep=no_sleep)
    assert r3.latest == "2026100906"
    assert {rid for rid, _ in fetch.calls} == {"2026100906"}
    assert r3.pruned == ["2026100700"]
    assert store.run_ids()[0] == "2026100906" and len(store.run_ids()) == 9


def test_failed_frames_are_reported_and_retried_next_time(tmp_path, cfg):
    store = FrameStore(tmp_path)
    fetch = FakeFetch(cfg, fail={("2026100900", 6)})
    r1 = run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=[0, 6], sleep=no_sleep)
    assert r1.failed and r1.failed[0][:2] == ("2026100900", 6)
    assert fetch.calls.count(("2026100900", 6)) == cfg.retries
    assert store.hours("2026100900") == [0]

    fetch.fail.clear()
    fetch.calls.clear()
    r2 = run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=[0, 6], sleep=no_sleep)
    assert fetch.calls == [("2026100900", 6)]
    assert r2.changed and store.hours("2026100900") == [0, 6]


def test_no_complete_cycle_raises(tmp_path, cfg):
    with pytest.raises(NoCompleteCycle):
        run_update(cfg, FrameStore(tmp_path), now=NOW, exists=lambda u: False, fetch=FakeFetch(cfg))


def test_update_waits_for_full_fetch_range(tmp_path, cfg):
    # 00Z has posted through F240 but not F246-F288, so 18Z is still the latest
    # complete cycle even though every display hour of 00Z exists.
    missing = {idx_url(cfg, utc(2026, 10, 9, 0), f) for f in range(246, 289, 6)}
    exists = lambda url: url not in missing  # noqa: E731
    fetch = FakeFetch(cfg)
    r = run_update(cfg, FrameStore(tmp_path), now=NOW, exists=exists, fetch=fetch,
                   hours=None, quick=True, sleep=no_sleep)
    assert r.latest == "2026100818"
    assert {rid for rid, _ in fetch.calls} == set(r.targets)
    assert all(len([c for c in fetch.calls if c[0] == rid]) == 49 for rid in r.targets)


def test_quick_fetches_lag_runs_but_never_prunes_the_window(tmp_path, cfg):
    store = FrameStore(tmp_path)
    fetch = FakeFetch(cfg)
    run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=[0], sleep=no_sleep)
    assert len(store.run_ids()) == 9

    fetch.calls.clear()
    later = datetime(2026, 10, 9, 11, 10, tzinfo=timezone.utc)  # 06Z is now latest
    r = run_update(cfg, store, now=later, exists=always, fetch=fetch, hours=[0], quick=True, sleep=no_sleep)
    # Only the new run is missing among {06Z, -6, -12, -24, -48}
    assert fetch.calls == [("2026100906", 0)]
    # The run that fell out of the full window is pruned; the rest are kept
    assert r.pruned == ["2026100700"]
    assert len(store.run_ids()) == 9


def test_stale_manifest_is_rewritten_even_when_frames_are_complete(tmp_path, cfg):
    # Simulates a crash after frames were written but before the manifest was.
    store = FrameStore(tmp_path)
    fetch = FakeFetch(cfg)
    run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=[0], sleep=no_sleep)
    store.write_frame("2026100900", 6, np.zeros((cfg.domain.ny, cfg.domain.nx), np.uint8))

    fetch.calls.clear()
    r = run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=[0], sleep=no_sleep)
    assert fetch.calls == [] and r.changed
    m = json.loads((tmp_path / "manifest.json").read_text())
    assert m["runs"][0]["hours"] == [0, 6]

    r2 = run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=[0], sleep=no_sleep)
    assert not r2.changed
