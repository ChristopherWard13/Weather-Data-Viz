import json
from datetime import datetime, timezone

import pytest

from wxtrend.alignment import utc
from wxtrend.cycles import cycle_id, idx_url, parse_cycle_id
from wxtrend.store import FrameStore, gzip_frame
from wxtrend.update import NoCompleteCycle, missing_jobs, run_update, target_cycles

from .helpers import FakeFetch, always, listing, no_sleep, write_legacy

NOW = datetime(2026, 10, 9, 5, 10, tzinfo=timezone.utc)


def test_target_cycles(product):
    full = [cycle_id(t) for t in target_cycles(product, utc(2026, 10, 9, 0))]
    assert full == [
        "2026100900", "2026100818", "2026100812", "2026100806", "2026100800",
        "2026100718", "2026100712", "2026100706", "2026100700",
    ]
    quick = [cycle_id(t) for t in target_cycles(product, utc(2026, 10, 9, 0), quick=True)]
    assert quick == ["2026100900", "2026100818", "2026100812", "2026100800", "2026100700"]


def test_jobs_group_fields_by_hour_and_skip_precip_at_f000(product):
    jobs = missing_jobs(product, {}, [utc(2026, 10, 9, 0)], [0, 6])
    assert [j.fhr for j in jobs] == [0, 6]
    assert "precip" not in jobs[0].fields and "precip" in jobs[1].fields
    assert "snow" not in jobs[0].fields and "snow" in jobs[1].fields
    assert len(jobs[1].fields) == len(product.fields)


def test_backfill_then_noop_then_incremental(tmp_path, product):
    store = FrameStore(tmp_path)
    fetch = FakeFetch()
    hours = [0, 6, 12]

    r1 = run_update(product, store, now=NOW, exists=always, fetch=fetch, hours=hours, sleep=no_sleep)
    assert r1.latest == "2026100900"
    assert len(fetch.calls) == 9 * 3  # one fetch per (run, hour), all fields together
    assert len(r1.fetched) == 9 * (3 * len(product.fields) - 2)  # no precip or snow at F000
    assert (tmp_path / "manifest.json").exists() and r1.changed

    fetch.calls.clear()
    r2 = run_update(product, store, now=NOW, exists=always, fetch=fetch, hours=hours, sleep=no_sleep)
    assert not r2.changed and fetch.calls == []

    later = datetime(2026, 10, 9, 11, 10, tzinfo=timezone.utc)
    r3 = run_update(product, store, now=later, exists=always, fetch=fetch, hours=hours, sleep=no_sleep)
    assert r3.latest == "2026100906"
    assert {r for r, _ in fetch.hours()} == {"2026100906"}
    assert r3.pruned == ["2026100700"]
    assert store.run_ids()[0] == "2026100906" and len(store.run_ids()) == 9


def test_frames_written_decode_to_fetched_values(tmp_path, product):
    store = FrameStore(tmp_path)
    run_update(product, store, now=NOW, exists=always, fetch=FakeFetch(), hours=[12], sleep=no_sleep, latest=utc(2026, 10, 9, 0))
    shape = (product.grid.ny, product.grid.nx)
    t = store.read_frame("2026100900", product.field("t2m"), 12, shape)["temp"]
    assert (t == 12 + 80).all()  # stored = (12 F - (-80)) / 1


def test_only_missing_fields_are_fetched(tmp_path, product):
    store = FrameStore(tmp_path)
    fetch = FakeFetch()
    run_update(product, store, now=NOW, exists=always, fetch=fetch, hours=[6], sleep=no_sleep)
    files = store.run_files()["2026100900"]
    store.file_path("2026100900", files["mslp"]).unlink()  # the recipe for fetching a field again
    fetch.calls.clear()
    r = run_update(product, store, now=NOW, exists=always, fetch=fetch, hours=[6], sleep=no_sleep)
    assert fetch.calls == [("2026100900", 6, ("mslp",))]
    assert r.packed == [("2026100900", "mslp")]  # only its file is written again
    assert store.run_files()["2026100900"] == files | {"mslp": store.run_files()["2026100900"]["mslp"]}


def test_failed_hours_are_reported_and_retried_next_time(tmp_path, product):
    store = FrameStore(tmp_path)
    fetch = FakeFetch(fail={("2026100900", 6)})
    r1 = run_update(product, store, now=NOW, exists=always, fetch=fetch, hours=[0, 6], sleep=no_sleep)
    assert r1.failed and r1.failed[0][:2] == ("2026100900", 6)
    assert fetch.hours().count(("2026100900", 6)) == product.retries
    assert listing(store, product)["2026100900"]["t2m"] == [0]
    m = json.loads((tmp_path / "manifest.json").read_text())
    assert m["runs"][0]["complete"] is False

    fetch.fail.clear()
    fetch.calls.clear()
    r2 = run_update(product, store, now=NOW, exists=always, fetch=fetch, hours=[0, 6], sleep=no_sleep)
    assert fetch.hours() == [("2026100900", 6)]
    assert r2.changed and listing(store, product)["2026100900"]["t2m"] == [0, 6]
    # The run's files were written again with F006 (the F000 frames read back from the old ones)
    assert {fid for r, fid in r2.packed if r == "2026100900"} == {f.id for f in product.fields}
    assert len(list((tmp_path / "runs" / "2026100900").iterdir())) == len(product.fields)  # the old ones are gone


