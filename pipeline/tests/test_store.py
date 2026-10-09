import gzip

import numpy as np
import pytest

from wxtrend.config import Band, FieldSpec
from wxtrend.store import (
    FrameStore,
    decode_frame,
    encode_frame,
    gzip_frame,
    row_delta,
    row_undelta,
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


def test_encode_rejects_missing_band_or_shape():
    with pytest.raises(ValueError):
        encode_frame(PRECIP, {"qpf": np.zeros(SHAPE)}, SHAPE)
    with pytest.raises(ValueError):
        encode_frame(SPEED, {"speed": np.zeros((2, 2))}, SHAPE)


def test_decode_rejects_wrong_size():
    with pytest.raises(ValueError):
        decode_frame(SPEED, b"\x00" * 10, SHAPE)


def test_store_roundtrip(tmp_path):
    store = FrameStore(tmp_path)
    speed = rand()
    path = store.write_frame("2026100818", "wspd250", 6, gzip_frame(encode_frame(SPEED, {"speed": speed}, SHAPE)))
    assert path == tmp_path / "runs" / "2026100818" / "wspd250" / "f006.bin.gz"
    assert len(gzip.decompress(path.read_bytes())) == 106_301
    np.testing.assert_array_equal(store.read_frame("2026100818", SPEED, 6, SHAPE)["speed"], speed.astype(np.uint8))


def test_gzip_is_deterministic():
    raw = encode_frame(SPEED, {"speed": rand()}, SHAPE)
    assert gzip_frame(raw) == gzip_frame(raw)


def test_write_requires_gzip(tmp_path):
    with pytest.raises(ValueError):
        FrameStore(tmp_path).write_frame("2026100818", "wspd250", 0, b"raw")


def test_listing_ignores_temp_and_foreign_files(tmp_path):
    store = FrameStore(tmp_path)
    gz = gzip_frame(b"x")
    store.write_frame("2026100812", "t2m", 12, gz)
    store.write_frame("2026100812", "t2m", 0, gz)
    store.write_frame("2026100818", "t2m", 0, gz)
    (tmp_path / "runs" / "2026100812" / "t2m" / ".f018.bin.gz.abc.tmp").write_bytes(b"partial")
    (tmp_path / "runs" / "notarun").mkdir()
    assert store.run_ids() == ["2026100818", "2026100812"]
    assert store.hours("2026100812", "t2m") == [0, 12]
    assert store.hours("2026100812", "mslp") == []


def test_remove_legacy_layout(tmp_path):
    store = FrameStore(tmp_path)
    store.write_frame("2026100818", "wspd250", 0, gzip_frame(b"x"))
    legacy = tmp_path / "runs" / "2026100818" / "f000.bin.gz"
    legacy.write_bytes(gzip_frame(b"old"))
    assert store.remove_legacy() == 1
    assert not legacy.exists()
    assert store.hours("2026100818", "wspd250") == [0]


def test_prune(tmp_path):
    store = FrameStore(tmp_path)
    for rid in ("2026100800", "2026100806", "2026100812"):
        store.write_frame(rid, "t2m", 0, gzip_frame(b"x"))
    assert store.prune({"2026100812", "2026100806"}) == ["2026100800"]
    assert store.run_ids() == ["2026100812", "2026100806"]
