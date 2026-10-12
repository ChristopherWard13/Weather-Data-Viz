"""HTTP sessions that back off when a server throttles.

ECMWF's AWS bucket answered about half of all requests with ``503 SlowDown``,
even at one connection (2026-10-11; that's why ECMWF data comes from the GCS
mirror). Any source can throttle, so every request goes through a session that
retries throttling and server errors with exponential backoff and jitter (and
honours ``Retry-After``). A 404 is an answer, never retried.

NOMADS also limits each IP to a number of requests per minute (120 in NCEP's
2021 policy) and blocks IPs that exceed it, so its sessions are also *paced*:
``PacedSession`` spaces requests evenly to stay inside a budget.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

RETRY_STATUSES = (429, 500, 502, 503, 504)


def retrying_session(pool_size: int = 16, attempts: int = 8, backoff: float = 1.0) -> requests.Session:
    """A session whose GETs and HEADs retry throttling (waits about 1, 2, 4, ... s, at most 60 s)."""
    retry = Retry(
        total=attempts,
        connect=attempts,
        read=attempts,
        status=attempts,
        backoff_factor=backoff,
        backoff_max=60,
        backoff_jitter=backoff,
        status_forcelist=RETRY_STATUSES,
        allowed_methods=frozenset({"GET", "HEAD"}),
        respect_retry_after_header=True,
        raise_on_status=False,  # the last response is returned; callers check its status
    )
    session = requests.Session()
    adapter = HTTPAdapter(max_retries=retry, pool_connections=pool_size, pool_maxsize=pool_size)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


class PacedSession:
    """A session whose requests start at least ``interval`` seconds apart, across threads.

    Each worker process paces its own requests, so a product's budget of R
    requests a minute over W workers gives each worker ``interval = 60 W / R``.
    Retries inside the session (on 429 or 5xx) aren't paced, but they back off
    by at least a second.
    """

    def __init__(self, session: requests.Session, interval: float,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep):
        self.session = session
        self.interval = interval
        self._clock, self._sleep = clock, sleep
        self._next = 0.0
        self._lock = threading.Lock()

    def _wait(self) -> None:
        with self._lock:
            now = self._clock()
            start = max(now, self._next)
            self._next = start + self.interval
        if start > now:
            self._sleep(start - now)

    def get(self, url, **kwargs) -> requests.Response:
        self._wait()
        return self.session.get(url, **kwargs)

    def head(self, url, **kwargs) -> requests.Response:
        self._wait()
        return self.session.head(url, **kwargs)


def paced_session(requests_per_minute: int, workers: int = 1, pool_size: int = 4) -> PacedSession:
    """A retrying session for one of ``workers`` processes sharing a budget of ``requests_per_minute``."""
    return PacedSession(retrying_session(pool_size), 60.0 * workers / requests_per_minute)
