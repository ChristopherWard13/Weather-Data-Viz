"""The private archive, against two in-memory buckets (tests/fake_s3.py): the
public bucket the product jobs sync, and the archive one client also reaches."""

import dataclasses
import json
from datetime import datetime, timezone

import pytest
from botocore.exceptions import ClientError

from wxtrend.archive import ARCHIVE_ENV, SHARED_KEYS, archive_product, stores_from_env, wanted
from wxtrend.cli import main
from wxtrend.store import FRAME_CACHE_CONTROL, R2Store, SyncError, unpack_frames

from .fake_s3 import FakeS3
from .helpers import FakeFetch
from .test_r2 import LATER, NOW, ci_pass, frames_per_run, remote_manifest

THEN = datetime(2026, 10, 9, 5, 30, tzinfo=timezone.utc)


# Fields that start at F006 (6-h amounts)
ACCUMULATED = {"precip", "snow"}

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


def test_f000_keeps_the_analysis_hour_of_every_run_in_one_file(tmp_path, product):
    public, archive, client = buckets()
    ci_pass(product, tmp_path, public, NOW, "run1")
    result = archive_product(product, *stores(client, product), now=THEN)

    assert product.archive == "f000"
    m = remote_manifest(public, product)
    with_f000 = [f.id for f in product.fields if f.id not in ACCUMULATED]  # no precip or snow at F000
    assert result.frames == 9 * len(with_f000) and len(result.written) == 9  # one file a run
    runs = {r["id"]: r for r in m["runs"]}
    for run_id, run in runs.items():
        doc = run_json(archive, product, run_id)
        names = set(doc["run"]["files"].values())
        assert len(names) == 1 and next(iter(names)).startswith("f000.")
        key = f"gfs/runs/{run_id}/{next(iter(names))}"
        assert archive.objects[key]["CacheControl"] == FRAME_CACHE_CONTROL
        held = unpack_frames(archive.objects[key]["Body"])
        assert list(held) == with_f000 and all(list(h) == [0] for h in held.values())
        # Each F000 frame is the public run file's, byte for byte
        public_t2m = unpack_frames(public.objects[f"gfs/runs/{run_id}/{run['files']['t2m']}"]["Body"])["t2m"][0]
        assert held["t2m"][0] == public_t2m
    assert archive.keys("gfs/runs/") == (
        {f"gfs/{k}" for k in result.written} | {f"gfs/runs/{r}/run.json" for r in runs})

    doc = run_json(archive, product, "2026100900")
    assert {k: doc[k] for k in SHARED_KEYS} == {k: m[k] for k in SHARED_KEYS}
    assert doc["run"]["hours"] == {fid: [0] for fid in with_f000}
    assert (doc["run"]["id"], doc["run"]["init"]) == ("2026100900", "2026-10-09T00:00:00Z")
    assert doc["fields"] == {fid: m["fields"][fid] for fid in with_f000}
    assert (doc["archive"], doc["archived_at"]) == ("f000", "2026-10-09T05:30:00Z")
    assert result.runs_written == sorted(runs)  # oldest first
    assert not public.puts()[-1].endswith("run.json")  # nothing written to the public bucket
    # Read by byte range: each field's header, then its F000
    assert all(r is not None for k, r in public.gets if k.endswith(".bin"))


def test_a_second_pass_copies_and_writes_nothing(tmp_path, product):
    public, archive, client = buckets()
    ci_pass(product, tmp_path, public, NOW, "run1")
    first = archive_product(product, *stores(client, product))
    ops = len(archive.ops)
    again = archive_product(product, *stores(client, product))
    assert (again.written, again.runs_written) == ([], [])
    assert again.already_archived == first.frames and len(archive.ops) == ops


def test_full_keeps_every_run_file_and_nothing_is_deleted(tmp_path, full):
    public, archive, client = buckets()
    ci_pass(full, tmp_path, public, NOW, "run1")
    first = archive_product(full, *stores(client, full))
    assert len(first.written) == 9 * len(full.fields) and first.frames == 9 * frames_per_run(full)
    assert set(archive.copies()) == {f"gfs/{k}" for k in first.written}  # server-side copies, as they are

    ci_pass(full, tmp_path, public, LATER, "run2")  # a new run; the oldest leaves the public bucket
    second = archive_product(full, *stores(client, full))
    assert {k.split("/")[1] for k in second.written} == {"2026100906"} and len(second.written) == len(full.fields)
    gone = run_json(archive, full, "2026100700")
    key = f"gfs/runs/2026100700/{gone['run']['files']['precip']}"
    assert key not in public.objects and key in archive.objects
    assert gone["run"]["hours"]["precip"] == [6]
    assert [op for op, _ in archive.ops if op == "delete"] == []


def test_a_run_that_fills_in_later_is_topped_up(tmp_path, full):
    public, archive, client = buckets()
    ci_pass(full, tmp_path, public, NOW, "run1", fetch=FakeFetch(fail={("2026100900", 6)}))
    archive_product(full, *stores(client, full))
    before = run_json(archive, full, "2026100900")
    assert before["run"]["hours"]["t2m"] == [0] and "precip" not in before["run"]["hours"]

    ci_pass(full, tmp_path, public, NOW, "run2")  # F006 fills in: new run files
    later = archive_product(full, *stores(client, full))
    assert later.runs_written == ["2026100900"] and later.frames == len(full.fields)  # every field's F006
    after = run_json(archive, full, "2026100900")
    newest = remote_manifest(public, full)["runs"][0]
    assert after["run"]["hours"] == newest["hours"] and after["run"]["files"] == newest["files"]
    # The earlier files stay too: nothing in the archive is deleted
    assert all(f"gfs/runs/2026100900/{n}" in archive.objects for n in before["run"]["files"].values())


