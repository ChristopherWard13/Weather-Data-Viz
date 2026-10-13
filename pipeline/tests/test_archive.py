"""The private archive, against two in-memory buckets (tests/fake_s3.py): the
public bucket the product jobs sync, and the archive one client also reaches."""

import dataclasses
import json
from datetime import datetime, timezone

import pytest
from botocore.exceptions import ClientError

from wxtrend.archive import ARCHIVE_ENV, SHARED_KEYS, archive_product, stores_from_env, wanted
from wxtrend.cli import main
from wxtrend.store import FRAME_CACHE_CONTROL, R2Store, SyncError

from .fake_s3 import FakeS3
from .test_r2 import LATER, NOW, ci_pass, frames_per_run, remote_manifest

THEN = datetime(2026, 10, 9, 5, 30, tzinfo=timezone.utc)


def buckets():
    """(public, archive, the stores archive_product takes)."""
    public, archive = FakeS3("public"), FakeS3("archive")
    client = public.link(archive)
    return public, archive, client


def stores(client, product):
    return R2Store(client, "public", product.id), R2Store(client, "archive", product.id)


def run_json(archive, product, run_id):
    return json.loads(archive.objects[f"{product.id}/runs/{run_id}/run.json"]["Body"])


@pytest.fixture
def full(product):
    return dataclasses.replace(product, archive="full")


def test_wanted():
    listed = {"2026100900": {"t2m": [0, 6], "precip": [6]}, "2026100818": {"precip": [6, 12]}}
    assert wanted(listed, "full") == listed
    assert wanted(listed, "f000") == {"2026100900": {"t2m": [0]}}  # precip starts at F006


def test_f000_keeps_the_analysis_hour_of_every_run(tmp_path, product):
    public, archive, client = buckets()
    ci_pass(product, tmp_path, public, NOW, "run1")
    result = archive_product(product, *stores(client, product), now=THEN)

    assert product.archive == "f000"
    m = remote_manifest(public, product)
    assert len(result.copied) == 9 * (len(product.fields) - 1)  # no precip at F000
    assert archive.keys("gfs/runs/") == (
        {f"gfs/runs/{r['id']}/{fid}/f000.bin.gz" for r in m["runs"] for fid in r["hours"] if fid != "precip"}
        | {f"gfs/runs/{r['id']}/run.json" for r in m["runs"]}
    )
    frame = "gfs/runs/2026100900/t2m/f000.bin.gz"
    assert archive.objects[frame] == public.objects[frame]  # same bytes and headers
    assert archive.objects[frame]["CacheControl"] == FRAME_CACHE_CONTROL

    doc = run_json(archive, product, "2026100900")
    assert {k: doc[k] for k in SHARED_KEYS} == {k: m[k] for k in SHARED_KEYS}
    assert doc["run"] == {"id": "2026100900", "init": "2026-10-09T00:00:00Z",
                          "hours": {f.id: [0] for f in product.fields if f.id != "precip"}}
    assert doc["fields"] == {fid: spec for fid, spec in m["fields"].items() if fid != "precip"}
    assert (doc["archive"], doc["archived_at"]) == ("f000", "2026-10-09T05:30:00Z")
    assert result.runs_written == sorted(r["id"] for r in m["runs"])  # oldest first
    assert not public.puts()[-1].endswith("run.json")  # nothing written to the public bucket


def test_a_second_pass_copies_and_writes_nothing(tmp_path, product):
    public, archive, client = buckets()
    ci_pass(product, tmp_path, public, NOW, "run1")
    first = archive_product(product, *stores(client, product))
    ops = len(archive.ops)
    again = archive_product(product, *stores(client, product))
    assert (again.copied, again.runs_written) == ([], [])
    assert again.already_archived == len(first.copied) and len(archive.ops) == ops


def test_full_keeps_every_frame_and_nothing_is_deleted(tmp_path, full):
    public, archive, client = buckets()
    ci_pass(full, tmp_path, public, NOW, "run1")
    first = archive_product(full, *stores(client, full))
    assert len(first.copied) == 9 * frames_per_run(full)

    ci_pass(full, tmp_path, public, LATER, "run2")  # a new run; the oldest leaves the public bucket
    second = archive_product(full, *stores(client, full))
    assert {k[0] for k in second.copied} == {"2026100906"} and len(second.copied) == frames_per_run(full)
    gone = "gfs/runs/2026100700/t2m/f006.bin.gz"
    assert gone not in public.objects and gone in archive.objects
    assert run_json(archive, full, "2026100700")["run"]["hours"]["precip"] == [6]
    assert [op for op, _ in archive.ops if op == "delete"] == []


