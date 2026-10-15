import hashlib
import json

import numpy as np
import pytest

from wxtrend.config import Band, FieldSpec
from wxtrend.fields import decode_band
from wxtrend.store import (
    HEADER_PROBE,
    FrameStore,
    decode_frame,
    encode_frame,
    gzip_frame,
    header_length,
    pack_frames,
    read_index,
    row_delta,
    row_undelta,
    run_file_name,
    unpack_frames,
)

SHAPE = (221, 481)
SPEED = FieldSpec("wspd250", "speed", "x", 0, (Band("speed", "kt", "uint8", 1.0, 0.0),))
PRECIP = FieldSpec(
    "precip", "precip", "x", 6,
    (Band("qpf", "in", "uint16", 0.01, 0.0), Band("ptype", "category", "uint8", 1.0, 0.0)),
)


def rand(shape=SHAPE, hi=256, seed=0):
    return np.random.default_rng(seed).integers(0, hi, shape).astype(np.float64)


def test_row_delta_roundtrip_including_wraparound():
    q = np.array([[0, 255, 1, 128], [7, 7, 7, 0]], dtype=np.uint8)
    d = row_delta(q, 8)
    assert d.tolist() == [[0, 255, 2, 127], [7, 0, 0, 249]]
    assert row_undelta(d, 8).tolist() == q.tolist()
    q16 = np.array([[10132, 0, 65535]], dtype=np.uint16)
    assert row_undelta(row_delta(q16, 16), 16).tolist() == q16.tolist()


def test_single_band_frame_size_and_order():
    speed = rand()
    raw = encode_frame(SPEED, {"speed": speed}, SHAPE)
    assert len(raw) == 221 * 481 == 106_301
    # First column is stored as is (row 0 = north), then deltas
    assert raw[0] == speed[0, 0] and raw[481] == speed[1, 0]
    assert raw[1] == (speed[0, 1] - speed[0, 0]) % 256
    back = decode_frame(SPEED, raw, SHAPE)["speed"]
    np.testing.assert_array_equal(back, speed.astype(np.uint8))


def test_multi_band_uint16_little_endian():
    qpf = np.zeros(SHAPE)
    qpf[0, 0] = 2.58  # 258 = 0x0102 -> bytes 02 01
    ptype = np.zeros(SHAPE)
    ptype[0, 0] = 2
    raw = encode_frame(PRECIP, {"qpf": qpf, "ptype": ptype}, SHAPE)
    assert len(raw) == 3 * 106_301
    assert raw[0:2] == b"\x02\x01"
    assert raw[2 * 106_301] == 2  # ptype band starts after the uint16 band
    out = decode_frame(PRECIP, raw, SHAPE)
    assert out["qpf"][0, 0] == 258 and out["qpf"].dtype == np.dtype("<u2")
    assert out["ptype"][0, 0] == 2


def test_nodata_survives_the_row_delta():
    band = Band("temp", "F", "uint8", 1.0, -80.0, nodata=255)
    field = FieldSpec("t2m", "t", "x", 0, (band,))
    values = rand(hi=255) - 80  # includes 174 F, the top valid value
    values[5, 10:20] = np.nan
    values[7, 0] = np.nan  # first sample of a row is stored as is
    stored = decode_frame(field, encode_frame(field, {"temp": values}, SHAPE), SHAPE)["temp"]
    missing = np.isnan(values)
    assert (stored[missing] == 255).all() and (stored[~missing] < 255).all()
    np.testing.assert_array_equal(np.isnan(decode_band(stored, band)), missing)


def test_encode_rejects_missing_band_or_shape():
    with pytest.raises(ValueError):
        encode_frame(PRECIP, {"qpf": np.zeros(SHAPE)}, SHAPE)
    with pytest.raises(ValueError):
        encode_frame(SPEED, {"speed": np.zeros((2, 2))}, SHAPE)


def test_decode_rejects_wrong_size():
    with pytest.raises(ValueError):
        decode_frame(SPEED, b"\x00" * 10, SHAPE)


def test_gzip_is_deterministic():
    raw = encode_frame(SPEED, {"speed": rand()}, SHAPE)
    assert gzip_frame(raw) == gzip_frame(raw)


