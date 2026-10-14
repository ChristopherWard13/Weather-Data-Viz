"""Cycle arithmetic and detection of a product's latest complete cycle."""

from __future__ import annotations

import logging
import re
import threading
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import requests

from .config import FILE_ADAPTERS, Product
from .net import paced_session, retrying_session

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


def idx_url(product: Product, init: datetime, fhr: int) -> str:
    return product.model.index_url_for(init, fhr)


def idx_urls(product: Product, init: datetime, fhr: int) -> list[str]:
    """Every file whose existence says the hour is posted: its indexes, or, for per-file
    sources (no index), every file the hour's fields read at that hour."""
    if product.model.adapter in FILE_ADAPTERS:
        from .catalog import needs_for

        fields = [f.id for f in product.fields_for_hour(fhr)]
        names = sorted({n.var for n in needs_for(product.model.id, fields, fhr) if n.offset == 0})
        return [product.model.var_url_for(v, init, fhr) for v in names]
    return product.model.index_urls_for(init, fhr)


def head_workers(product: Product) -> int:
    """Concurrent HEADs: the model's connection cap, if it has one."""
    return min(HEAD_WORKERS, product.model.max_connections or HEAD_WORKERS)


def http_exists_fn(timeout: float = 15.0) -> ExistsFn:
    session = retrying_session(HEAD_WORKERS)

    def exists(url: str) -> bool:
        try:
            r = session.head(url, timeout=timeout, allow_redirects=True)
        except requests.RequestException as e:
            log.warning("HEAD %s failed: %s", url, e)
            return False
        return r.status_code == 200

    return exists


_HREF = re.compile(r'href="([^"?/]+)"', re.IGNORECASE)


def listing_exists_fn(requests_per_minute: int, timeout: float = 30.0) -> ExistsFn:
    """An ``exists`` that reads each directory's listing once, instead of a HEAD per file.

    NOMADS rate-limits by requests, and a cycle's completeness check would
    otherwise be one HEAD per hour and file (130 for AIGFS). GDPS and ICON put
    one file per variable in each directory (an hour's, or a variable's), so a
    listing covers 17 files or a run's hours. Listings are cached for the life
    of the function, so make a new one for each check.
    """
    session = paced_session(requests_per_minute)
    listings: dict[str, frozenset[str]] = {}
    lock = threading.Lock()

    def exists(url: str) -> bool:
        directory, name = url.rsplit("/", 1)
        with lock:  # one listing per directory, even when hours are checked in parallel
            if directory not in listings:
                try:
                    r = session.get(directory + "/", timeout=timeout)
                    listings[directory] = frozenset(_HREF.findall(r.text)) if r.status_code == 200 else frozenset()
                except requests.RequestException as e:
                    log.warning("listing %s/ failed: %s", directory, e)
                    return False
            return name in listings[directory]

    return exists


def exists_fn_for(product: Product) -> ExistsFn:
    """How to check whether a product's index files are posted."""
    if product.model.adapter == "nomads":
        return listing_exists_fn(product.model.requests_per_minute or 60)
    if product.model.adapter in FILE_ADAPTERS:
        # MSC and DWD publish no request limit: listings are spaced a tenth of a second apart
        return listing_exists_fn(product.model.requests_per_minute or 600)
    return http_exists_fn()


def cycle_is_complete(product: Product, init: datetime, hours: Iterable[int], exists: ExistsFn) -> bool:
    """True if every needed forecast hour's index files are published.

    The last hour is checked first: models post hours roughly in order, so
    for a cycle still in progress that one check usually settles it.
    """
    hours = sorted(hours)
    last = idx_urls(product, init, hours[-1])
    if not all(exists(u) for u in last):
        return False
    # Each index once: the ECMWF ensemble's hours share two mean files
    urls = [u for u in dict.fromkeys(u for f in hours[:-1] for u in idx_urls(product, init, f)) if u not in last]
    with ThreadPoolExecutor(max_workers=head_workers(product)) as pool:
        return all(pool.map(exists, urls))


def find_latest_complete_cycle(
    product: Product,
    now: datetime,
    exists: ExistsFn,
    hours: Iterable[int] | None = None,
) -> datetime | None:
    hours = list(hours if hours is not None else product.fetch_hours)
    start = floor_cycle(now, product.cycle_interval_hours)
    for init in previous_cycles(start, product.lookback_cycles + 1, product.cycle_interval_hours):
        if cycle_is_complete(product, init, hours, exists):
            log.info("latest complete cycle: %s", cycle_id(init))
            return init
        log.info("cycle %s not complete yet", cycle_id(init))
    return None
