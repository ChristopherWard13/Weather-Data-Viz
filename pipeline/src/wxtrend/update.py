"""One pipeline pass: find the latest complete cycle, fill the retention window,
prune old runs, pack each changed run into its run files, and rewrite the
manifest.

Against R2 (``published``), the remote manifest decides what's missing: frames
it lists count as present, and the new manifest lists them alongside the frames
fetched now. A run file that must be rewritten (an hour filled in later) is
read back from R2 (``read_remote``). ``store.sync_to_r2`` then publishes it.
"""

from __future__ import annotations

import logging
import multiprocessing
import tempfile
import time
from collections.abc import Callable
from concurrent.futures import Executor, ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

import numpy as np

from .config import Product
from .cycles import ExistsFn, cycle_id, find_latest_complete_cycle, parse_cycle_id, previous_cycles
from .fetch import NotPublished
from .manifest import SCHEMA_VERSION, build_manifest, manifest_lists, read_manifest, write_manifest
from .store import (
    FILE_TEMPLATE, LEGACY_TEMPLATE, R2_WORKERS, FrameStore, Listing, RunFiles, encode_frame, files_in, gzip_frame,
    listed_in, merge_listings, pack_frames, unpack_frames,
)

log = logging.getLogger(__name__)

# (product, init, fhr, field ids, work dir) -> {field id: {band: physical values}}
FetchFn = Callable[[Product, datetime, int, list[str], Path], dict[str, dict[str, np.ndarray]]]
# An object's bytes in R2, by its key under the product's prefix
ReadRemote = Callable[[str], bytes]


class NoCompleteCycle(RuntimeError):
    pass


@dataclass(frozen=True)
class Job:
    init: datetime
    run_id: str
    fhr: int
    fields: tuple[str, ...]


@dataclass
class UpdateResult:
    latest: str
    targets: list[str]
    fetched: list[tuple[str, int, str]] = field(default_factory=list)  # (run, fhr, field)
    failed: list[tuple[str, int, str]] = field(default_factory=list)  # (run, fhr, error)
    # Hours the source doesn't have (404), and older runs it no longer has at
    # all: expected after an outage longer than the source keeps (2 days for
    # AIGEFS/HGEFS), so they don't fail the job. They age out of the window.
    gone: list[tuple[str, int, str]] = field(default_factory=list)  # (run, fhr, error)
    unavailable: list[str] = field(default_factory=list)  # runs skipped: not at the source
    pruned: list[str] = field(default_factory=list)  # runs the new manifest drops
    packed: list[tuple[str, str]] = field(default_factory=list)  # (run, field) run files written
    legacy_removed: int = 0
    manifest_written: bool = False

    @property
    def changed(self) -> bool:
        return bool(self.fetched or self.pruned or self.legacy_removed or self.manifest_written)


def target_cycles(product: Product, latest: datetime, quick: bool = False) -> list[datetime]:
    """Runs to keep, newest first.

    Normally the full retention window (latest plus older runs back to the
    longest lag). ``quick`` keeps only the runs the latest run is compared
    against, which is enough to view every lag for the newest run.
    """
    if quick:
        return [latest] + [latest - timedelta(hours=lag) for lag in product.lags]
    return previous_cycles(latest, product.retained_runs, product.cycle_interval_hours)


def missing_jobs(product: Product, have: Listing, targets: list[datetime], hours: list[int],
                 field_ids: list[str] | None = None) -> list[Job]:
    jobs = []
    for init in targets:
        run_id = cycle_id(init)
        run_has = have.get(run_id, {})
        for fhr in hours:
            need = tuple(
                f.id for f in product.fields_for_hour(fhr)
                if (field_ids is None or f.id in field_ids) and fhr not in run_has.get(f.id, ())
            )
            if need:
                jobs.append(Job(init, run_id, fhr, need))
    return jobs


