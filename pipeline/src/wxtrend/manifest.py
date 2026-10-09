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

SCHEMA_VERSION = 2
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


def expected_hours(cfg: Config, field_id: str) -> list[int]:
    f = cfg.field(field_id)
    return [h for h in cfg.fetch_hours if h >= f.min_fhr]


def build_manifest(cfg: Config, store: FrameStore, generated_at: datetime | None = None) -> dict:
    generated_at = generated_at or datetime.now(timezone.utc)
    d = cfg.domain
    runs = []
    for run_id in store.run_ids():
        hours = {f.id: store.hours(run_id, f.id) for f in cfg.fields}
        if not any(hours.values()):
            continue
        runs.append(
            {
                "id": run_id,
                "init": iso_z(parse_cycle_id(run_id)),
                "hours": hours,
                "complete": all(set(expected_hours(cfg, fid)).issubset(h) for fid, h in hours.items()),
            }
        )
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": iso_z(generated_at),
        "model": {"name": cfg.model, "product": cfg.product},
        "grid": grid_definition(cfg),
        "compression": "gzip",
        "layout": "bands_concatenated_row_major_little_endian",
        "filter": "row_delta",
        "fields": {
            f.id: {
                "label": f.label,
                "min_fhr": f.min_fhr,
                "frame_bytes": f.frame_bytes(d.nx, d.ny),
                "bands": [b.manifest() for b in f.bands],
            }
            for f in cfg.fields
        },
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


def manifest_matches_store(cfg: Config, store: FrameStore) -> bool:
    """True if manifest.json is current-schema and lists exactly what is on disk."""
    path = store.root / "manifest.json"
    try:
        m = json.loads(path.read_text())
        if m.get("schema_version") != SCHEMA_VERSION or set(m["fields"]) != {f.id for f in cfg.fields}:
            return False
        listed = {r["id"]: r["hours"] for r in m["runs"]}
    except (OSError, ValueError, KeyError, TypeError):
        return False
    on_disk = {}
    for rid in store.run_ids():
        hours = {f.id: store.hours(rid, f.id) for f in cfg.fields}
        if any(hours.values()):
            on_disk[rid] = hours
    return listed == on_disk


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())
