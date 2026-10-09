import copy
import json
from datetime import timezone, datetime

import jsonschema
import numpy as np
import pytest

from wxtrend.manifest import build_manifest, load_schema, write_manifest
from wxtrend.store import FrameStore

NOW = datetime(2026, 10, 9, 5, 10, tzinfo=timezone.utc)


@pytest.fixture
def populated(tmp_path, cfg):
    store = FrameStore(tmp_path)
    frame = np.zeros((cfg.domain.ny, cfg.domain.nx), np.uint8)
    for f in cfg.fetch_hours:
        store.write_frame("2026100818", f, frame)
    for f in (0, 6, 12):
        store.write_frame("2026100812", f, frame)
    return store


def test_manifest_validates_against_schema(populated, cfg):
    m = build_manifest(cfg, populated, generated_at=NOW)
    jsonschema.validate(m, load_schema())


def test_manifest_contents(populated, cfg):
    m = build_manifest(cfg, populated, generated_at=NOW)
    assert m["generated_at"] == "2026-10-09T05:10:00Z"
    assert m["latest"] == "2026100818"
    assert [r["id"] for r in m["runs"]] == ["2026100818", "2026100812"]  # newest first
    newest, older = m["runs"]
    assert newest["init"] == "2026-10-08T18:00:00Z"
    assert newest["hours"] == list(range(0, 289, 6))
    assert newest["complete"] is True
    assert older["hours"] == [0, 6, 12]
    assert older["complete"] is False
    assert m["display_hours"] == list(range(0, 241, 6))


def test_grid_definition(populated, cfg):
    g = build_manifest(cfg, populated, generated_at=NOW)["grid"]
    assert (g["nx"], g["ny"]) == (481, 221)
    assert (g["lon0"], g["lat0"]) == (-170.0, 70.0)
    assert (g["dlon"], g["dlat"]) == (0.25, -0.25)
    assert g["row_order"] == "north_to_south"
    # The last row/column land exactly on the domain edges
    assert g["lat0"] + (g["ny"] - 1) * g["dlat"] == g["lat_min"] == 15.0
    assert g["lon0"] + (g["nx"] - 1) * g["dlon"] == g["lon_max"] == -50.0


def test_path_template_resolves_to_files(populated, cfg):
    m = build_manifest(cfg, populated, generated_at=NOW)
    for run in m["runs"]:
        for f in run["hours"]:
            rel = m["path_template"].replace("{run}", run["id"]).replace("{fhr:03d}", f"{f:03d}")
            assert (populated.root / rel).is_file()
    assert m["encoding"]["frame_bytes"] == 481 * 221


def test_written_manifest_roundtrips(populated, cfg):
    m = build_manifest(cfg, populated, generated_at=NOW)
    path = write_manifest(populated, m)
    assert json.loads(path.read_text()) == m


def test_empty_store(tmp_path, cfg):
    m = build_manifest(cfg, FrameStore(tmp_path), generated_at=NOW)
    jsonschema.validate(m, load_schema())
    assert m["latest"] is None and m["runs"] == []


@pytest.mark.parametrize(
    "mutate",
    [
        lambda m: m.pop("grid"),
        lambda m: m["grid"].update(row_order="south_to_north"),
        lambda m: m["grid"].update(dlat=0.25),
        lambda m: m["runs"][0].update(id="20261008"),
        lambda m: m["runs"][0].update(init="2026-10-08 18:00"),
        lambda m: m["encoding"].update(dtype="uint16"),
        lambda m: m.update(extra=True),
    ],
)
def test_schema_rejects_malformed(populated, cfg, mutate):
    m = copy.deepcopy(build_manifest(cfg, populated, generated_at=NOW))
    mutate(m)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(m, load_schema())