def run_update(
    product: Product,
    store: FrameStore,
    *,
    now: datetime,
    exists: ExistsFn,
    fetch: FetchFn,
    latest: datetime | None = None,
    quick: bool = False,
    hours: list[int] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    executor: Literal["thread", "process"] = "thread",
    published: dict | None = None,
    read_remote: ReadRemote | None = None,
) -> UpdateResult:
    """``published``: the product's manifest in R2 ({} if it has none yet), or
    None to work from the local store alone. ``read_remote`` reads an object from
    R2, for run files that must be rewritten (and, once, the schema-3 layout's
    frames, which every run is repacked from)."""
    hours = sorted(hours if hours is not None else product.fetch_hours)
    current = read_manifest(store) if published is None else published
    if latest is None:
        latest = find_latest_complete_cycle(product, now, exists, hours)
        if latest is None:
            raise NoCompleteCycle(
                f"no complete {product.id} cycle in the last {product.lookback_cycles} cycles"
            )
        # A run the manifest already lists stays the latest even when this pass
        # couldn't see it posted (a listing or HEAD that failed once): stepping
        # back would prune it from the window, and from R2.
        listed_latest = (current or {}).get("latest")
        if listed_latest and listed_latest > cycle_id(latest):
            log.warning("%s isn't visible at the source this pass, but the manifest lists it: keeping it as the latest",
                        listed_latest)
            latest = parse_cycle_id(listed_latest)

    targets = target_cycles(product, latest, quick)
    target_ids = [cycle_id(t) for t in targets]
    result = UpdateResult(latest=cycle_id(latest), targets=target_ids)

    result.legacy_removed = store.remove_legacy()
    if result.legacy_removed:
        log.info("removed %d frames in the old schema-1 layout", result.legacy_removed)

    field_ids = [f.id for f in product.fields]
    remote = listed_in(published)
    # Pruning always uses the full retention window, so a --quick pass never
    # deletes runs that a full pass fetched, and never drops a run newer than
    # the latest (an explicit --cycle older than the data).
    keep_ids = {cycle_id(t) for t in target_cycles(product, latest)}
    keep_ids |= {r for r in (*store.run_ids(), *remote) if r > result.latest}
    jobs = missing_jobs(product, merge_listings(store.listing(field_ids), remote), targets, hours)
    jobs, result.unavailable = skip_unpublished_runs(product, jobs, result.latest, exists)
    for run_id in result.unavailable:
        log.warning("run %s is no longer at the source; skipping its missing hours", run_id)
    stale = [r for r in store.run_ids() if r not in keep_ids]

    def window() -> Listing:
        listed = merge_listings(store.listing(field_ids), remote)
        return {r: h for r, h in listed.items() if r in keep_ids}

    if not jobs and not stale and manifest_lists(product, current, window()):
        log.info("no-op: %s and its retention window are already processed", result.latest)
        return result

    if jobs:
        n_frames = sum(len(j.fields) for j in jobs)
        log.info("fetching %d hours (%d frames) across %d runs", len(jobs), n_frames, len({j.run_id for j in jobs}))
        fetch_frames(product, store, jobs, fetch, result, sleep, executor)

    dropped = set(store.prune(keep_ids)) | {r for r in remote if r not in keep_ids}
    result.pruned = sorted(dropped, reverse=True)
    for run_id in result.pruned:
        log.info("pruned run %s", run_id)

    files, result.packed, listed = pack_runs(product, store, window(), current, read_remote,
                                             in_r2=published is not None)
    write_manifest(store, build_manifest(product, listed, files, generated_at=now))
    store.finish(files)
    result.manifest_written = True
    return result


