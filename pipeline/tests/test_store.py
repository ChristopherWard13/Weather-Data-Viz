import gzip

import numpy as np
import pytest

from wxtrend.store import FrameStore


def frame(shape=(221, 481), value=None):
    rng = np.random.default_rng(0)
    if value is not None:
        return np.full(shape, value, np.uint8)
    return rng.integers(0, 256, shape, dtype=np.uint8)


def test_roundtrip_and_size(tmp_path):
    store = FrameStore(tmp_path)
    data = frame()
    path = store.write_frame("2026100818", 6, data)
    assert path == tmp_path / "runs" / "2026100818" / "f006.bin.gz"
    raw = gzip.decompress(path.read_bytes())
    assert len(raw) == 221 * 481 == 106_301
    # Row-major, row 0 first
    assert raw[:481] == data[0].tobytes()
    np.testing.assert_array_equal(store.read_frame("2026100818", 6, (221, 481)), data)


def test_gzip_output_is_deterministic(tmp_path):
    store = FrameStore(tmp_path)
    a = store.write_frame("2026100818", 0, frame()).read_bytes()
    b = store.write_frame("2026100818", 0, frame()).read_bytes()
    assert a == b


def test_rejects_wrong_dtype(tmp_path):
    with pytest.raises(ValueError):
        FrameStore(tmp_path).write_frame("2026100818", 0, np.zeros((2, 2), np.int16))


def test_read_rejects_wrong_size(tmp_path):
    store = FrameStore(tmp_path)
    store.write_frame("2026100818", 0, frame((10, 10)))
    with pytest.raises(ValueError):
        store.read_frame("2026100818", 0, (221, 481))


def test_listing_ignores_temp_and_foreign_files(tmp_path):
    store = FrameStore(tmp_path)
    store.write_frame("2026100812", 12, frame((2, 2)))
    store.write_frame("2026100812", 0, frame((2, 2)))
    store.write_frame("2026100818", 0, frame((2, 2)))
    (tmp_path / "runs" / "2026100812" / ".f018.bin.gz.abc.tmp").write_bytes(b"partial")
    (tmp_path / "runs" / "notarun").mkdir()
    assert store.run_ids() == ["2026100818", "2026100812"]
    assert store.hours("2026100812") == [0, 12]
    assert store.hours("missing") == []


def test_prune(tmp_path):
    store = FrameStore(tmp_path)
    for rid in ("2026100800", "2026100806", "2026100812"):
        store.write_frame(rid, 0, frame((2, 2)))
    removed = store.prune({"2026100812", "2026100806"})
    assert removed == ["2026100800"]
    assert store.run_ids() == ["2026100812", "2026100806"]
