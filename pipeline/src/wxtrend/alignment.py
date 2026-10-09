"""Valid-time alignment between the current run and an older run.

For a current run initialized at T0 viewed at forecast hour f, the valid time is
T0 + f. The comparison is the run initialized at T0 - L at forecast hour f + L,
which is valid at the same instant. The frontend implements the same rule in
``web/src/alignment.ts``; both are checked against ``shared/test-vectors``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone


@dataclass(frozen=True)
class FramePair:
    valid: datetime
    current_init: datetime
    current_fhr: int
    older_init: datetime
    older_fhr: int


def _require_utc(t: datetime) -> None:
    if t.tzinfo is None or t.utcoffset() != timedelta(0):
        raise ValueError(f"expected a UTC-aware datetime, got {t!r}")


def valid_time(init: datetime, fhr: int) -> datetime:
    _require_utc(init)
    return init + timedelta(hours=fhr)


def comparison_frame(init: datetime, fhr: int, lag: int) -> tuple[datetime, int]:
    """Return (older_init, older_fhr) for the frame valid at ``init + fhr``."""
    _require_utc(init)
    if lag <= 0:
        raise ValueError("lag must be positive")
    if fhr < 0:
        raise ValueError("forecast hour must be non-negative")
    return init - timedelta(hours=lag), fhr + lag


def pair(init: datetime, fhr: int, lag: int) -> FramePair:
    older_init, older_fhr = comparison_frame(init, fhr, lag)
    pair = FramePair(
        valid=valid_time(init, fhr),
        current_init=init,
        current_fhr=fhr,
        older_init=older_init,
        older_fhr=older_fhr,
    )
    assert valid_time(older_init, older_fhr) == pair.valid
    return pair


def utc(year: int, month: int, day: int, hour: int = 0) -> datetime:
    return datetime(year, month, day, hour, tzinfo=timezone.utc)