def pack_runs(product: Product, store: FrameStore, listed: Listing, current: dict | None,
              read_remote: ReadRemote | None = None, in_r2: bool = False,
              workers: int = R2_WORKERS) -> tuple[RunFiles, list[tuple[str, str]], Listing]:
    """Write the run files ``listed`` needs. Returns every listed run's files, the
    (run, field) pairs written, and the frames the files hold: ``listed``, less any
    frame of the schema-3 layout that its manifest lists but R2 doesn't have.

    ``current`` is the manifest the pass started from: R2's (``in_r2``), whose files
    are in the bucket, or the local store's, whose files are on disk. A field of a run
    keeps the file ``current`` names for it when nothing is staged for it and
    ``current`` lists the same hours. Otherwise its frames are gathered from that
    file, from the local store's own run file (a pass against R2 whose sync didn't
    happen), from the schema-3 layout, and from the staged frames (later wins), and
    written as a new file. Frames not on disk are read with ``read_remote``: when a
    run's hour fills in later, or once, when a bucket still in the schema-3 layout is
    converted. A schema-3 frame that's gone is dropped with a warning, to be fetched
    again by the next pass, rather than stopping every pass.
    """
    version = (current or {}).get("schema_version")
    prior = files_in(current) if version == SCHEMA_VERSION else {}
    prior_hours = listed_in(current)
    local = store.run_files()
    staged = store.staged()
    legacy_remote = listed_in(current) if version == 3 else {}  # a schema-3 manifest's frames
    legacy_local = store.legacy()
    order = [f.id for f in product.fields]

    def read(rel: str) -> bytes:
        path = store.root / rel
        if path.is_file():
            return path.read_bytes()
        if read_remote is None:
            raise FileNotFoundError(f"{rel} isn't on disk, and there's no remote to read it from")
        return read_remote(rel)

    def pack(run_id: str, fid: str) -> tuple[str | None, bool, list[int]]:
        hours = listed[run_id][fid]
        name = prior.get(run_id, {}).get(fid)
        if name and not in_r2 and not store.file_path(run_id, name).is_file():
            name = None  # deleted from the local store (to fetch the field again)
        if name and not staged.get(run_id, {}).get(fid) and prior_hours.get(run_id, {}).get(fid) == hours:
            return name, False, hours
        frames: dict[int, bytes] = {}
        if name:
            frames.update(unpack_frames(read(FILE_TEMPLATE.format(run=run_id, file=name))).get(fid, {}))
        mine = local.get(run_id, {}).get(fid)
        if mine and mine != name:
            frames.update(unpack_frames(store.file_path(run_id, mine).read_bytes()).get(fid, {}))
        lost = []
        for f in hours:
            if f in frames or f in staged.get(run_id, {}).get(fid, ()):
                continue
            if f in legacy_local.get(run_id, {}).get(fid, ()) or f in legacy_remote.get(run_id, {}).get(fid, ()):
                try:
                    frames[f] = read(LEGACY_TEMPLATE.format(run=run_id, field=fid, fhr=f))
                except FileNotFoundError:
                    lost.append(f)
        for f in staged.get(run_id, {}).get(fid, ()):
            frames[f] = store.staged_path(run_id, fid, f).read_bytes()
        missing = sorted(set(hours) - set(frames) - set(lost))
        if missing:
            raise RuntimeError(f"{product.id} {run_id} {fid}: no frame for hours {missing} on disk or in R2")
        if lost:
            log.warning("%s %s %s: the schema-3 manifest lists hours %s, but R2 doesn't have them; they're left "
                        "out, for the next pass to fetch again", product.id, run_id, fid, lost)
        kept = [f for f in hours if f in frames]
        if not kept:
            return None, False, []
        return store.write_run_file(run_id, fid, pack_frames({fid: {f: frames[f] for f in kept}})), True, kept

    pairs = [(r, fid) for r in sorted(listed) for fid in order if listed[r].get(fid)]
    with ThreadPoolExecutor(workers) as pool:
        done = list(pool.map(lambda p: pack(*p), pairs))
    files: RunFiles = {}
    held: Listing = {}
    written = []
    for (run_id, fid), (name, new, kept) in zip(pairs, done):
        if name is None:
            continue
        files.setdefault(run_id, {})[fid] = name
        held.setdefault(run_id, {})[fid] = kept
        if new:
            written.append((run_id, fid))
    if written:
        log.info("packed %d run files across %d runs", len(written), len({r for r, _ in written}))
    return files, written, held