def test_hours_the_source_does_not_have_are_not_retried(tmp_path, product):
    # e.g. a run older than NOMADS keeps: one attempt, no backoff, reported as failed
    store = FrameStore(tmp_path)
    fetch = FakeFetch(gone={("2026100900", 6)})
    slept = []
    r = run_update(product, store, now=NOW, exists=always, fetch=fetch, hours=[0, 6], sleep=slept.append)
    assert fetch.hours().count(("2026100900", 6)) == 1 and slept == []
    assert r.failed == [] and [g[:2] for g in r.gone] == [("2026100900", 6)]


def test_no_complete_cycle_raises(tmp_path, product):
    with pytest.raises(NoCompleteCycle):
        run_update(product, FrameStore(tmp_path), now=NOW, exists=lambda u: False, fetch=FakeFetch())


def test_update_waits_for_full_fetch_range(tmp_path, product):
    missing = {idx_url(product, utc(2026, 10, 9, 0), f) for f in range(246, 385, 6)}
    fetch = FakeFetch()
    r = run_update(product, FrameStore(tmp_path), now=NOW, exists=lambda url: url not in missing,
                   fetch=fetch, quick=True, sleep=no_sleep)
    assert r.latest == "2026100818"
    assert {rid for rid, _ in fetch.hours()} == set(r.targets)
    assert all(len([c for c in fetch.hours() if c[0] == rid]) == 65 for rid in r.targets)


def test_quick_fetches_lag_runs_but_never_prunes_the_window(tmp_path, product):
    store = FrameStore(tmp_path)
    fetch = FakeFetch()
    run_update(product, store, now=NOW, exists=always, fetch=fetch, hours=[0], sleep=no_sleep)
    assert len(store.run_ids()) == 9

    fetch.calls.clear()
    later = datetime(2026, 10, 9, 11, 10, tzinfo=timezone.utc)
    r = run_update(product, store, now=later, exists=always, fetch=fetch, hours=[0], quick=True, sleep=no_sleep)
    assert fetch.hours() == [("2026100906", 0)]
    assert r.pruned == ["2026100700"]
    assert len(store.run_ids()) == 9


def test_stale_manifest_is_rewritten_even_when_frames_are_complete(tmp_path, product):
    store = FrameStore(tmp_path)
    fetch = FakeFetch()
    run_update(product, store, now=NOW, exists=always, fetch=fetch, hours=[0], sleep=no_sleep)
    from .helpers import write
    write(store, product, "2026100900", "t2m", 6)

    fetch.calls.clear()
    r = run_update(product, store, now=NOW, exists=always, fetch=fetch, hours=[0], sleep=no_sleep)
    assert fetch.calls == [] and r.changed
    m = json.loads((tmp_path / "manifest.json").read_text())
    assert m["runs"][0]["hours"]["t2m"] == [0, 6]
    assert not run_update(product, store, now=NOW, exists=always, fetch=fetch, hours=[0], sleep=no_sleep).changed


def test_legacy_layout_is_cleared_and_refetched(tmp_path, product):
    store = FrameStore(tmp_path)
    legacy = tmp_path / "runs" / "2026100900" / "f000.bin.gz"
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(gzip_frame(b"v1"))
    (tmp_path / "manifest.json").write_text(json.dumps({"schema_version": 1}))
    fetch = FakeFetch()
    r = run_update(product, store, now=NOW, exists=always, fetch=fetch, hours=[0], sleep=no_sleep)
    assert r.legacy_removed == 1 and not legacy.exists()
    assert ("2026100900", 0) in fetch.hours()
    assert json.loads((tmp_path / "manifest.json").read_text())["schema_version"] == 4


def test_a_retry_pass_left_with_only_gone_hours_does_not_fail(tmp_path, product):
    # The window's oldest hours are gone from the source and everything else is
    # done: nothing to fetch, nothing failed (cli exits 0), the manifest stands.
    store = FrameStore(tmp_path)
    gone = {("2026100700", 6)}
    run_update(product, store, now=NOW, exists=always, fetch=FakeFetch(gone=gone), hours=[0, 6], sleep=no_sleep)
    r = run_update(product, store, now=NOW, exists=always, fetch=FakeFetch(gone=gone), hours=[0, 6], sleep=no_sleep)
    assert r.fetched == [] and r.failed == [] and [g[:2] for g in r.gone] == [("2026100700", 6)]


def test_older_runs_the_source_no_longer_has_are_skipped_with_one_check(product):
    from wxtrend.update import Job, skip_unpublished_runs

    checked = []

    def exists(url):
        checked.append(url)
        return "gfs.20261007/06/" not in url  # the 2026100706 run has left the source

    jobs = [Job(parse_cycle_id(rid), rid, f, ("t2m",))
            for rid in ("2026100900", "2026100718", "2026100706") for f in (0, 6)]
    kept, gone = skip_unpublished_runs(product, jobs, "2026100900", exists)
    assert gone == ["2026100706"]
    assert {j.run_id for j in kept} == {"2026100900", "2026100718"}
    # One check per older run, at its first missing hour; the latest isn't checked
    assert len(checked) == 2 and all(u.endswith("f000.idx") for u in checked)


