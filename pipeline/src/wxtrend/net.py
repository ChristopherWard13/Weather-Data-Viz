"""HTTP sessions that back off when a server throttles.

ECMWF's AWS bucket answered about half of all requests with ``503 SlowDown``,
even at one connection (2026-10-11; that's why ECMWF data comes from the GCS
mirror). Any source can throttle, so every request goes through a session that
retries throttling and server errors with exponential backoff and jitter (and
honours ``Retry-After``). A 404 is an answer, never retried.
"""

from __future__ import annotations

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
