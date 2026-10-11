"""The R2 sync, against an in-memory S3 client (tests/fake_s3.py). Nothing here
touches the real bucket: conftest drops the credentials and blocks boto3."""

import json
from datetime import datetime, timezone

import pytest
from botocore.exceptions import ClientError

from wxtrend.cli import main
from wxtrend.manifest import build_manifest, write_manifest
from wxtrend.store import (
    FRAME_CACHE_CONTROL,
    MANIFEST_CACHE_CONTROL,
    R2_ENV,
    FrameStore,
    R2Store,
    SyncError,
    sync_to_r2,
)
from wxtrend.update import run_update

from .fake_s3 import FakeS3
from .helpers import FakeFetch, always, no_sleep

NOW = datetime(2026, 10, 9, 5, 10, tzinfo=timezone.utc)  # latest complete cycle: 2026100900
LATER = datetime(2026, 10, 9, 11, 10, tzinfo=timezone.utc)  # latest: 2026100906
HOURS = [0, 6]


def ci_pass(product, tmp_path, s3, now, name):
    """One product.yml run: a fresh runner (empty local store) updates against R2, then syncs."""
    store = FrameStore(tmp_path / name / product.id)
    remote = R2Store(s3, s3.bucket, product.id)
    fetch = FakeFetch()
    result = run_update(product, store, now=now, exists=always, fetch=fetch, hours=HOURS, sleep=no_sleep,
                        published=remote.read_manifest() or {})
    synced = sync_to_r2(store, remote) if result.changed else None
    return result, synced, fetch


def remote_manifest(s3, product):
    return json.loads(s3.objects[f"{product.id}/manifest.json"]["Body"])


def frames_per_run(product):
    return len(HOURS) * len(product.fields) - 1  # no precip at F000


def test_first_pass_fills_an_empty_bucket(tmp_path, product):
    s3 = FakeS3()
    result, synced, fetch = ci_pass(product, tmp_path, s3, NOW, "run1")
    assert result.latest == "2026100900" and len(fetch.calls) == 9 * len(HOURS)

    m = remote_manifest(s3, product)
    assert m["latest"] == "2026100900" and len(m["runs"]) == 9
    listed = {
        f"gfs/runs/{run['id']}/{fid}/f{f:03d}.bin.gz"
        for run in m["runs"] for fid, hours in run["hours"].items() for f in hours
    }
    assert listed == s3.keys("gfs/runs/") and len(listed) == 9 * frames_per_run(product)
    local = FrameStore(tmp_path / "run1" / "gfs")
    assert s3.objects["gfs/runs/2026100900/t2m/f006.bin.gz"]["Body"] == local.frame_path("2026100900", "t2m", 6).read_bytes()
    assert s3.puts()[-1] == "gfs/manifest.json" and s3.puts().count("gfs/manifest.json") == 1
    assert synced.pruned == [] and synced.already_published == 0


def test_cache_headers_and_content_types(tmp_path, product):
    s3 = FakeS3()
    ci_pass(product, tmp_path, s3, NOW, "run1")
    frame = s3.objects["gfs/runs/2026100900/t2m/f000.bin.gz"]
    assert frame["CacheControl"] == FRAME_CACHE_CONTROL == "public, max-age=31536000, immutable"
    assert frame["ContentType"] == "application/octet-stream"
    assert frame["Body"][:2] == b"\x1f\x8b"  # stored gzipped, served as is (no Content-Encoding)
    manifest = s3.objects["gfs/manifest.json"]
    assert manifest["CacheControl"] == MANIFEST_CACHE_CONTROL == "public, max-age=60"
    assert manifest["ContentType"] == "application/json"


def test_next_cycle_fetches_only_what_r2_lacks_then_prunes(tmp_path, product):
    s3 = FakeS3(page_size=7)  # small pages exercise the listing pagination
    ci_pass(product, tmp_path, s3, NOW, "run1")
    s3.ops.clear()

    result, synced, fetch = ci_pass(product, tmp_path, s3, LATER, "run2")
    assert {run for run, _ in fetch.hours()} == {"2026100906"}  # the R2 manifest decided
    assert result.pruned == ["2026100700"] and synced.pruned == ["2026100700"]

    # Frames first, then the manifest, then the deletes
    at = s3.ops.index(("put", "gfs/manifest.json"))
    uploads, deletes = s3.ops[:at], s3.ops[at + 1:]
    assert uploads and all(op == "put" and k.startswith("gfs/runs/2026100906/") for op, k in uploads)
    assert len(uploads) == frames_per_run(product)
    assert deletes and all(op == "delete" and k.startswith("gfs/runs/2026100700/") for op, k in deletes)
    assert not s3.keys("gfs/runs/2026100700/")

    m = remote_manifest(s3, product)
    ids = [r["id"] for r in m["runs"]]
    assert ids[0] == m["latest"] == "2026100906" and len(ids) == 9 and "2026100700" not in ids
    assert synced.already_published == 8 * frames_per_run(product)  # never rewritten


def test_a_processed_cycle_is_a_no_op(tmp_path, product):
    s3 = FakeS3()
    ci_pass(product, tmp_path, s3, NOW, "run1")
    s3.ops.clear()
    result, synced, fetch = ci_pass(product, tmp_path, s3, NOW, "run2")
    assert not result.changed and fetch.calls == [] and synced is None and s3.ops == []
    assert not (tmp_path / "run2" / "gfs" / "manifest.json").exists()


