"""On-disk layout for processed frames.

    <data_dir>/manifest.json
    <data_dir>/runs/<YYYYMMDDHH>/<field>/f<FFF>.bin.gz

A frame holds the field's bands back to back, in config order. Each band is
ny*nx samples, row-major, row 0 = north; uint16 samples are little-endian.
Each row is stored with a delta predictor (first sample as is, then the
difference from the previous sample, modulo 2^bits), which makes smooth
fields compress ~20% better under gzip; decoding is a running sum.
Files are written to a temp name and renamed, so a crash never leaves a
truncated frame that a later run would mistake for a finished one.
"""

from __future__ import annotations

import gzip
import os
import re
import shutil
import tempfile
from pathlib import Path

import numpy as np

from .config import FieldSpec
from .fields import encode_band

PATH_TEMPLATE = "runs/{run}/{field}/f{fhr:03d}.bin.gz"
_FRAME_RE = re.compile(r"^f(\d{3})\.bin\.gz$")
_RUN_RE = re.compile(r"^\d{10}$")

_NP_DTYPE = {"uint8": np.dtype("u1"), "uint16": np.dtype("<u2")}


def row_delta(q: np.ndarray, bits: int) -> np.ndarray:
    """Row-wise delta predictor, modulo 2**bits (lossless; undo with row_undelta)."""
    q = q.astype(np.int64)
    return (np.diff(q, axis=1, prepend=0) % (1 << bits)).astype(q.dtype)


def row_undelta(d: np.ndarray, bits: int) -> np.ndarray:
    return np.cumsum(d.astype(np.int64), axis=1) % (1 << bits)


def encode_frame(field: FieldSpec, values: dict[str, np.ndarray], shape: tuple[int, int]) -> bytes:
    """Physical band values -> raw frame bytes (bands concatenated)."""
    missing = [b.name for b in field.bands if b.name not in values]
    if missing:
        raise ValueError(f"{field.id}: missing bands {missing}")
    parts = []
    for b in field.bands:
        v = np.asarray(values[b.name])
        if v.shape != shape:
            raise ValueError(f"{field.id}.{b.name}: shape {v.shape}, expected {shape}")
        delta = row_delta(encode_band(v, b), 8 * b.itemsize)
        parts.append(np.ascontiguousarray(delta, dtype=_NP_DTYPE[b.dtype]).tobytes())
    return b"".join(parts)


def decode_frame(field: FieldSpec, raw: bytes, shape: tuple[int, int]) -> dict[str, np.ndarray]:
    """Raw frame bytes -> stored (integer) arrays per band."""
    n = shape[0] * shape[1]
    expected = field.frame_bytes(shape[1], shape[0])
    if len(raw) != expected:
        raise ValueError(f"{field.id}: {len(raw)} bytes, expected {expected}")
    out, pos = {}, 0
    for b in field.bands:
        size = n * b.itemsize
        d = np.frombuffer(raw, dtype=_NP_DTYPE[b.dtype], count=n, offset=pos).reshape(shape)
        out[b.name] = row_undelta(d, 8 * b.itemsize).astype(_NP_DTYPE[b.dtype])
        pos += size
    return out


def gzip_frame(raw: bytes) -> bytes:
    return gzip.compress(raw, compresslevel=9, mtime=0)


class FrameStore:
    def __init__(self, data_dir: str | os.PathLike):
        self.root = Path(data_dir)
        self.runs_dir = self.root / "runs"

    def frame_path(self, run_id: str, field_id: str, fhr: int) -> Path:
        return self.root / PATH_TEMPLATE.format(run=run_id, field=field_id, fhr=fhr)

    def run_ids(self) -> list[str]:
        """Run ids on disk, newest first."""
        if not self.runs_dir.is_dir():
            return []
        ids = [p.name for p in self.runs_dir.iterdir() if p.is_dir() and _RUN_RE.match(p.name)]
        return sorted(ids, reverse=True)

    def hours(self, run_id: str, field_id: str) -> list[int]:
        d = self.runs_dir / run_id / field_id
        if not d.is_dir():
            return []
        return sorted(int(m.group(1)) for p in d.iterdir() if (m := _FRAME_RE.match(p.name)))

    def write_frame(self, run_id: str, field_id: str, fhr: int, gz: bytes) -> Path:
        if gz[:2] != b"\x1f\x8b":
            raise ValueError("write_frame expects gzip bytes")
        path = self.frame_path(run_id, field_id, fhr)
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(path, gz)
        return path

    def read_frame(self, run_id: str, field: FieldSpec, fhr: int, shape: tuple[int, int]) -> dict[str, np.ndarray]:
        raw = gzip.decompress(self.frame_path(run_id, field.id, fhr).read_bytes())
        return decode_frame(field, raw, shape)

    def remove_legacy(self) -> int:
        """Delete schema-1 frames (runs/<id>/fNNN.bin.gz, wind speed only)."""
        n = 0
        for run_id in self.run_ids():
            for p in (self.runs_dir / run_id).iterdir():
                if p.is_file() and _FRAME_RE.match(p.name):
                    p.unlink()
                    n += 1
        return n

    def prune(self, keep: set[str]) -> list[str]:
        """Delete run directories not in ``keep``; return the ids removed."""
        removed = []
        for run_id in self.run_ids():
            if run_id not in keep:
                shutil.rmtree(self.runs_dir / run_id)
                removed.append(run_id)
        return removed


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(payload)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