def test_a_run_that_fills_in_later_is_topped_up(tmp_path, full):
    public, archive, client = buckets()
    ci_pass(full, tmp_path, public, NOW, "run1")
    src, dst = stores(client, full)
    m = remote_manifest(public, full)
    newest = m["runs"][0]
    newest["hours"]["t2m"] = [0]  # as if F006 hadn't been fetched yet
    src.put_json("manifest.json", json.dumps(m).encode())
    archive_product(full, src, dst)
    assert run_json(archive, full, "2026100900")["run"]["hours"]["t2m"] == [0]

    newest["hours"]["t2m"] = [0, 6]
    src.put_json("manifest.json", json.dumps(m).encode())
    later = archive_product(full, src, dst)
    assert later.copied == [("2026100900", "t2m", 6)] and later.runs_written == ["2026100900"]
    assert run_json(archive, full, "2026100900")["run"]["hours"]["t2m"] == [0, 6]


def test_a_failed_copy_leaves_run_json_alone_and_the_next_pass_recovers(tmp_path, full):
    public, archive, client = buckets()
    ci_pass(full, tmp_path, public, NOW, "run1")
    archive.fail_puts.add("gfs/runs/2026100818/t2m/f006.bin.gz")
    with pytest.raises(ClientError):
        archive_product(full, *stores(client, full))
    assert "gfs/runs/2026100800/run.json" in archive.objects  # older runs finished
    assert "gfs/runs/2026100818/run.json" not in archive.objects
    assert "gfs/runs/2026100900/run.json" not in archive.objects  # stopped at the failure

    archive.fail_puts.clear()
    archive_product(full, *stores(client, full))
    for r in remote_manifest(public, full)["runs"]:
        assert run_json(archive, full, r["id"])["run"]["hours"] == r["hours"]


def test_refuses_an_encoding_change_under_the_same_field_id(tmp_path, full):
    public, archive, client = buckets()
    ci_pass(full, tmp_path, public, NOW, "run1")
    src, dst = stores(client, full)
    archive_product(full, src, dst)
    doc = run_json(archive, full, "2026100900")
    doc["run"]["hours"]["t2m"] = [0]  # F006 still to copy
    doc["fields"]["t2m"]["bands"][0]["scale"] = 0.5
    dst.put_json("runs/2026100900/run.json", json.dumps(doc).encode())
    with pytest.raises(SyncError, match="needs a new field id"):
        archive_product(full, src, dst)


def test_refuses_without_a_manifest_or_with_one_bucket(product):
    public, _, client = buckets()
    with pytest.raises(SyncError, match="no gfs manifest"):
        archive_product(product, *stores(client, product))
    with pytest.raises(SyncError, match="must not be the public bucket"):
        archive_product(product, R2Store(client, "public", "gfs"), R2Store(client, "public", "gfs"))


def test_stores_from_env_need_every_variable(monkeypatch):
    monkeypatch.setenv("R2_ACCOUNT_ID", "x")
    with pytest.raises(SyncError, match="ARCHIVE_ACCESS_KEY_ID, ARCHIVE_SECRET_ACCESS_KEY, R2_BUCKET, ARCHIVE_BUCKET"):
        stores_from_env("gfs")
    for name in ARCHIVE_ENV:
        monkeypatch.setenv(name, "x")
    with pytest.raises(AssertionError, match="fake_s3"):  # conftest blocks real clients
        stores_from_env("gfs")


def test_cli_archive(tmp_path, product, monkeypatch):
    public, archive, client = buckets()
    ci_pass(product, tmp_path, public, NOW, "run1")
    monkeypatch.setattr("wxtrend.archive.stores_from_env", lambda pid: stores(client, product))
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    assert main(["--data-dir", str(tmp_path / "data"), "archive"]) == 0
    assert "gfs/runs/2026100900/run.json" in archive.objects
    assert "**gfs** → archive (f000): 99 frames copied, 0 already there" in summary.read_text()
