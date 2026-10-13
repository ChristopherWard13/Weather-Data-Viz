"""The private archive: the runs the sources won't serve again, kept after they
leave the public bucket.

    <product>/runs/<YYYYMMDDHH>/<field>/f<FFF>.bin.gz    the public bucket's frame keys
    <product>/runs/<YYYYMMDDHH>/run.json                 what the archive holds of the run

A product's config says what to keep (``archive``): every frame (``"full"``),
for sources that keep runs less than a year, or the analysis hour only
(``"f000"``). ``archive_product`` runs after each public sync and copies, server
side from the public bucket, the frames the archive should have but doesn't.
Copying from the public bucket rather than the runner means a failed copy is
retried by any later job while the run is still public (two days or more).

``run.json`` is a one-run manifest: the public manifest's product, model, grid
and encoding, the run's id and init, the hours archived, and the spec of every
field archived, so the run stays readable after an encoding change (which takes
a new field id). It's written after the run's frames are copied, so it never
lists a frame that isn't there, and the next job reads it to work out what's
missing. Nothing in the archive is ever deleted.
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
from .store import (
    PATH_TEMPLATE, R2_WORKERS, Listing, R2Store, SyncError, frame_keys, listed_in, merge_listings, r2_client,
    require_env,
)

# One token reads the public bucket and writes the archive, so a copy is one request.
ARCHIVE_ENV = ("R2_ACCOUNT_ID", "ARCHIVE_ACCESS_KEY_ID", "ARCHIVE_SECRET_ACCESS_KEY", "R2_BUCKET", "ARCHIVE_BUCKET")
RUN_FILE = "runs/{run}/run.json"
# What every run.json takes from the public manifest, besides its run and fields
SHARED_KEYS = ("schema_version", "product", "model", "grid", "compression", "layout", "filter", "path_template")

log = logging.getLogger(__name__)


@dataclass
class ArchiveResult:
    copied: list[tuple[str, str, int]] = field(default_factory=list)  # (run, field, fhr)
    already_archived: int = 0
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


def archive_product(product: Product, public: R2Store, archive: R2Store, workers: int = R2_WORKERS,
                    now: datetime | None = None) -> ArchiveResult:
    """Copy into the archive the frames it should have of every run the public
    manifest lists, oldest run first (the next to leave the public bucket), and
    rewrite each changed run's run.json after its frames."""
    if public.bucket == archive.bucket:
        raise SyncError("the archive bucket must not be the public bucket")
    manifest = public.read_manifest()
    if manifest is None:
        raise SyncError(f"the public bucket has no {product.id} manifest to archive from")
    now = now or datetime.now(timezone.utc)
    want = wanted(listed_in(manifest), product.archive)
    inits = {r["id"]: r["init"] for r in manifest["runs"]}
    result = ArchiveResult()

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
            for fid in {k[1] for k in missing}:
                old, new = prior_fields.get(fid), manifest["fields"][fid]
                if old and (old["bands"], old["frame_bytes"]) != (new["bands"], new["frame_bytes"]):
                    raise SyncError(f"{run_id} {fid}: archived with another encoding; an encoding change needs a new field id")

            def copy(key: tuple[str, str, int]) -> None:
                run, fid, f = key
                archive.copy_from(public, PATH_TEMPLATE.format(run=run, field=fid, fhr=f))

            list(pool.map(copy, missing))  # re-raises the first failure, before run.json changes

            hours = merge_listings(have, {run_id: want[run_id]})[run_id]
            order = [f for f in manifest["fields"] if f in hours] + [f for f in hours if f not in manifest["fields"]]
            doc = {k: manifest[k] for k in SHARED_KEYS}
            doc |= {
                "archive": product.archive,
                "archived_at": iso_z(now),
                "run": {"id": run_id, "init": inits[run_id], "hours": {f: hours[f] for f in order}},
                "fields": {f: prior_fields.get(f) or manifest["fields"][f] for f in order},
            }
            archive.put_json(rel, (json.dumps(doc, indent=1) + "\n").encode())
            result.copied += missing
            result.runs_written.append(run_id)
            log.info("archived %s: %d frames copied, %d in all", run_id, len(missing), len(frame_keys({run_id: hours})))
    log.info("archive (%s): %d frames copied, %d already there", product.archive, len(result.copied),
             result.already_archived)
    return result