def repack(product: Product, store: FrameStore, now: datetime) -> list[tuple[str, str]]:
    """Pack whatever the local store holds (staged, or in the schema-3 layout) into run
    files and rewrite its manifest, without fetching: converts a store, such as an e2e
    fixture bundle, to the current layout. Returns the (run, field) files written."""
    listed = store.listing([f.id for f in product.fields])
    current = read_manifest(store)
    if listed and manifest_lists(product, current, listed) and not store.staged() and not store.legacy():
        return []
    files, written, listed = pack_runs(product, store, listed, current)
    write_manifest(store, build_manifest(product, listed, files, generated_at=now))
    store.finish(files)
    return written



def skip_unpublished_runs(product: Product, jobs: list[Job], latest: str, exists: ExistsFn) -> tuple[list[Job], list[str]]:
    """Drop the jobs of older runs whose first missing hour isn't at the source.

    One check per run (a listing for NOMADS, a HEAD elsewhere) instead of a
    failed request per hour. The latest run is complete by definition. A run
    skipped here because a check failed transiently is tried again next pass.
    """
    first: dict[str, Job] = {}
    for j in jobs:
        if j.run_id != latest and (j.run_id not in first or j.fhr < first[j.run_id].fhr):
            first[j.run_id] = j
    gone = sorted((r for r, j in first.items() if not exists(product.model.index_url_for(j.init, j.fhr))), reverse=True)
    return [j for j in jobs if j.run_id not in gone], gone


def run_job(product: Product, job: Job, fetch: FetchFn, sleep, work_dir: str) -> tuple[dict[str, bytes] | None, str | None, bool]:
    """Fetch, encode, and gzip one hour, with retries. Runs in a worker.

    An hour the source doesn't have (``NotPublished``) isn't retried.
    Returns ({field id: gzip bytes}, None, False), or (None, error message,
    whether the source doesn't have it).
    """
    shape = (product.grid.ny, product.grid.nx)
    last_err = None
    for attempt in range(product.retries):
        try:
            values = fetch(product, job.init, job.fhr, list(job.fields), Path(work_dir))
            return {fid: gzip_frame(encode_frame(product.field(fid), values[fid], shape)) for fid in job.fields}, None, False
        except Exception as e:  # noqa: BLE001 - every failure is retried, then reported
            last_err = e
            log.warning("%s f%03d attempt %d failed: %s", job.run_id, job.fhr, attempt + 1, e)
            if isinstance(e, NotPublished):
                break
            if attempt + 1 < product.retries:
                sleep(2 ** (attempt + 1))
    tries = "1 attempt (not published)" if isinstance(last_err, NotPublished) else f"{product.retries} attempts"
    return None, f"{tries}: {type(last_err).__name__}: {last_err}", isinstance(last_err, NotPublished)


def _worker_init() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    for noisy in ("urllib3", "herbie", "cfgrib"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def _executor(kind: str, workers: int) -> Executor:
    if kind == "process":
        # spawn: identical behaviour on macOS and Linux, and no fork-with-threads hazards
        return ProcessPoolExecutor(
            max_workers=workers, mp_context=multiprocessing.get_context("spawn"), initializer=_worker_init
        )
    return ThreadPoolExecutor(max_workers=workers)


def fetch_frames(product, store, jobs: list[Job], fetch, result: UpdateResult, sleep, executor="thread") -> None:
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="wxtrend-") as tmp, _executor(executor, product.workers) as pool:
        futures = {pool.submit(run_job, product, job, fetch, sleep, tmp): job for job in jobs}
        for i, fut in enumerate(as_completed(futures), 1):
            job = futures[fut]
            payloads, err, gone = fut.result()
            if payloads is not None:
                for fid, gz in payloads.items():
                    store.stage_frame(job.run_id, fid, job.fhr, gz)
                    result.fetched.append((job.run_id, job.fhr, fid))
            elif gone:
                result.gone.append((job.run_id, job.fhr, err))
                log.warning("%s f%03d isn't at the source: %s", job.run_id, job.fhr, err)
            else:
                result.failed.append((job.run_id, job.fhr, err))
                log.error("%s f%03d failed after %s", job.run_id, job.fhr, err)
            if i % 25 == 0 or i == len(jobs):
                log.info("%d/%d hours done (%.0f s)", i, len(jobs), time.monotonic() - started)
    result.fetched.sort()
    result.failed.sort()
    result.gone.sort()