def test_a_listed_run_stays_latest_when_one_check_fails(tmp_path, product):
    # A listing or HEAD that fails once must not make the newest run look unposted:
    # stepping back to the run before would prune it from the window (and from R2)
    store = FrameStore(tmp_path)
    run_update(product, store, now=NOW, exists=always, fetch=FakeFetch(), hours=[0], sleep=no_sleep)
    newest = {idx_url(product, utc(2026, 10, 9, 0), 0)}
    fetch = FakeFetch()
    r = run_update(product, store, now=NOW, exists=lambda url: url not in newest, fetch=fetch, hours=[0], sleep=no_sleep)
    assert r.latest == "2026100900" and r.pruned == [] and fetch.calls == []
    assert store.run_ids()[0] == "2026100900" and len(store.run_ids()) == 9
    assert json.loads((tmp_path / "manifest.json").read_text())["latest"] == "2026100900"


def test_a_published_run_stays_latest_when_one_check_fails(tmp_path, product):
    # The same against R2's manifest: the run it lists isn't dropped from the next one
    first = FrameStore(tmp_path / "first")
    run_update(product, first, now=NOW, exists=always, fetch=FakeFetch(), hours=[0], sleep=no_sleep)
    published = json.loads((tmp_path / "first" / "manifest.json").read_text())
    store = FrameStore(tmp_path / "runner")
    newest = {idx_url(product, utc(2026, 10, 9, 0), 0)}
    r = run_update(product, store, now=NOW, exists=lambda url: url not in newest, fetch=FakeFetch(), hours=[0],
                   sleep=no_sleep, published=published)
    assert r.latest == "2026100900" and r.pruned == []


def test_an_explicit_older_cycle_never_prunes_newer_runs(tmp_path, product):
    store = FrameStore(tmp_path)
    run_update(product, store, now=NOW, exists=always, fetch=FakeFetch(), hours=[0], sleep=no_sleep)
    r = run_update(product, store, now=NOW, exists=always, fetch=FakeFetch(), hours=[0], sleep=no_sleep,
                   latest=utc(2026, 10, 8, 0))
    assert r.pruned == [] and "2026100900" in store.run_ids()
    assert json.loads((tmp_path / "manifest.json").read_text())["latest"] == "2026100900"


def test_a_store_in_the_schema_3_layout_is_converted_without_fetching(tmp_path, product):
    store = FrameStore(tmp_path)
    first = FrameStore(tmp_path / "first")
    run_update(product, first, now=NOW, exists=always, fetch=FakeFetch(), hours=[0, 6], sleep=no_sleep)
    m = json.loads((tmp_path / "first" / "manifest.json").read_text())
    # The same frames, laid out one file per frame under a schema-3 manifest
    for run in m["runs"]:
        for fid, hours in run["hours"].items():
            for f in hours:
                write_legacy(store, product, run["id"], fid, f, fill=f % 200)
    old = {k: v for k, v in m.items() if k not in ("file_template", "container")}
    old |= {"schema_version": 3, "path_template": "runs/{run}/{field}/f{fhr:03d}.bin.gz",
            "runs": [{k: v for k, v in r.items() if k != "files"} for r in m["runs"]]}
    (tmp_path / "manifest.json").write_text(json.dumps(old))

    fetch = FakeFetch()
    r = run_update(product, store, now=NOW, exists=always, fetch=fetch, hours=[0, 6], sleep=no_sleep)
    assert fetch.calls == [] and r.changed and len(r.packed) == 9 * len(product.fields)
    new = json.loads((tmp_path / "manifest.json").read_text())
    assert new["schema_version"] == 4 and new["runs"] == m["runs"]  # the same files, byte for byte
    assert store.legacy() == {}
    assert not run_update(product, store, now=NOW, exists=always, fetch=fetch, hours=[0, 6], sleep=no_sleep).changed


def test_repack_converts_a_fixture_store_and_is_then_a_no_op(tmp_path, product):
    from wxtrend.update import repack

    store = FrameStore(tmp_path)
    for f in (0, 6):
        write_legacy(store, product, "2026100900", "t2m", f, fill=40)
    write_legacy(store, product, "2026100812", "t2m", 0)
    assert repack(product, store, NOW) == [("2026100812", "t2m"), ("2026100900", "t2m")]
    m = json.loads((tmp_path / "manifest.json").read_text())
    assert [r["hours"]["t2m"] for r in m["runs"]] == [[0, 6], [0]]
    assert all(r["files"]["t2m"].startswith("t2m.") for r in m["runs"]) and store.legacy() == {}
    shape = (product.grid.ny, product.grid.nx)
    assert (store.read_frame("2026100900", product.field("t2m"), 6, shape)["temp"] == 120).all()
    assert repack(product, store, NOW) == []
