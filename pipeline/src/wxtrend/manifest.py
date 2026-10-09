"""Build ``manifest.json`` from what is actually on disk.

The frame store is the source of truth: the manifest lists exactly the runs and
hours whose files exist, so the frontend never requests a frame that isn't there.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .config import Config
from .cycles import iso_z, parse_cycle_id
from .store import PATH_TEMPLATE, FrameStore, atomic_write_bytes

SCHEMA_VERSION = 1
SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schema" / "manifest.schema.json"


def grid_definition(cfg: Config) -> dict:
    d = cfg.domain
    return {
        "nx": d.nx,
        "ny": d.ny,
        "lon0": d.lon_min,
        "lat0": d.lat_max,
        "dlon": d.resolution,
        "dlat": -d.resolution,
        "row_order": "north_to_south",
        "col_order": "west_to_east",
        "lat_min": d.lat_min,
        "lat_max": d.lat_max,
        "lon_min": d.lon_min,
        "lon_max": d.lon_max,
    }


def build_manifest(cfg: Config, store: FrameStore, generated_at: datetime | None = None) -> dict:
    generated_at = generated_at or datetime.now(timezone.utc)
    expected = set(cfg.fetch_hours)
    runs = []
    for run_id in store.run_ids():
        hours = store.hours(run_id)
        if not hours:
            continue
        runs.append(
            {
                "id": run_id,
                "init": iso_z(parse_cycle_id(run_id)),
                "hours": hours,
                "complete": expected.issubset(hours),
            }
        )
    d = cfg.domain
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": iso_z(generated_at),
        "model": {
            "name": cfg.model,
            "product": cfg.product,
            "level": cfg.level_label,
            "field": "wind speed",
        },
        "encoding": {
            "dtype": "uint8",
            "units": "kt",
            "scale": 1.0,
            "offset": 0.0,
            "valid_min": 0,
            "valid_max": 255,
            "rounding": "nearest",
            "compression": "gzip",
            "layout": "row_major",
            "frame_bytes": d.nx * d.ny,
        },
        "grid": grid_definition(cfg),
        "path_template": PATH_TEMPLATE,
        "cycle_interval_hours": cfg.cycle_interval_hours,
        "display_hours": cfg.display_hours,
        "latest": runs[0]["id"] if runs else None,
        "runs": runs,
    }


def write_manifest(store: FrameStore, manifest: dict) -> Path:
    path = store.root / "manifest.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(manifest, indent=1) + "\n").encode()
    atomic_write_bytes(path, payload)
    return path


def manifest_matches_store(store: FrameStore) -> bool:
    """True if manifest.json exists and lists exactly the runs/hours on disk."""
    path = store.root / "manifest.json"
    try:
        listed = {r["id"]: r["hours"] for r in json.loads(path.read_text())["runs"]}
    except (OSError, ValueError, KeyError, TypeError):
        return False
    on_disk = {rid: store.hours(rid) for rid in store.run_ids()}
    return listed == {rid: h for rid, h in on_disk.items() if h}


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())
