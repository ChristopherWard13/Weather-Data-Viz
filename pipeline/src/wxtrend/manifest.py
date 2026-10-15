"""Build ``manifest.json`` from the frames that actually exist.

The manifest lists exactly the runs and hours whose frames exist (on disk, or
in R2 when updating against it), and names the run file that holds each field
of each run (``store.py``), so the frontend never requests a frame that isn't
there.

Schema 4 (2026-10-15) replaced schema 3's file per frame with one run file per
run and field: ``path_template`` gave way to ``file_template`` and
``container``, and each run gained ``files``.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .config import Grid, Product
from .cycles import iso_z, parse_cycle_id
from .store import CONTAINER, FILE_TEMPLATE, FrameStore, Listing, RunFiles, atomic_write_bytes, files_in, listed_in

SCHEMA_VERSION = 4
SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schema" / "manifest.schema.json"


def grid_definition(grid: Grid) -> dict:
    return {
        "id": grid.id,
        "nx": grid.nx,
        "ny": grid.ny,
        "lon0": grid.lon_min,
        "lat0": grid.lat_max,
        "dlon": grid.resolution,
        "dlat": -grid.resolution,
        "row_order": "north_to_south",
        "col_order": "west_to_east",
        "lat_min": grid.lat_min,
        "lat_max": grid.lat_max,
        "lon_min": grid.lon_min,
        "lon_max": grid.lon_max,
    }


def expected_hours(product: Product, field_id: str) -> list[int]:
    f = product.field(field_id)
    return [h for h in product.fetch_hours if h >= f.min_fhr]


def build_manifest(product: Product, listed: Listing, files: RunFiles | None = None,
                   generated_at: datetime | None = None) -> dict:
    """The manifest for ``listed`` frames (see ``FrameStore.listing``), held in ``files``
    (``update.pack_runs``): the run file of every field of every run with frames."""
    generated_at = generated_at or datetime.now(timezone.utc)
    files = files or {}
    g = product.grid
    runs = []
    for run_id in sorted(listed, reverse=True):
        hours = {f.id: sorted(listed[run_id].get(f.id, [])) for f in product.fields}
        if not any(hours.values()):
            continue
        named = files.get(run_id, {})
        missing = [fid for fid, h in hours.items() if h and fid not in named]
        if missing:
            raise ValueError(f"run {run_id}: no run file for {missing}")
        runs.append(
            {
                "id": run_id,
                "init": iso_z(parse_cycle_id(run_id)),
                "hours": hours,
                "files": {fid: named[fid] for fid, h in hours.items() if h},
                "complete": all(set(expected_hours(product, fid)).issubset(h) for fid, h in hours.items()),
            }
        )
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": iso_z(generated_at),
        "product": product.id,
        "model": {"id": product.model.id, "name": product.model.name},
        "grid": grid_definition(g),
        "compression": "gzip",
        "layout": "bands_concatenated_row_major_little_endian",
        "filter": "row_delta",
        "fields": {
            f.id: {
                "label": f.label,
                "min_fhr": f.min_fhr,
                "frame_bytes": f.frame_bytes(g.nx, g.ny),
                "bands": [b.manifest() for b in f.bands],
            }
            for f in product.fields
        },
        "file_template": FILE_TEMPLATE,
        "container": CONTAINER,
        "cycle_interval_hours": product.cycle_interval_hours,
        "display_hours": product.display_hours,
        "latest": runs[0]["id"] if runs else None,
        "runs": runs,
    }


def config_drift(product: Product, manifest: dict) -> list[str]:
    """How a manifest disagrees with the product's config: its model, fields, bands, hours.

    The pipeline builds every manifest from the config, so these only differ
    for data made under an older config, such as the frozen e2e fixtures of
    NOMADS products (rebuild them with ``make e2e-fixtures``).
    """
    built = build_manifest(product, {})
    out = []
    if manifest.get("model") != built["model"]:
        out.append(f"model {manifest.get('model')} != config {built['model']}")
    if set(manifest.get("fields", {})) != set(built["fields"]):
        out.append(f"fields {sorted(manifest.get('fields', {}))} != config {sorted(built['fields'])}")
    for fid, spec in built["fields"].items():
        have = manifest.get("fields", {}).get(fid)
        if have is not None and have != spec:
            out.append(f"field {fid} is defined differently from the config (bands, label or min_fhr)")
    if manifest.get("display_hours") != built["display_hours"]:
        out.append("display_hours differ from the config")
    return out


def write_manifest(store: FrameStore, manifest: dict) -> Path:
    path = store.root / "manifest.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(manifest, indent=1) + "\n").encode()
    atomic_write_bytes(path, payload)
    return path


def read_manifest(store: FrameStore) -> dict | None:
    try:
        return json.loads((store.root / "manifest.json").read_text())
    except (OSError, ValueError):
        return None


def manifest_lists(product: Product, manifest: dict | None, listed: Listing) -> bool:
    """True if ``manifest`` is current-schema, matches the product's config, lists exactly
    ``listed``, and names a run file for every field of every run it lists."""
    try:
        if manifest["schema_version"] != SCHEMA_VERSION or config_drift(product, manifest):
            return False
        files = files_in(manifest)
        return listed_in(manifest) == listed and all(set(files.get(r, {})) == set(h) for r, h in listed.items())
    except (KeyError, TypeError):
        return False


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())