# ---------------------------------------------------------------- run files


def frames_of(hours, seed=0):
    return {f: gzip_frame(encode_frame(SPEED, {"speed": rand(seed=seed + f)}, SHAPE)) for f in hours}


def test_run_file_roundtrip_and_layout():
    frames = {"wspd250": frames_of([12, 0, 6])}
    data = pack_frames(frames)
    assert data[:4] == b"WXRB"
    n = header_length(data[:8])
    index = read_index(data[:n])
    assert list(index) == ["wspd250"] and sorted(index["wspd250"]) == [0, 6, 12]
    # Frames follow the header in hour order, back to back
    off = n
    for f in (0, 6, 12):
        assert index["wspd250"][f] == (off, len(frames["wspd250"][f]))
        off += len(frames["wspd250"][f])
    assert off == len(data)
    assert unpack_frames(data) == {"wspd250": {f: frames["wspd250"][f] for f in (0, 6, 12)}}
    doc = json.loads(data[8:n])
    assert doc == {"v": 1, "fields": {"wspd250": [list((f,) + index["wspd250"][f]) for f in (0, 6, 12)]}}


def test_run_file_with_several_fields_and_offsets_that_change_the_index_length():
    # Offsets cross a power of ten as the index grows: the header must settle on its own length
    frames = {"t2m": {0: b"\x1f\x8b" + b"x" * 9_990}, "mslp": {0: b"\x1f\x8b" + b"y" * 5, 6: b"\x1f\x8b" + b"z"}}
    data = pack_frames(frames)
    assert unpack_frames(data) == frames
    assert list(read_index(data)) == ["t2m", "mslp"]  # fields in the order given


def test_a_typical_index_fits_the_probe():
    data = pack_frames({"precip": {f: b"\x1f\x8b" + bytes(60_000) for f in range(6, 385, 6)}})
    assert header_length(data[:HEADER_PROBE]) < HEADER_PROBE / 2  # 64 hours: room for hourly regionals


def test_run_file_names_are_digests():
    data = pack_frames({"t2m": frames_of([0])})
    name = run_file_name("t2m", data)
    assert name == f"t2m.{hashlib.sha256(data).hexdigest()[:16]}.bin"
    assert run_file_name("t2m", pack_frames({"t2m": frames_of([0], seed=1)})) != name


def test_bad_run_files_are_refused():
    with pytest.raises(ValueError, match="gzip"):
        pack_frames({"t2m": {0: b"raw"}})
    with pytest.raises(ValueError):
        pack_frames({})
    with pytest.raises(ValueError, match="WXRB"):
        read_index(b"\x1f\x8b" + bytes(10))
    data = pack_frames({"t2m": frames_of([0, 6])})
    with pytest.raises(ValueError, match="only 20 were read"):
        read_index(data[:20])
    with pytest.raises(ValueError, match="run past"):
        unpack_frames(data[:-1])


# ---------------------------------------------------------------- the local store


def test_staged_frames_are_listed_and_read(tmp_path):
    store = FrameStore(tmp_path)
    speed = rand()
    path = store.stage_frame("2026100818", "wspd250", 6, gzip_frame(encode_frame(SPEED, {"speed": speed}, SHAPE)))
    assert path == tmp_path / ".staging" / "2026100818" / "wspd250" / "f006.bin.gz"
    assert store.listing(["wspd250"]) == {"2026100818": {"wspd250": [6]}}
    np.testing.assert_array_equal(store.read_frame("2026100818", SPEED, 6, SHAPE)["speed"], speed.astype(np.uint8))


def test_stage_requires_gzip(tmp_path):
    with pytest.raises(ValueError):
        FrameStore(tmp_path).stage_frame("2026100818", "wspd250", 0, b"raw")