def test_a_run_archived_in_the_schema_3_layout_is_kept_until_it_gains_hours(tmp_path, full):
    public, archive, client = buckets()
    ci_pass(full, tmp_path, public, NOW, "run1")
    m = remote_manifest(public, full)
    legacy = {k: m[k] for k in ("schema_version", "product", "model", "grid", "compression", "layout", "filter")}
    for r in m["runs"]:
        legacy_doc = legacy | {"schema_version": 3, "path_template": "runs/{run}/{field}/f{fhr:03d}.bin.gz",
                               "archive": "full", "archived_at": "2026-10-13T00:00:00Z",
                               "run": {"id": r["id"], "init": r["init"], "hours": r["hours"]}, "fields": m["fields"]}
        if r["id"] == "2026100900":
            legacy_doc["run"]["hours"] = {**r["hours"], "t2m": [0]}  # its F006 not archived yet
        archive.objects[f"gfs/runs/{r['id']}/run.json"] = {
            "Body": json.dumps(legacy_doc).encode(), "ContentType": "application/json", "CacheControl": "x"}
    result = archive_product(full, *stores(client, full))
    assert result.runs_written == ["2026100900"]  # the others hold every hour already
    doc = run_json(archive, full, "2026100900")
    assert doc["schema_version"] == 4 and doc["run"]["files"] == m["runs"][0]["files"]  # written again whole
    assert len(result.written) == len(full.fields)


def test_a_failed_copy_leaves_run_json_alone_and_the_next_pass_recovers(tmp_path, full):
    public, archive, client = buckets()
    ci_pass(full, tmp_path, public, NOW, "run1")
    archive.fail_puts.add("gfs/runs/2026100818/t2m.")
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


def test_an_encoding_change_is_refused_for_every_field_a_rewrite_covers(tmp_path, product):
    # F000 mode writes every field's F000 again when one field's arrives late: t2m's
    # encoding changed under the same id must be caught, though only mslp was missing
    public, archive, client = buckets()
    ci_pass(product, tmp_path, public, NOW, "run1")
    src, dst = stores(client, product)
    archive_product(product, src, dst)
    doc = run_json(archive, product, "2026100900")
    for k in ("hours", "files"):
        del doc["run"][k]["mslp"]
    del doc["fields"]["mslp"]
    dst.put_json("runs/2026100900/run.json", json.dumps(doc).encode())
    m = remote_manifest(public, product)
    m["fields"]["t2m"]["bands"][0]["scale"] = 0.5
    src.put_json("manifest.json", json.dumps(m).encode())
    with pytest.raises(SyncError, match="2026100900 t2m: archived with another encoding"):
        archive_product(product, src, dst)


def test_a_schema_3_run_written_again_keeps_a_field_the_public_bucket_dropped(tmp_path, full):
    public, archive, client = buckets()
    ci_pass(full, tmp_path, public, NOW, "run1")
    m = remote_manifest(public, full)
    r = m["runs"][0]
    legacy_doc = {k: m[k] for k in ("product", "model", "grid", "compression", "layout", "filter")} | {
        "schema_version": 3, "path_template": "runs/{run}/{field}/f{fhr:03d}.bin.gz", "archive": "full",
        "archived_at": "2026-10-13T00:00:00Z",
        "run": {"id": r["id"], "init": r["init"], "hours": {**r["hours"], "t2m": [0], "cape": [0, 6]}},
        "fields": {**m["fields"], "cape": m["fields"]["gust"]},  # a field since dropped from the config
    }
    archive.objects[f"gfs/runs/{r['id']}/run.json"] = {
        "Body": json.dumps(legacy_doc).encode(), "ContentType": "application/json", "CacheControl": "x"}
    result = archive_product(full, *stores(client, full))
    assert r["id"] in result.runs_written
    doc = run_json(archive, full, r["id"])
    assert doc["run"]["hours"]["cape"] == [0, 6] and "cape" not in doc["run"]["files"]
    assert doc["run"]["schema_3_fields"] == ["cape"] and doc["path_template"] == "runs/{run}/{field}/f{fhr:03d}.bin.gz"
    assert doc["fields"]["cape"] == m["fields"]["gust"]
    assert doc["run"]["files"] == r["files"] and all(doc["run"]["hours"][f] == h for f, h in r["hours"].items())


def test_a_public_bucket_not_yet_converted_is_left_for_the_next_pass(tmp_path, product):
    public, archive, client = buckets()
    ci_pass(product, tmp_path, public, NOW, "run1")
    m = remote_manifest(public, product)
    public.objects["gfs/manifest.json"]["Body"] = json.dumps({**m, "schema_version": 3}).encode()
    result = archive_product(product, *stores(client, product))
    assert result.written == [] and archive.ops == []


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
    assert "**gfs** → archive (f000): 9 run files written (99 new frames), 0 frames already there" in summary.read_text()
