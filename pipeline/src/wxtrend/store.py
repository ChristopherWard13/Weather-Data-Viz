"""Where processed frames live: a product's local store, and its copy in R2.

    <data_dir>/<product>/manifest.json                       local store (FrameStore)
    <data_dir>/<product>/runs/<YYYYMMDDHH>/<field>/f<FFF>.bin.gz
    <product>/manifest.json, <product>/runs/...               R2 keys (R2Store): the same layout


A frame (format v3) holds the field's bands back to back, in config order.
Each band is ny*nx samples, row-major, row 0 = north; uint16 samples are
little-endian. A band that declares ``nodata`` stores missing samples as the
dtype's top value (255 or 65535). Each row is stored with a delta predictor
(first sample as is, then the difference from the previous sample, modulo
2^bits), which makes smooth fields compress ~20% better under gzip; decoding
is a running sum.
Files are written to a temp name and renamed, so a crash never leaves a
truncated frame that a later run would mistake for a finished one.

In R2, the product's manifest is the source of truth: it lists exactly the
frames that are there. ``sync_to_r2`` publishes a new local manifest by
uploading its frames, then the manifest, then deleting runs it no longer lists,
so the site never sees a manifest entry before its frame.
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import re
import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .config import FieldSpec
from .fields import encode_band

PATH_TEMPLATE = "runs/{run}/{field}/f{fhr:03d}.bin.gz"
_FRAME_RE = re.compile(r"^f(\d{3})\.bin\.gz$")
_RUN_RE = re.compile(r"^\d{10}$")

_NP_DTYPE = {"uint8": np.dtype("u1"), "uint16": np.dtype("<u2")}

log = logging.getLogger(__name__)

# The frames a store or manifest has: run id -> field id -> sorted hours.
# Runs and fields with no frames are left out.
Listing = dict[str, dict[str, list[int]]]


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

    def listing(self, field_ids: list[str]) -> Listing:
        out: Listing = {}
        for run_id in self.run_ids():
            hours = {fid: h for fid in field_ids if (h := self.hours(run_id, fid))}
            if hours:
                out[run_id] = hours
        return out

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


def listed_in(manifest: dict | None) -> Listing:
    """The frames a manifest lists (None, as for a bucket with no manifest yet, lists none)."""
    out: Listing = {}
    for run in (manifest or {}).get("runs", []):
        hours = {fid: sorted(h) for fid, h in run["hours"].items() if h}
        if hours:
            out[run["id"]] = hours
    return out


def merge_listings(*listings: Listing) -> Listing:
    out: dict[str, dict[str, set[int]]] = {}
    for listing in listings:
        for run_id, fields in listing.items():
            for fid, hours in fields.items():
                out.setdefault(run_id, {}).setdefault(fid, set()).update(hours)
    return {r: {fid: sorted(h) for fid, h in fields.items()} for r, fields in out.items()}


def frame_keys(listing: Listing) -> set[tuple[str, str, int]]:
    return {(r, fid, f) for r, fields in listing.items() for fid, hours in fields.items() for f in hours}


# ---------------------------------------------------------------- Cloudflare R2

FRAME_CACHE_CONTROL = "public, max-age=31536000, immutable"  # a written frame never changes
MANIFEST_CACHE_CONTROL = "public, max-age=60"
R2_ENV = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
R2_WORKERS = 16  # concurrent uploads and deletes


class SyncError(RuntimeError):
    pass


class R2Store:
    """One product's objects in an R2 bucket, through R2's S3 API.

    ``client`` is a boto3 S3 client (or a stand-in with the same methods).
    Frames are stored as the gzip bytes they are on disk, with no
    Content-Encoding, so browsers get them exactly as GitHub Pages served them.
    """

    def __init__(self, client, bucket: str, product_id: str):
        self.client = client
        self.bucket = bucket
        self.prefix = f"{product_id}/"

    @classmethod
    def from_env(cls, product_id: str) -> R2Store:
        missing = [k for k in R2_ENV if not os.environ.get(k)]
        if missing:
            raise SyncError(f"R2 needs these environment variables: {', '.join(missing)}")
        import boto3
        from botocore.config import Config

        client = boto3.client(
            "s3",
            endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
            config=Config(
                retries={"max_attempts": 5, "mode": "standard"},
                max_pool_connections=R2_WORKERS,
                # Only the checksums an operation requires, as before boto3 1.36:
                # R2 doesn't document support for the newer default ones.
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            ),
        )
        return cls(client, os.environ["R2_BUCKET"], product_id)

    def read_manifest(self) -> dict | None:
        """The product's manifest, or None if the bucket has none yet."""
        from botocore.exceptions import ClientError

        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=self.prefix + "manifest.json")
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
                return None
            raise
        return json.loads(obj["Body"].read())

    def put_frame(self, rel: str, gz: bytes) -> None:
        self.client.put_object(
            Bucket=self.bucket, Key=self.prefix + rel, Body=gz,
            ContentType="application/octet-stream", CacheControl=FRAME_CACHE_CONTROL,
        )

    def put_manifest(self, payload: bytes) -> None:
        self.client.put_object(
            Bucket=self.bucket, Key=self.prefix + "manifest.json", Body=payload,
            ContentType="application/json", CacheControl=MANIFEST_CACHE_CONTROL,
        )

    def _list(self, prefix: str, delimiter: str | None = None):
        """Every page of a listing (R2 returns at most 1000 keys per page)."""
        kwargs = {"Bucket": self.bucket, "Prefix": prefix}
        if delimiter:
            kwargs["Delimiter"] = delimiter
        while True:
            page = self.client.list_objects_v2(**kwargs)
            yield page
            if not page.get("IsTruncated"):
                return
            kwargs["ContinuationToken"] = page["NextContinuationToken"]

    def run_ids(self) -> list[str]:
        """Runs with any objects in the bucket, listed or not, newest first."""
        runs = self.prefix + "runs/"
        ids = {
            p["Prefix"][len(runs):].rstrip("/")
            for page in self._list(runs, delimiter="/") for p in page.get("CommonPrefixes", [])
        }
        return sorted((i for i in ids if _RUN_RE.match(i)), reverse=True)

    def delete_run(self, run_id: str, pool: ThreadPoolExecutor) -> int:
        """Delete every object under a run. One DeleteObject per key: R2 doesn't
        document the checksum that boto3 now sends with batch DeleteObjects."""
        keys = [o["Key"] for page in self._list(f"{self.prefix}runs/{run_id}/") for o in page.get("Contents", [])]
        list(pool.map(lambda k: self.client.delete_object(Bucket=self.bucket, Key=k), keys))
        return len(keys)


