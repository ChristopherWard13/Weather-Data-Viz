"""The private archive: the runs the sources won't serve again, kept after they
leave the public bucket.

    <product>/runs/<YYYYMMDDHH>/<field>.<digest>.bin    run files, as in the public bucket ("full")
    <product>/runs/<YYYYMMDDHH>/f000.<digest>.bin       every field's F000 in one run file ("f000")
    <product>/runs/<YYYYMMDDHH>/run.json                what the archive holds of the run

A product's config says what to keep (``archive``): every frame (``"full"``),
for sources that keep runs less than a year, or the analysis hour only
(``"f000"``). ``archive_product`` runs after each public sync. For "full" it
copies, server side from the public bucket, the run files the archive should
have but doesn't; for "f000" it reads each field's F000 from the public run
files by byte range and writes them as one run file (the same container,
``store.py``, with every field in it). Reading from the public bucket rather
than the runner means a failed copy is retried by any later job while the run
is still public (two days or more).

``run.json`` is a one-run manifest: the public manifest's product, model, grid
and encoding, the run's id and init, the hours archived and the run file
holding each field's (``files``), and the spec of every field archived, so the
run stays readable after an encoding change (which takes a new field id). It's
written after the run's files, so it never names a file that isn't there, and
the next job reads it to work out what's missing. Nothing in the archive is
ever deleted.

Runs archived before manifest schema 4 (from 2026-10-13 until the switch) are
in the schema-3 layout: one object per frame (``store.LEGACY_TEMPLATE``) and a
run.json with ``path_template`` and no ``files``. They're kept as they are. If
one gains hours later, the archive writes the whole run again in run files and
its new run.json names them; a field it held that the public bucket no longer
offers stays in the old layout, listed in ``run.schema_3_fields`` (and the
run.json keeps ``path_template`` for it).
"""

from __future__ import annotations

import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .config import Product
from .cycles import iso_z
from .manifest import SCHEMA_VERSION
from .store import (
    FILE_TEMPLATE, HEADER_PROBE, LEGACY_TEMPLATE, R2_WORKERS, Listing, R2Store, SyncError, files_in, frame_keys, header_length,
    listed_in, merge_listings, pack_frames, r2_client, read_index, require_env, run_file_name,
)

# One token reads the public bucket and writes the archive, so a copy is one request.
ARCHIVE_ENV = ("R2_ACCOUNT_ID", "ARCHIVE_ACCESS_KEY_ID", "ARCHIVE_SECRET_ACCESS_KEY", "R2_BUCKET", "ARCHIVE_BUCKET")
RUN_FILE = "runs/{run}/run.json"
# What every run.json takes from the public manifest, besides its run and fields
SHARED_KEYS = ("schema_version", "product", "model", "grid", "compression", "layout", "filter", "file_template",
               "container")

log = logging.getLogger(__name__)


@dataclass
class ArchiveResult:
    written: list[str] = field(default_factory=list)  # run files copied or written, by key under the product's prefix
    frames: int = 0  # frames archived for the first time (a run written again doesn't count those it had)
    already_archived: int = 0  # frames the archive already had
    runs_written: list[str] = field(default_factory=list)


def stores_from_env(product_id: str) -> tuple[R2Store, R2Store]:
    """(public, archive) for one product, sharing the archive token's client."""
    require_env(ARCHIVE_ENV)
    client = r2_client(os.environ["ARCHIVE_ACCESS_KEY_ID"], os.environ["ARCHIVE_SECRET_ACCESS_KEY"])
    return (R2Store(client, os.environ["R2_BUCKET"], product_id),
            R2Store(client, os.environ["ARCHIVE_BUCKET"], product_id))


def wanted(listed: Listing, mode: str) -> Listing:
    """The frames of ``listed`` that the archive keeps under ``mode``."""
    if mode == "full":
        return listed
    out: Listing = {}
    for run_id, fields in listed.items():
        hours = {fid: [0] for fid, h in fields.items() if 0 in h}
        if hours:
            out[run_id] = hours
    return out


def read_frames(store: R2Store, key: str, field_id: str, hours: list[int]) -> dict[int, bytes]:
    """Some of a field's frames from a run file in R2, by byte range: its header, then each frame."""
    head = store.get_range(key, 0, HEADER_PROBE - 1)
    n = header_length(head)
    if n > len(head):
        head = store.get_range(key, 0, n - 1)
    index = read_index(head).get(field_id, {})
    out = {}
    for f in hours:
        if f not in index:
            raise SyncError(f"{key} has no {field_id} f{f:03d}")
        off, length = index[f]
        out[f] = store.get_range(key, off, off + length - 1)
        if len(out[f]) != length:
            raise SyncError(f"{key}: {field_id} f{f:03d} is {length} bytes, read {len(out[f])}")
    return out