def test_a_failed_upload_publishes_nothing_and_the_next_pass_recovers(tmp_path, product):
    s3 = FakeS3()
    ci_pass(product, tmp_path, s3, NOW, "run1")
    before = remote_manifest(s3, product)
    s3.fail_puts.add("gfs/runs/2026100906/t2m/f006.bin.gz")
    with pytest.raises(ClientError):
        ci_pass(product, tmp_path, s3, LATER, "run2")
    assert remote_manifest(s3, product) == before
    assert s3.keys("gfs/runs/2026100700/")  # nothing deleted

    s3.fail_puts.clear()
    _, _, fetch = ci_pass(product, tmp_path, s3, LATER, "run3")
    assert {run for run, _ in fetch.hours()} == {"2026100906"}
    assert remote_manifest(s3, product)["latest"] == "2026100906"


def test_refuses_to_list_a_frame_that_is_nowhere(tmp_path, product):
    s3 = FakeS3()
    store = FrameStore(tmp_path / "gfs")
    run_update(product, store, now=NOW, exists=always, fetch=FakeFetch(), hours=HOURS, sleep=no_sleep, published={})
    store.frame_path("2026100900", "t2m", 6).unlink()
    with pytest.raises(SyncError, match="neither on disk nor in R2"):
        sync_to_r2(store, R2Store(s3, s3.bucket, "gfs"))
    assert s3.ops == []


def test_refuses_when_r2_changed_after_the_update(tmp_path, product):
    s3 = FakeS3()
    stale = FrameStore(tmp_path / "stale" / "gfs")
    run_update(product, stale, now=NOW, exists=always, fetch=FakeFetch(), hours=HOURS, sleep=no_sleep, published={})
    ci_pass(product, tmp_path, s3, LATER, "meanwhile")  # another pass publishes a newer manifest
    s3.ops.clear()
    with pytest.raises(SyncError, match="newer"):
        sync_to_r2(stale, R2Store(s3, s3.bucket, "gfs"))
    assert s3.ops == []


def test_refuses_an_empty_manifest_or_another_products(tmp_path, product):
    s3 = FakeS3()
    store = FrameStore(tmp_path / "gfs")
    write_manifest(store, build_manifest(product, {}, generated_at=NOW))
    with pytest.raises(SyncError, match="lists no frames"):
        sync_to_r2(store, R2Store(s3, s3.bucket, "gfs"))
    run_update(product, store, now=NOW, exists=always, fetch=FakeFetch(), hours=HOURS, sleep=no_sleep, published={})
    with pytest.raises(SyncError, match="not nam-conus"):
        sync_to_r2(store, R2Store(s3, s3.bucket, "nam-conus"))
    assert s3.ops == []


def test_unlisted_runs_are_deleted_but_other_products_are_untouched(tmp_path, product):
    s3 = FakeS3()
    orphan = {"Body": b"\x1f\x8b", "ContentType": "application/octet-stream", "CacheControl": FRAME_CACHE_CONTROL}
    s3.objects["gfs/runs/2026100500/t2m/f000.bin.gz"] = dict(orphan)  # left by a pass that failed before its manifest
    s3.objects["nam-conus/runs/2026100500/t2m/f000.bin.gz"] = dict(orphan)
    _, synced, _ = ci_pass(product, tmp_path, s3, NOW, "run1")
    assert synced.pruned == ["2026100500"]
    assert not s3.keys("gfs/runs/2026100500/")
    assert s3.keys("nam-conus/")


def test_read_manifest(product):
    s3 = FakeS3()
    remote = R2Store(s3, s3.bucket, "gfs")
    assert remote.read_manifest() is None  # an empty bucket

    def denied(**kwargs):
        raise ClientError({"Error": {"Code": "AccessDenied", "Message": "no"}}, "GetObject")

    s3.get_object = denied
    with pytest.raises(ClientError):  # never mistaken for an empty bucket
        remote.read_manifest()


def test_from_env_needs_every_variable(monkeypatch):
    monkeypatch.setenv("R2_ACCOUNT_ID", "x")
    with pytest.raises(SyncError, match="R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET"):
        R2Store.from_env("gfs")


def test_tests_cannot_build_a_real_client(monkeypatch):
    for name in R2_ENV:
        monkeypatch.setenv(name, "x")
    with pytest.raises(AssertionError, match="fake_s3"):
        R2Store.from_env("gfs")


def test_cli_verify_and_sync(tmp_path, product, monkeypatch):
    """What product.yml runs after `update --remote`, with the store under <data-dir>/<product>/."""
    s3 = FakeS3()
    monkeypatch.setattr(R2Store, "from_env", staticmethod(lambda pid: R2Store(s3, s3.bucket, pid)))
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    ci_pass(product, tmp_path, s3, NOW, "run1")

    data = tmp_path / "data"
    store = FrameStore(data / "gfs")
    run_update(product, store, now=LATER, exists=always, fetch=FakeFetch(), hours=HOURS, sleep=no_sleep,
               published=R2Store(s3, s3.bucket, "gfs").read_manifest())
    assert main(["--data-dir", str(data), "verify"]) == 1  # most listed frames are only in R2
    assert main(["--data-dir", str(data), "verify", "--remote"]) == 0
    assert main(["--data-dir", str(data), "sync"]) == 0
    assert remote_manifest(s3, product)["latest"] == "2026100906"
    assert "frames uploaded" in summary.read_text()
    assert main(["--data-dir", str(data), "sync"]) == 0  # publishing the same manifest again is harmless
