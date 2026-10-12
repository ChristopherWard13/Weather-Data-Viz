"""One pipeline pass: find the latest complete cycle, fill the retention window,
prune old runs, and rewrite the manifest.

Against R2 (``published``), the remote manifest decides what's missing: frames
it lists count as present, and the new manifest lists them alongside the frames
fetched now. ``store.sync_to_r2`` then publishes it.
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
from .cycles import ExistsFn, cycle_id, find_latest_complete_cycle, previous_cycles
from .fetch import NotPublished
from .manifest import build_manifest, manifest_lists, read_manifest, write_manifest
from .store import FrameStore, Listing, encode_frame, gzip_frame, listed_in, merge_listings

log = logging.getLogger(__name__)

# (product, init, fhr, field ids, work dir) -> {field id: {band: physical values}}
FetchFn = Callable[[Product, datetime, int, list[str], Path], dict[str, dict[str, np.ndarray]]]


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
) -> UpdateResult:
    """``published``: the product's manifest in R2 ({} if it has none yet), or
    None to work from the local store alone."""
    hours = sorted(hours if hours is not None else product.fetch_hours)
    if latest is None:
        latest = find_latest_complete_cycle(product, now, exists, hours)
        if latest is None:
            raise NoCompleteCycle(
                f"no complete {product.id} cycle in the last {product.lookback_cycles} cycles"
            )

    targets = target_cycles(product, latest, quick)
    target_ids = [cycle_id(t) for t in targets]
    # Pruning always uses the full retention window, so a --quick pass never
    # deletes runs that a full pass fetched.
    keep_ids = {cycle_id(t) for t in target_cycles(product, latest)}
    result = UpdateResult(latest=cycle_id(latest), targets=target_ids)

    result.legacy_removed = store.remove_legacy()
    if result.legacy_removed:
        log.info("removed %d frames in the old schema-1 layout", result.legacy_removed)

    field_ids = [f.id for f in product.fields]
    remote = listed_in(published)
    jobs = missing_jobs(product, merge_listings(store.listing(field_ids), remote), targets, hours)
    jobs, result.unavailable = skip_unpublished_runs(product, jobs, result.latest, exists)
    for run_id in result.unavailable:
        log.warning("run %s is no longer at the source; skipping its missing hours", run_id)
    stale = [r for r in store.run_ids() if r not in keep_ids]

    def window() -> Listing:
        listed = merge_listings(store.listing(field_ids), remote)
        return {r: h for r, h in listed.items() if r in keep_ids}

    current = read_manifest(store) if published is None else published
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

    write_manifest(store, build_manifest(product, window(), generated_at=now))
    result.manifest_written = True
    return result


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
                    store.write_frame(job.run_id, fid, job.fhr, gz)
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