def test_run_files_named_by_the_manifest_are_listed(tmp_path):
    store = FrameStore(tmp_path)
    name = store.write_run_file("2026100818", "t2m", pack_frames({"t2m": frames_of([0, 6])}))
    assert store.listing(["t2m"]) == {}  # not named by a manifest: not the store's yet
    (tmp_path / "manifest.json").write_text(json.dumps(
        {"schema_version": 4, "runs": [{"id": "2026100818", "hours": {"t2m": [0, 6]}, "files": {"t2m": name}}]}))
    assert store.run_files() == {"2026100818": {"t2m": name}}
    assert store.listing(["t2m"]) == {"2026100818": {"t2m": [0, 6]}}
    assert store.listing(["mslp"]) == {}
    store.file_path("2026100818", name).unlink()
    assert store.run_files() == {} and store.listing(["t2m"]) == {}


def test_listing_merges_run_files_staged_and_schema_3_frames(tmp_path):
    store = FrameStore(tmp_path)
    name = store.write_run_file("2026100818", "t2m", pack_frames({"t2m": frames_of([0])}))
    (tmp_path / "manifest.json").write_text(json.dumps(
        {"schema_version": 4, "runs": [{"id": "2026100818", "hours": {"t2m": [0]}, "files": {"t2m": name}}]}))
    store.stage_frame("2026100818", "t2m", 12, frames_of([12])[12])
    legacy = store.legacy_path("2026100818", "t2m", 6)
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(frames_of([6])[6])
    assert store.listing(["t2m"]) == {"2026100818": {"t2m": [0, 6, 12]}}
    assert sorted(store.frames("2026100818", "t2m")) == [0, 6, 12]
    assert store.run_ids() == ["2026100818"]


def test_listing_ignores_temp_and_foreign_files(tmp_path):
    store = FrameStore(tmp_path)
    gz = gzip_frame(b"x")
    store.stage_frame("2026100812", "t2m", 12, gz)
    store.stage_frame("2026100812", "t2m", 0, gz)
    store.stage_frame("2026100818", "t2m", 0, gz)
    (tmp_path / ".staging" / "2026100812" / "t2m" / ".f018.bin.gz.abc.tmp").write_bytes(b"partial")
    (tmp_path / "runs" / "notarun").mkdir(parents=True)
    (tmp_path / "runs" / "2026100812").mkdir()
    (tmp_path / "runs" / "2026100812" / ".t2m.0123456789abcdef.bin.x.tmp").write_bytes(b"partial")
    assert store.run_ids() == ["2026100818", "2026100812"]
    assert store.listing(["t2m"]) == {"2026100812": {"t2m": [0, 12]}, "2026100818": {"t2m": [0]}}


def test_finish_clears_staging_the_old_layout_and_unnamed_files(tmp_path):
    store = FrameStore(tmp_path)
    keep = store.write_run_file("2026100818", "t2m", pack_frames({"t2m": frames_of([0])}))
    old = store.write_run_file("2026100818", "t2m", pack_frames({"t2m": frames_of([0], seed=9)}))
    store.stage_frame("2026100818", "t2m", 6, frames_of([6])[6])
    legacy = store.legacy_path("2026100812", "t2m", 0)
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(frames_of([0])[0])
    assert store.finish({"2026100818": {"t2m": keep}}) == 1
    assert store.file_path("2026100818", keep).is_file() and not store.file_path("2026100818", old).exists()
    assert not (tmp_path / ".staging").exists()
    assert not (tmp_path / "runs" / "2026100812").exists()  # emptied, then removed


def test_remove_schema_1_layout(tmp_path):
    store = FrameStore(tmp_path)
    store.stage_frame("2026100818", "wspd250", 0, gzip_frame(b"x"))
    legacy = tmp_path / "runs" / "2026100818" / "f000.bin.gz"
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(gzip_frame(b"old"))
    assert store.remove_legacy() == 1
    assert not legacy.exists()
    assert store.listing(["wspd250"]) == {"2026100818": {"wspd250": [0]}}


def test_prune(tmp_path):
    store = FrameStore(tmp_path)
    for rid in ("2026100800", "2026100806", "2026100812"):
        store.stage_frame(rid, "t2m", 0, gzip_frame(b"x"))
    store.write_run_file("2026100800", "t2m", pack_frames({"t2m": {0: gzip_frame(b"x")}}))
    assert store.prune({"2026100812", "2026100806"}) == ["2026100800"]
    assert store.run_ids() == ["2026100812", "2026100806"]
    assert not (tmp_path / "runs" / "2026100800").exists()
