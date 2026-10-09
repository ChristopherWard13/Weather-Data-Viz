"""Cycle arithmetic and detection of the latest complete GFS cycle on AWS."""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import requests
from requests.adapters import HTTPAdapter

from .config import Config

log = logging.getLogger(__name__)

ExistsFn = Callable[[str], bool]

HEAD_WORKERS = 16


def cycle_id(init: datetime) -> str:
    return init.astimezone(timezone.utc).strftime("%Y%m%d%H")


def parse_cycle_id(run_id: str) -> datetime:
    if len(run_id) != 10 or not run_id.isdigit():
        raise ValueError(f"cycle id must be YYYYMMDDHH, got {run_id!r}")
    return datetime.strptime(run_id, "%Y%m%d%H").replace(tzinfo=timezone.utc)


def iso_z(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def floor_cycle(now: datetime, interval_hours: int) -> datetime:
    now = now.astimezone(timezone.utc)
    hour = now.hour - now.hour % interval_hours
    return now.replace(hour=hour, minute=0, second=0, microsecond=0)


def previous_cycles(latest: datetime, count: int, interval_hours: int) -> list[datetime]:
    """``count`` cycles ending at ``latest``, newest first."""
    return [latest - timedelta(hours=interval_hours * i) for i in range(count)]


def idx_url(cfg: Config, init: datetime, fhr: int) -> str:
    hh = f"{init:%H}"
    return (
        f"{cfg.bucket_url}/{cfg.model}.{init:%Y%m%d}/{hh}/atmos/"
        f"{cfg.model}.t{hh}z.{cfg.product}.f{fhr:03d}.idx"
    )


def http_exists_fn(timeout: float = 15.0) -> ExistsFn:
    session = requests.Session()
    session.mount("https://", HTTPAdapter(pool_maxsize=HEAD_WORKERS))

    def exists(url: str) -> bool:
        try:
            r = session.head(url, timeout=timeout, allow_redirects=True)
        except requests.RequestException as e:
            log.warning("HEAD %s failed: %s", url, e)
            return False
        return r.status_code == 200

    return exists


def cycle_is_complete(cfg: Config, init: datetime, hours: Iterable[int], exists: ExistsFn) -> bool:
    """True if every needed forecast hour's index file is published.

    The last hour is checked first: GFS posts hours in order, so for a
    cycle still in progress that one check usually settles it.
    """
    hours = sorted(hours)
    if not exists(idx_url(cfg, init, hours[-1])):
        return False
    with ThreadPoolExecutor(max_workers=HEAD_WORKERS) as pool:
        return all(pool.map(lambda f: exists(idx_url(cfg, init, f)), hours[:-1]))


def find_latest_complete_cycle(
    cfg: Config,
    now: datetime,
    exists: ExistsFn,
    hours: Iterable[int] | None = None,
) -> datetime | None:
    hours = list(hours if hours is not None else cfg.fetch_hours)
    start = floor_cycle(now, cfg.cycle_interval_hours)
    for init in previous_cycles(start, cfg.lookback_cycles + 1, cfg.cycle_interval_hours):
        if cycle_is_complete(cfg, init, hours, exists):
            log.info("latest complete cycle: %s", cycle_id(init))
            return init
        log.info("cycle %s not complete yet", cycle_id(init))
    return None
