"""One pipeline pass: find the latest complete cycle, fill the retention window,
prune old runs, and rewrite the manifest."""

from __future__ import annotations

import logging
import tempfile
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from .config import Config
from .cycles import ExistsFn, cycle_id, find_latest_complete_cycle, previous_cycles
from .manifest import build_manifest, manifest_matches_store, write_manifest
from .store import FrameStore

log = logging.getLogger(__name__)

FetchFn = Callable[[Config, datetime, int, Path], np.ndarray]


class NoCompleteCycle(RuntimeError):
    pass


@dataclass
class UpdateResult:
    latest: str
    targets: list[str]
    fetched: list[tuple[str, int]] = field(default_factory=list)
    failed: list[tuple[str, int, str]] = field(default_factory=list)
    pruned: list[str] = field(default_factory=list)
    manifest_written: bool = False

    @property
    def changed(self) -> bool:
        return bool(self.fetched or self.pruned or self.manifest_written)


def target_cycles(cfg: Config, latest: datetime, quick: bool = False) -> list[datetime]:
    """Runs to keep, newest first.

    Normally the full retention window (latest plus older runs back to the
    longest lag). ``quick`` keeps only the runs the latest run is compared
    against, which is enough to view every lag for the newest run.
    """
    if quick:
        return [latest] + [latest - timedelta(hours=lag) for lag in cfg.lags]
    return previous_cycles(latest, cfg.retained_runs, cfg.cycle_interval_hours)


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

    jobs = []
    for init, run_id in zip(targets, target_ids):
        have = set(store.hours(run_id))
        jobs += [(init, run_id, f) for f in hours if f not in have]
    stale = [r for r in store.run_ids() if r not in keep_ids]
    manifest_stale = not manifest_matches_store(store)

    if not jobs and not stale and not manifest_stale:
        log.info("no-op: %s and its retention window are already processed", result.latest)
        return result

    if jobs:
        log.info("fetching %d frames across %d runs", len(jobs), len({j[1] for j in jobs}))
        fetch_frames(cfg, store, jobs, fetch, result, sleep)

    result.pruned = store.prune(keep_ids)
    for run_id in result.pruned:
        log.info("pruned run %s", run_id)

    write_manifest(store, build_manifest(cfg, store, generated_at=now))
    result.manifest_written = True
    return result


def fetch_frames(cfg, store, jobs, fetch, result, sleep) -> None:
    def work(init: datetime, run_id: str, fhr: int, work_dir: Path):
        last_err = None
        for attempt in range(cfg.retries):
            try:
                frame = fetch(cfg, init, fhr, work_dir)
                store.write_frame(run_id, fhr, frame)
                return None
            except Exception as e:  # noqa: BLE001 - every failure is retried, then reported
                last_err = e
                log.warning("%s f%03d attempt %d failed: %s", run_id, fhr, attempt + 1, e)
                if attempt + 1 < cfg.retries:
                    sleep(2 ** (attempt + 1))
        return f"{type(last_err).__name__}: {last_err}"

    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="wxtrend-") as tmp:
        with ThreadPoolExecutor(max_workers=cfg.concurrency) as pool:
            futures = {pool.submit(work, init, rid, f, Path(tmp)): (rid, f) for init, rid, f in jobs}
            for i, fut in enumerate(as_completed(futures), 1):
                rid, f = futures[fut]
                err = fut.result()
                if err is None:
                    result.fetched.append((rid, f))
                else:
                    result.failed.append((rid, f, err))
                    log.error("%s f%03d failed after %d attempts: %s", rid, f, cfg.retries, err)
                if i % 25 == 0 or i == len(jobs):
                    log.info("%d/%d frames done (%.0f s)", i, len(jobs), time.monotonic() - started)
    result.fetched.sort()
    result.failed.sort()
