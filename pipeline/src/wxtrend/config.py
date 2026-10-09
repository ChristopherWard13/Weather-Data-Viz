"""Load and validate the shared ``config.json`` at the repository root.

The same file is bundled into the frontend, so every tunable lives in one place.
Derived quantities (retention window, fetch range) are computed here rather than
stored, so they can never disagree with the lags they come from.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONFIG_PATH = REPO_ROOT / "config.json"


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Domain:
    lat_min: float
    lat_max: float
    lon_min: float
    lon_max: float
    resolution: float

    @property
    def nx(self) -> int:
        return _steps(self.lon_max - self.lon_min, self.resolution) + 1

    @property
    def ny(self) -> int:
        return _steps(self.lat_max - self.lat_min, self.resolution) + 1


@dataclass(frozen=True)
class Config:
    model: str
    product: str
    source: str
    bucket_url: str
    cycle_interval_hours: int
    level_label: str
    search: str
    domain: Domain
    fhr_min: int
    fhr_max: int
    fhr_step: int
    lags: tuple[int, ...]
    default_lag: int
    lookback_cycles: int
    concurrency: int
    retries: int

    @property
    def max_lag(self) -> int:
        return max(self.lags)

    @property
    def retained_runs(self) -> int:
        """Current run plus enough older runs to reach the longest lag."""
        return 1 + self.max_lag // self.cycle_interval_hours

    @property
    def display_hours(self) -> list[int]:
        return list(range(self.fhr_min, self.fhr_max + 1, self.fhr_step))

    @property
    def fetch_hours(self) -> list[int]:
        """Hours each run must provide.

        A run is shown as "current" for ``fhr_min..fhr_max`` and used as the
        older comparison run at ``f + L``, so it needs hours out to
        ``fhr_max + max_lag``.
        """
        return list(range(self.fhr_min, self.fhr_max + self.max_lag + 1, self.fhr_step))


def _steps(span: float, res: float) -> int:
    n = span / res
    if abs(n - round(n)) > 1e-6:
        raise ConfigError(f"span {span} is not a multiple of resolution {res}")
    return int(round(n))


def load_config(path: str | os.PathLike | None = None) -> Config:
    path = Path(path or os.environ.get("WXTREND_CONFIG") or DEFAULT_CONFIG_PATH)
    with open(path) as f:
        raw = json.load(f)
    return parse_config(raw)


def parse_config(raw: dict) -> Config:
    try:
        m = raw["model"]
        d = raw["domain"]
        fh = raw["forecast_hours"]
        p = raw["pipeline"]
        cfg = Config(
            model=m["name"],
            product=m["product"],
            source=m["source"],
            bucket_url=m["bucket_url"].rstrip("/"),
            cycle_interval_hours=int(m["cycle_interval_hours"]),
            level_label=m["level_label"],
            search=m["search"],
            domain=Domain(
                lat_min=float(d["lat_min"]),
                lat_max=float(d["lat_max"]),
                lon_min=float(d["lon_min"]),
                lon_max=float(d["lon_max"]),
                resolution=float(d["resolution_deg"]),
            ),
            fhr_min=int(fh["min"]),
            fhr_max=int(fh["max"]),
            fhr_step=int(fh["step"]),
            lags=tuple(sorted(int(x) for x in raw["lags_hours"])),
            default_lag=int(raw["default_lag_hours"]),
            lookback_cycles=int(p["lookback_cycles"]),
            concurrency=int(p["concurrency"]),
            retries=int(p["retries"]),
        )
    except KeyError as e:
        raise ConfigError(f"missing config key: {e}") from e
    _validate(cfg)
    return cfg


def _validate(cfg: Config) -> None:
    dom = cfg.domain
    if not (-90 <= dom.lat_min < dom.lat_max <= 90):
        raise ConfigError("domain latitudes must satisfy -90 <= lat_min < lat_max <= 90")
    if not (dom.lon_min < dom.lon_max and dom.lon_max - dom.lon_min < 360):
        raise ConfigError("domain longitudes must satisfy lon_min < lon_max, span < 360")
    dom.nx, dom.ny  # raises if not on the resolution grid
    if not cfg.lags:
        raise ConfigError("lags_hours must not be empty")
    if cfg.default_lag not in cfg.lags:
        raise ConfigError("default_lag_hours must be one of lags_hours")
    if cfg.fhr_step <= 0 or (cfg.fhr_max - cfg.fhr_min) % cfg.fhr_step:
        raise ConfigError("forecast_hours max-min must be a multiple of step")
    for lag in cfg.lags:
        if lag <= 0 or lag % cfg.cycle_interval_hours or lag % cfg.fhr_step:
            raise ConfigError(
                f"lag {lag} must be positive and a multiple of both the cycle "
                f"interval ({cfg.cycle_interval_hours} h) and the forecast-hour "
                f"step ({cfg.fhr_step} h)"
            )