@dataclass
class SyncResult:
    uploaded: list[tuple[str, str, int]] = field(default_factory=list)  # (run, field, fhr)
    already_published: int = 0
    pruned: list[str] = field(default_factory=list)


def sync_to_r2(store: FrameStore, remote: R2Store, workers: int = R2_WORKERS) -> SyncResult:
    """Publish the local manifest to R2.

    1. Read the remote manifest, and check the local one was built from it:
       every frame it lists is on disk or already in R2, and R2's manifest
       hasn't changed since.
    2. Upload the frames R2 doesn't have yet. Frames already there are never
       rewritten (they're cached as immutable).
    3. Upload the manifest.
    4. Delete runs the manifest no longer lists.

    Any failure stops before the next step, so R2's manifest only ever lists
    frames that are there.
    """
    payload = (store.root / "manifest.json").read_bytes()
    manifest = json.loads(payload)
    if remote.prefix != f"{manifest['product']}/":
        raise SyncError(f"manifest is for product {manifest['product']}, not {remote.prefix.rstrip('/')}")
    listed = listed_in(manifest)
    if not listed:
        raise SyncError("the manifest lists no frames; refusing to publish it")

    current = remote.read_manifest()
    if current and current["generated_at"] > manifest["generated_at"]:
        raise SyncError(
            f"R2's manifest ({current['generated_at']}) is newer than this one ({manifest['generated_at']}); "
            "run `wxtrend update --remote` again"
        )
    published = frame_keys(listed_in(current))
    result = SyncResult()
    missing = []
    for key in sorted(frame_keys(listed)):
        if key in published:
            result.already_published += 1
        elif store.frame_path(*key).is_file():
            result.uploaded.append(key)
        else:
            missing.append(key)
    if missing:
        run, fid, f = missing[0]
        raise SyncError(f"{len(missing)} listed frames are neither on disk nor in R2, e.g. {run} {fid} f{f:03d}")

    def upload(key: tuple[str, str, int]) -> None:
        run, fid, f = key
        remote.put_frame(PATH_TEMPLATE.format(run=run, field=fid, fhr=f), store.frame_path(run, fid, f).read_bytes())

    with ThreadPoolExecutor(workers) as pool:
        list(pool.map(upload, result.uploaded))  # re-raises the first failure
        log.info("uploaded %d frames (%d already in R2)", len(result.uploaded), result.already_published)
        remote.put_manifest(payload)
        log.info("uploaded manifest: latest %s, %d runs", manifest["latest"], len(listed))
        for run_id in remote.run_ids():
            if run_id not in listed:
                n = remote.delete_run(run_id, pool)
                result.pruned.append(run_id)
                log.info("deleted run %s from R2 (%d objects)", run_id, n)
    return result