def archive_product(product: Product, public: R2Store, archive: R2Store, workers: int = R2_WORKERS,
                    now: datetime | None = None) -> ArchiveResult:
    """Put into the archive the frames it should have of every run the public manifest
    lists, oldest run first (the next to leave the public bucket), and rewrite each
    changed run's run.json after its files."""
    if public.bucket == archive.bucket:
        raise SyncError("the archive bucket must not be the public bucket")
    manifest = public.read_manifest()
    if manifest is None:
        raise SyncError(f"the public bucket has no {product.id} manifest to archive from")
    result = ArchiveResult()
    if manifest.get("schema_version") != SCHEMA_VERSION:
        # Only a pass that failed before converting the bucket leaves this; the next one converts it
        log.warning("the public %s manifest is schema %s, not %s: nothing archived until it's converted",
                    product.id, manifest.get("schema_version"), SCHEMA_VERSION)
        return result
    now = now or datetime.now(timezone.utc)
    want = wanted(listed_in(manifest), product.archive)
    inits = {r["id"]: r["init"] for r in manifest["runs"]}
    public_files = files_in(manifest)

    with ThreadPoolExecutor(workers) as pool:
        for run_id in sorted(want):
            rel = RUN_FILE.format(run=run_id)
            prior = archive.read_json(rel)
            have = listed_in({"runs": [prior["run"]]}) if prior else {}
            missing = sorted(frame_keys({run_id: want[run_id]}) - frame_keys(have))
            result.already_archived += len(frame_keys({run_id: want[run_id]})) - len(missing)
            if not missing:
                continue
            prior_fields = prior["fields"] if prior else {}

            # A run archived in the schema-3 layout is written again whole, in run files; a
            # field it holds that the public bucket no longer offers stays in that layout
            prior_files = prior["run"].get("files", {}) if prior else {}
            legacy: dict[str, list[int]] = {}
            if prior and not prior_files:
                log.info("%s was archived in the schema-3 layout; writing it again in run files", run_id)
                legacy = {f: h for f, h in have.get(run_id, {}).items() if f not in want[run_id]}
                have = {}
            # The fields written now: those missing frames, or all of them (one F000 file a
            # run, or a schema-3 run written again)
            redo = sorted({fid for _, fid, _ in missing}) if prior_files and product.archive == "full" else \
                list(want[run_id])
            for fid in redo:
                old, new = prior_fields.get(fid), manifest["fields"][fid]
                if old and (old["bands"], old["frame_bytes"]) != (new["bands"], new["frame_bytes"]):
                    raise SyncError(f"{run_id} {fid}: archived with another encoding; an encoding change needs a new field id")

            if product.archive == "full":
                keys = [FILE_TEMPLATE.format(run=run_id, file=public_files[run_id][fid]) for fid in redo]
                list(pool.map(lambda k: archive.copy_from(public, k), keys))  # re-raises the first failure
                files = {**prior_files, **{fid: public_files[run_id][fid] for fid in redo}}
            else:
                # Every field's F000 in one file: read each from its public run file
                got = list(pool.map(
                    lambda fid: read_frames(public, FILE_TEMPLATE.format(run=run_id, file=public_files[run_id][fid]),
                                            fid, [0]), redo))
                data = pack_frames({fid: frames for fid, frames in zip(redo, got)})
                name = run_file_name("f000", data)
                keys = [FILE_TEMPLATE.format(run=run_id, file=name)]
                archive.put_file(keys[0], data)
                files = {**prior_files, **{fid: name for fid in redo}}  # a field no longer offered keeps its older file

            now_written = {run_id: {fid: want[run_id][fid] for fid in redo}}
            hours = merge_listings(have, {run_id: legacy}, now_written)[run_id]
            order = [f for f in manifest["fields"] if f in hours] + [f for f in hours if f not in manifest["fields"]]
            doc = {k: manifest[k] for k in SHARED_KEYS}
            run = {"id": run_id, "init": inits[run_id], "hours": {f: hours[f] for f in order},
                   "files": {f: files[f] for f in order if f in files}}
            if legacy:
                # Their frames are one object each, at path_template
                run["schema_3_fields"] = sorted(legacy)
                doc["path_template"] = LEGACY_TEMPLATE
            doc |= {
                "archive": product.archive,
                "archived_at": iso_z(now),
                "run": run,
                "fields": {f: manifest["fields"][f] if f in redo else prior_fields.get(f) or manifest["fields"][f]
                           for f in order},
            }
            archive.put_json(rel, (json.dumps(doc, indent=1) + "\n").encode())
            result.written += keys
            result.frames += len(missing)
            result.runs_written.append(run_id)
            log.info("archived %s: %d run files written, %d frames in all", run_id, len(keys),
                     len(frame_keys({run_id: hours})))
    log.info("archive (%s): %d run files written (%d new frames), %d frames already there", product.archive,
             len(result.written), result.frames, result.already_archived)
    return result
