"""Build ``manifest.json`` from the frames that actually exist.

The manifest lists exactly the runs and hours whose frames exist (on disk, or
in R2 when updating against it), so the frontend never requests a frame that
isn't there.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .config import Grid, Product
from .cycles import iso_z, parse_cycle_id
from .store import PATH_TEMPLATE, FrameStore, Listing, atomic_write_bytes, listed_in

SCHEMA_VERSION = 3
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


def build_manifest(product: Product, listed: Listing, generated_at: datetime | None = None) -> dict:
    """The manifest for ``listed`` frames (see ``FrameStore.listing``)."""
    generated_at = generated_at or datetime.now(timezone.utc)
    g = product.grid
    runs = []
    for run_id in sorted(listed, reverse=True):
        hours = {f.id: sorted(listed[run_id].get(f.id, [])) for f in product.fields}
        if not any(hours.values()):
            continue
        runs.append(
            {
                "id": run_id,
                "init": iso_z(parse_cycle_id(run_id)),
                "hours": hours,
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
        "path_template": PATH_TEMPLATE,
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
    """True if ``manifest`` is current-schema, matches the product's config, and lists exactly ``listed``."""
    try:
        if manifest["schema_version"] != SCHEMA_VERSION or config_drift(product, manifest):
            return False
        return listed_in(manifest) == listed
    except (KeyError, TypeError):
        return False


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())
