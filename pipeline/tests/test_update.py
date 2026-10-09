import json
from datetime import datetime, timezone

import pytest

from wxtrend.alignment import utc
from wxtrend.cycles import cycle_id, idx_url
from wxtrend.store import FrameStore, gzip_frame
from wxtrend.update import NoCompleteCycle, missing_jobs, run_update, target_cycles

from .helpers import physical

NOW = datetime(2026, 10, 9, 5, 10, tzinfo=timezone.utc)


def always(url):
    return True


class FakeFetch:
    """Stands in for fetch_hour: records calls, returns constant fields."""

    def __init__(self, fail=()):
        self.calls = []
        self.fail = set(fail)

    def __call__(self, cfg, init, fhr, field_ids, work_dir):
        self.calls.append((cycle_id(init), fhr, tuple(field_ids)))
        if (cycle_id(init), fhr) in self.fail:
            raise RuntimeError("boom")
        return {fid: physical(cfg, fid, fill=fhr % 200) for fid in field_ids}

    def hours(self):
        return [(r, f) for r, f, _ in self.calls]


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


def test_jobs_group_fields_by_hour_and_skip_precip_at_f000(tmp_path, cfg):
    jobs = missing_jobs(cfg, FrameStore(tmp_path), [utc(2026, 10, 9, 0)], [0, 6])
    assert [j.fhr for j in jobs] == [0, 6]
    assert "precip" not in jobs[0].fields and "precip" in jobs[1].fields
    assert len(jobs[1].fields) == len(cfg.fields)


def test_backfill_then_noop_then_incremental(tmp_path, cfg):
    store = FrameStore(tmp_path)
    fetch = FakeFetch()
    hours = [0, 6, 12]

    r1 = run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=hours, sleep=no_sleep)
    assert r1.latest == "2026100900"
    assert len(fetch.calls) == 9 * 3  # one fetch per (run, hour), all fields together
    assert len(r1.fetched) == 9 * (3 * len(cfg.fields) - 1)  # no precip at F000
    assert (tmp_path / "manifest.json").exists() and r1.changed

    fetch.calls.clear()
    r2 = run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=hours, sleep=no_sleep)
    assert not r2.changed and fetch.calls == []

    later = datetime(2026, 10, 9, 11, 10, tzinfo=timezone.utc)
    r3 = run_update(cfg, store, now=later, exists=always, fetch=fetch, hours=hours, sleep=no_sleep)
    assert r3.latest == "2026100906"
    assert {r for r, _ in fetch.hours()} == {"2026100906"}
    assert r3.pruned == ["2026100700"]
    assert store.run_ids()[0] == "2026100906" and len(store.run_ids()) == 9


def test_frames_written_decode_to_fetched_values(tmp_path, cfg):
    store = FrameStore(tmp_path)
    run_update(cfg, store, now=NOW, exists=always, fetch=FakeFetch(), hours=[12], sleep=no_sleep, latest=utc(2026, 10, 9, 0))
    shape = (cfg.domain.ny, cfg.domain.nx)
    t = store.read_frame("2026100900", cfg.field("t2m"), 12, shape)["temp"]
    assert (t == 12 + 80).all()  # stored = (12 F - (-80)) / 1


def test_only_missing_fields_are_fetched(tmp_path, cfg):
    store = FrameStore(tmp_path)
    fetch = FakeFetch()
    run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=[6], sleep=no_sleep)
    (tmp_path / "runs" / "2026100900" / "mslp" / "f006.bin.gz").unlink()
    fetch.calls.clear()
    run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=[6], sleep=no_sleep)
    assert fetch.calls == [("2026100900", 6, ("mslp",))]


def test_failed_hours_are_reported_and_retried_next_time(tmp_path, cfg):
    store = FrameStore(tmp_path)
    fetch = FakeFetch(fail={("2026100900", 6)})
    r1 = run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=[0, 6], sleep=no_sleep)
    assert r1.failed and r1.failed[0][:2] == ("2026100900", 6)
    assert fetch.hours().count(("2026100900", 6)) == cfg.retries
    assert store.hours("2026100900", "t2m") == [0]

    fetch.fail.clear()
    fetch.calls.clear()
    r2 = run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=[0, 6], sleep=no_sleep)
    assert fetch.hours() == [("2026100900", 6)]
    assert r2.changed and store.hours("2026100900", "t2m") == [0, 6]


def test_no_complete_cycle_raises(tmp_path, cfg):
    with pytest.raises(NoCompleteCycle):
        run_update(cfg, FrameStore(tmp_path), now=NOW, exists=lambda u: False, fetch=FakeFetch())


def test_update_waits_for_full_fetch_range(tmp_path, cfg):
    missing = {idx_url(cfg, utc(2026, 10, 9, 0), f) for f in range(246, 289, 6)}
    fetch = FakeFetch()
    r = run_update(cfg, FrameStore(tmp_path), now=NOW, exists=lambda url: url not in missing,
                   fetch=fetch, quick=True, sleep=no_sleep)
    assert r.latest == "2026100818"
    assert {rid for rid, _ in fetch.hours()} == set(r.targets)
    assert all(len([c for c in fetch.hours() if c[0] == rid]) == 49 for rid in r.targets)


def test_quick_fetches_lag_runs_but_never_prunes_the_window(tmp_path, cfg):
    store = FrameStore(tmp_path)
    fetch = FakeFetch()
    run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=[0], sleep=no_sleep)
    assert len(store.run_ids()) == 9

    fetch.calls.clear()
    later = datetime(2026, 10, 9, 11, 10, tzinfo=timezone.utc)
    r = run_update(cfg, store, now=later, exists=always, fetch=fetch, hours=[0], quick=True, sleep=no_sleep)
    assert fetch.hours() == [("2026100906", 0)]
    assert r.pruned == ["2026100700"]
    assert len(store.run_ids()) == 9


def test_stale_manifest_is_rewritten_even_when_frames_are_complete(tmp_path, cfg):
    store = FrameStore(tmp_path)
    fetch = FakeFetch()
    run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=[0], sleep=no_sleep)
    from .helpers import write
    write(store, cfg, "2026100900", "t2m", 6)

    fetch.calls.clear()
    r = run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=[0], sleep=no_sleep)
    assert fetch.calls == [] and r.changed
    m = json.loads((tmp_path / "manifest.json").read_text())
    assert m["runs"][0]["hours"]["t2m"] == [0, 6]
    assert not run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=[0], sleep=no_sleep).changed


def test_legacy_layout_is_cleared_and_refetched(tmp_path, cfg):
    store = FrameStore(tmp_path)
    legacy = tmp_path / "runs" / "2026100900" / "f000.bin.gz"
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(gzip_frame(b"v1"))
    (tmp_path / "manifest.json").write_text(json.dumps({"schema_version": 1}))
    fetch = FakeFetch()
    r = run_update(cfg, store, now=NOW, exists=always, fetch=fetch, hours=[0], sleep=no_sleep)
    assert r.legacy_removed == 1 and not legacy.exists()
    assert ("2026100900", 0) in fetch.hours()
    assert json.loads((tmp_path / "manifest.json").read_text())["schema_version"] == 2
