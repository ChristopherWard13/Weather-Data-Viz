"""One pipeline pass: find the latest complete cycle, fill the retention window,
prune old runs, and rewrite the manifest."""

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

from .config import Config
from .cycles import ExistsFn, cycle_id, find_latest_complete_cycle, previous_cycles
from .manifest import build_manifest, manifest_matches_store, write_manifest
from .store import FrameStore, encode_frame, gzip_frame

log = logging.getLogger(__name__)

# (cfg, init, fhr, field ids, work dir) -> {field id: {band: physical values}}
FetchFn = Callable[[Config, datetime, int, list[str], Path], dict[str, dict[str, np.ndarray]]]


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
    pruned: list[str] = field(default_factory=list)
    legacy_removed: int = 0
    manifest_written: bool = False

    @property
    def changed(self) -> bool:
        return bool(self.fetched or self.pruned or self.legacy_removed or self.manifest_written)


def target_cycles(cfg: Config, latest: datetime, quick: bool = False) -> list[datetime]:
    """Runs to keep, newest first.

    Normally the full retention window (latest plus older runs back to the
    longest lag). ``quick`` keeps only the runs the latest run is compared
    against, which is enough to view every lag for the newest run.
    """
    if quick:
        return [latest] + [latest - timedelta(hours=lag) for lag in cfg.lags]
    return previous_cycles(latest, cfg.retained_runs, cfg.cycle_interval_hours)


def missing_jobs(cfg: Config, store: FrameStore, targets: list[datetime], hours: list[int],
                 field_ids: list[str] | None = None) -> list[Job]:
    jobs = []
    for init in targets:
        run_id = cycle_id(init)
        have = {f.id: set(store.hours(run_id, f.id)) for f in cfg.fields}
        for fhr in hours:
            need = tuple(
                f.id for f in cfg.fields_for_hour(fhr)
                if (field_ids is None or f.id in field_ids) and fhr not in have[f.id]
            )
            if need:
                jobs.append(Job(init, run_id, fhr, need))
    return jobs


def run_update(
    cfg: Config,
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
) -> UpdateResult:
    hours = sorted(hours if hours is not None else cfg.fetch_hours)
    if latest is None:
        latest = find_latest_complete_cycle(cfg, now, exists, hours)
        if latest is None:
            raise NoCompleteCycle(
                f"no complete {cfg.model} cycle in the last {cfg.lookback_cycles} cycles"
            )

    targets = target_cycles(cfg, latest, quick)
    target_ids = [cycle_id(t) for t in targets]
    # Pruning always uses the full retention window, so a --quick pass never
    # deletes runs that a full pass fetched.
    keep_ids = {cycle_id(t) for t in target_cycles(cfg, latest)}
    result = UpdateResult(latest=cycle_id(latest), targets=target_ids)

    result.legacy_removed = store.remove_legacy()
    if result.legacy_removed:
        log.info("removed %d frames in the old schema-1 layout", result.legacy_removed)

    jobs = missing_jobs(cfg, store, targets, hours)
    stale = [r for r in store.run_ids() if r not in keep_ids]

    if not jobs and not stale and manifest_matches_store(cfg, store):
        log.info("no-op: %s and its retention window are already processed", result.latest)
        return result

    if jobs:
        n_frames = sum(len(j.fields) for j in jobs)
        log.info("fetching %d hours (%d frames) across %d runs", len(jobs), n_frames, len({j.run_id for j in jobs}))
        fetch_frames(cfg, store, jobs, fetch, result, sleep, executor)

    result.pruned = store.prune(keep_ids)
    for run_id in result.pruned:
        log.info("pruned run %s", run_id)

    write_manifest(store, build_manifest(cfg, store, generated_at=now))
    result.manifest_written = True
    return result


def run_job(cfg: Config, job: Job, fetch: FetchFn, sleep, work_dir: str) -> tuple[dict[str, bytes] | None, str | None]:
    """Fetch, encode, and gzip one hour, with retries. Runs in a worker.

    Returns ({field id: gzip bytes}, None) or (None, error message).
    """
    shape = (cfg.domain.ny, cfg.domain.nx)
    last_err = None
    for attempt in range(cfg.retries):
        try:
            values = fetch(cfg, job.init, job.fhr, list(job.fields), Path(work_dir))
            return {fid: gzip_frame(encode_frame(cfg.field(fid), values[fid], shape)) for fid in job.fields}, None
        except Exception as e:  # noqa: BLE001 - every failure is retried, then reported
            last_err = e
            log.warning("%s f%03d attempt %d failed: %s", job.run_id, job.fhr, attempt + 1, e)
            if attempt + 1 < cfg.retries:
                sleep(2 ** (attempt + 1))
    return None, f"{type(last_err).__name__}: {last_err}"


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


def fetch_frames(cfg, store, jobs: list[Job], fetch, result: UpdateResult, sleep, executor="thread") -> None:
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="wxtrend-") as tmp, _executor(executor, cfg.workers) as pool:
        futures = {pool.submit(run_job, cfg, job, fetch, sleep, tmp): job for job in jobs}
        for i, fut in enumerate(as_completed(futures), 1):
            job = futures[fut]
            payloads, err = fut.result()
            if payloads is not None:
                for fid, gz in payloads.items():
                    store.write_frame(job.run_id, fid, job.fhr, gz)
                    result.fetched.append((job.run_id, job.fhr, fid))
            else:
                result.failed.append((job.run_id, job.fhr, err))
                log.error("%s f%03d failed after %d attempts: %s", job.run_id, job.fhr, cfg.retries, err)
            if i % 25 == 0 or i == len(jobs):
                log.info("%d/%d hours done (%.0f s)", i, len(jobs), time.monotonic() - started)
    result.fetched.sort()
    result.failed.sort()
