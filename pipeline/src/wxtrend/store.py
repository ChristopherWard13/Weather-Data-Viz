"""On-disk layout for processed frames.

    <data_dir>/manifest.json
    <data_dir>/runs/<YYYYMMDDHH>/f<FFF>.bin.gz

Each frame is ny*nx uint8 knots in row-major order (row 0 = north), gzipped.
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

PATH_TEMPLATE = "runs/{run}/f{fhr:03d}.bin.gz"
_FRAME_RE = re.compile(r"^f(\d{3})\.bin\.gz$")
_RUN_RE = re.compile(r"^\d{10}$")


class FrameStore:
    def __init__(self, data_dir: str | os.PathLike):
        self.root = Path(data_dir)
        self.runs_dir = self.root / "runs"

    def frame_path(self, run_id: str, fhr: int) -> Path:
        return self.root / PATH_TEMPLATE.format(run=run_id, fhr=fhr)

    def run_ids(self) -> list[str]:
        """Run ids on disk, newest first."""
        if not self.runs_dir.is_dir():
            return []
        ids = [p.name for p in self.runs_dir.iterdir() if p.is_dir() and _RUN_RE.match(p.name)]
        return sorted(ids, reverse=True)

    def hours(self, run_id: str) -> list[int]:
        run_dir = self.runs_dir / run_id
        if not run_dir.is_dir():
            return []
        out = []
        for p in run_dir.iterdir():
            m = _FRAME_RE.match(p.name)
            if m:
                out.append(int(m.group(1)))
        return sorted(out)

    def write_frame(self, run_id: str, fhr: int, data: np.ndarray) -> Path:
        if data.dtype != np.uint8 or data.ndim != 2:
            raise ValueError(f"expected a 2-D uint8 array, got {data.dtype} {data.shape}")
        path = self.frame_path(run_id, fhr)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = gzip.compress(np.ascontiguousarray(data).tobytes(), compresslevel=9, mtime=0)
        atomic_write_bytes(path, payload)
        return path

    def read_frame(self, run_id: str, fhr: int, shape: tuple[int, int]) -> np.ndarray:
        raw = gzip.decompress(self.frame_path(run_id, fhr).read_bytes())
        expected = shape[0] * shape[1]
        if len(raw) != expected:
            raise ValueError(f"{run_id} f{fhr:03d}: {len(raw)} bytes, expected {expected}")
        return np.frombuffer(raw, dtype=np.uint8).reshape(shape)

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
