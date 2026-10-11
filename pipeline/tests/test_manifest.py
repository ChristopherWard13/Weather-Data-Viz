import copy
import json
from datetime import datetime, timezone

import jsonschema
import pytest

from wxtrend.manifest import build_manifest, load_schema, manifest_matches_store, write_manifest
from wxtrend.store import FrameStore

from .helpers import write

NOW = datetime(2026, 10, 9, 5, 10, tzinfo=timezone.utc)


@pytest.fixture
def populated(tmp_path, product):
    store = FrameStore(tmp_path)
    for f in product.fetch_hours:
        for field in product.fields_for_hour(f):
            write(store, product, "2026100818", field.id, f)
    for f in (0, 6, 12):
        write(store, product, "2026100812", "wspd250", f)
    return store


def test_manifest_validates_against_schema(populated, product):
    jsonschema.validate(build_manifest(product, populated, generated_at=NOW), load_schema())


def test_manifest_contents(populated, product):
    m = build_manifest(product, populated, generated_at=NOW)
    assert m["schema_version"] == 3
    assert m["generated_at"] == "2026-10-09T05:10:00Z"
    assert m["product"] == "gfs"
    assert m["model"] == {"id": "gfs", "name": "GFS"}
    assert m["latest"] == "2026100818"
    assert [r["id"] for r in m["runs"]] == ["2026100818", "2026100812"]  # newest first
    newest, older = m["runs"]
    assert newest["init"] == "2026-10-08T18:00:00Z"
    assert newest["hours"]["wspd250"] == list(range(0, 289, 6))
    assert newest["hours"]["precip"] == list(range(6, 289, 6))  # no accumulation at F000
    assert newest["complete"] is True
    assert older["hours"]["wspd250"] == [0, 6, 12]
    assert older["hours"]["t2m"] == []
    assert older["complete"] is False
    assert m["display_hours"] == list(range(0, 241, 6))
    assert m["filter"] == "row_delta"


def test_field_descriptions(populated, product):
    fields = build_manifest(product, populated, generated_at=NOW)["fields"]
    assert set(fields) == {f.id for f in product.fields}
    assert fields["wspd250"]["frame_bytes"] == 106_301
    assert fields["precip"]["frame_bytes"] == 3 * 106_301
    assert fields["precip"]["min_fhr"] == 6
    assert fields["precip"]["bands"][1]["categories"][0] == "none"
    assert fields["wdir250"]["bands"][0]["wrap"] == 360
    assert fields["t2m"]["bands"][0] == {"name": "temp", "units": "F", "dtype": "uint8", "scale": 1.0, "offset": -80.0}


def test_grid_definition(populated, product):
    g = build_manifest(product, populated, generated_at=NOW)["grid"]
    assert g["id"] == "na025"
    assert (g["nx"], g["ny"]) == (481, 221)
    assert (g["lon0"], g["lat0"]) == (-170.0, 70.0)
    assert (g["dlon"], g["dlat"]) == (0.25, -0.25)
    assert g["row_order"] == "north_to_south"
    assert g["lat0"] + (g["ny"] - 1) * g["dlat"] == g["lat_min"] == 15.0
    assert g["lon0"] + (g["nx"] - 1) * g["dlon"] == g["lon_max"] == -50.0


def test_path_template_resolves_to_files(populated, product):
    m = build_manifest(product, populated, generated_at=NOW)
    for run in m["runs"]:
        for fid, hours in run["hours"].items():
            for f in hours:
                rel = (m["path_template"].replace("{run}", run["id"]).replace("{field}", fid)
                       .replace("{fhr:03d}", f"{f:03d}"))
                assert (populated.root / rel).is_file()


def test_written_manifest_roundtrips_and_matches_store(populated, product):
    m = build_manifest(product, populated, generated_at=NOW)
    assert not manifest_matches_store(product, populated)
    path = write_manifest(populated, m)
    assert json.loads(path.read_text()) == m
    assert manifest_matches_store(product, populated)
    write(populated, product, "2026100812", "t2m", 0)
    assert not manifest_matches_store(product, populated)


@pytest.mark.parametrize("version", [1, 2])
def test_older_schema_manifest_is_stale(populated, product, version):
    m = build_manifest(product, populated, generated_at=NOW)
    write_manifest(populated, {**m, "schema_version": version})
    assert not manifest_matches_store(product, populated)


def test_fields_are_the_products_fields(populated, product):
    from dataclasses import replace

    fewer = replace(product, fields=tuple(f for f in product.fields if f.id != "gust"))
    m = build_manifest(fewer, populated, generated_at=NOW)
    assert "gust" not in m["fields"] and "gust" not in m["runs"][0]["hours"]
    jsonschema.validate(m, load_schema())


def test_nodata_bands_validate(populated, product):
    m = build_manifest(product, populated, generated_at=NOW)
    m["fields"]["t2m"]["bands"][0]["nodata"] = 255
    m["fields"]["mslp"]["bands"][0]["nodata"] = 65535
    jsonschema.validate(m, load_schema())


def test_empty_store(tmp_path, product):
    m = build_manifest(product, FrameStore(tmp_path), generated_at=NOW)
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
        lambda m: m["runs"][0]["hours"].update(wspd250=[0, 0]),
        lambda m: m["fields"]["t2m"]["bands"][0].update(dtype="float32"),
        lambda m: m["fields"]["t2m"].pop("frame_bytes"),
        lambda m: m.update(filter="none"),
        lambda m: m.update(extra=True),
        lambda m: m.update(schema_version=2),
        lambda m: m.pop("product"),
        lambda m: m.update(product="GFS"),
        lambda m: m["model"].pop("name"),
        lambda m: m["grid"].pop("id"),
        lambda m: m["fields"]["t2m"]["bands"][0].update(nodata=254),
        lambda m: m["fields"]["mslp"]["bands"][0].update(nodata=255),
    ],
)
def test_schema_rejects_malformed(populated, product, mutate):
    m = copy.deepcopy(build_manifest(product, populated, generated_at=NOW))
    mutate(m)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(m, load_schema())
