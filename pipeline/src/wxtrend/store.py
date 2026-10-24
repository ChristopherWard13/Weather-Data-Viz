"""Where processed frames live: a product's local store, and its copy in R2.

    <data_dir>/<product>/manifest.json                            local store (FrameStore)
    <data_dir>/<product>/runs/<YYYYMMDDHH>/<field>.<digest>.bin    one run file per run and field
    <product>/manifest.json, <product>/runs/...                    R2 keys (R2Store): the same layout


A frame (format v3) holds the field's bands back to back, in config order.
Each band is ny*nx samples, row-major, row 0 = north; uint16 samples are
little-endian. A band that declares ``nodata`` stores missing samples as the
dtype's top value (255 or 65535). Each row is stored with a delta predictor
(first sample as is, then the difference from the previous sample, modulo
2^bits), which makes smooth fields compress ~20% better under gzip; decoding
is a running sum. Each frame is gzipped on its own.

**Run files** (manifest schema 4) hold every hour of one field of one run, so
publishing a run is one write per field rather than one per field and hour
(about 40 times fewer, which keeps R2's writes inside its free tier). A run
file is a small container, ``wxrb1``:

    bytes 0-3    b"WXRB"
    bytes 4-7    n, the index's length in bytes (uint32, little-endian)
    bytes 8..    the index: n bytes of UTF-8 JSON,
                 {"v": 1, "fields": {"<field>": [[fhr, offset, length], ...]}}
    then         each frame's gzip bytes at its offset (from the file's start),
                 in field order, then hour order

The site reads the first ``HEADER_PROBE`` bytes for the index, then each frame
by byte range; the pipeline reads files whole. A file is named after its field
and a digest of its bytes (``t2m.0123456789abcdef.bin``), so it never changes
once written and is cached as immutable. Rewriting a run (an hour that failed
fills in later) writes a new file. In R2 the old one is left until the run
leaves the window, and is deleted with it, so a visitor holding the older
manifest can still read it; locally it's deleted once the new manifest is
written. The archive's F000 files use the same container with every field in
one file.

While a pass runs, the frames it fetches are staged one file per hour under
``.staging/``. Packing (``update.pack_runs``) combines them with the run's
existing file into a new one, the manifest written next names it, and
``FrameStore.finish`` then clears the staging and anything the manifest no
longer names. Files are written to a temp name and renamed, so a crash never
leaves a truncated file that a later pass would mistake for a finished one.

Manifest schema 3 kept one file per frame, ``runs/<run>/<field>/f<FFF>.bin.gz``
(``LEGACY_TEMPLATE``). Packing reads that layout too, locally or from R2, so a
store or bucket still in it is converted by its next pass.

In R2, the product's manifest is the source of truth: it lists exactly the
files that are there. ``sync_to_r2`` publishes a new local manifest by
uploading its new files, then the manifest, then deleting runs it no longer
lists, so the site never sees a manifest entry before its file.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import re
import shutil
import struct
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .config import FieldSpec
from .fields import encode_band

CONTAINER = "wxrb1"
MAGIC = b"WXRB"
CONTAINER_VERSION = 1
HEADER_PROBE = 4096  # bytes a reader fetches first: the index of any product's run file fits
FILE_TEMPLATE = "runs/{run}/{file}"
LEGACY_TEMPLATE = "runs/{run}/{field}/f{fhr:03d}.bin.gz"  # manifest schema 3: one file per frame

_FILE_RE = re.compile(r"^([a-z][a-z0-9_]*)\.([0-9a-f]{16})\.bin$")
_LEGACY_FRAME_RE = re.compile(r"^f(\d{3})\.bin\.gz$")
_RUN_RE = re.compile(r"^\d{10}$")
_FIELD_RE = re.compile(r"^[a-z][a-z0-9_]*$")

_NP_DTYPE = {"uint8": np.dtype("u1"), "uint16": np.dtype("<u2")}

log = logging.getLogger(__name__)

# The frames a store or manifest has: run id -> field id -> sorted hours.
# Runs and fields with no frames are left out.
Listing = dict[str, dict[str, list[int]]]
# Frames' gzip bytes: field id -> hour -> bytes
Frames = dict[str, dict[int, bytes]]
# A run file's index: field id -> hour -> (offset, length)
Index = dict[str, dict[int, tuple[int, int]]]
# The run files a manifest names: run id -> field id -> file name
RunFiles = dict[str, dict[str, str]]


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


# ---------------------------------------------------------------- run files (container wxrb1)


def _header(entries: dict[str, list[list[int]]]) -> bytes:
    index = json.dumps({"v": CONTAINER_VERSION, "fields": entries}, separators=(",", ":")).encode()
    return MAGIC + struct.pack("<I", len(index)) + index


def pack_frames(frames: Frames) -> bytes:
    """A run file holding ``frames`` (gzip bytes), fields in the order given, hours ascending."""
    if not frames or not all(frames.values()):
        raise ValueError("a run file needs at least one frame of each field it lists")
    for fid, hours in frames.items():
        if not _FIELD_RE.match(fid):
            raise ValueError(f"bad field id {fid!r}")
        for f, gz in hours.items():
            if gz[:2] != b"\x1f\x8b":
                raise ValueError(f"{fid} f{f:03d}: frames are packed as gzip bytes")
    order = [(fid, f, frames[fid][f]) for fid in frames for f in sorted(frames[fid])]
    # The index's length depends on the offsets it lists, which depend on its
    # length: settle it (a few passes: offsets only grow, so it converges)
    start = 8
    while True:
        entries: dict[str, list[list[int]]] = {}
        pos = start
        for fid, f, gz in order:
            entries.setdefault(fid, []).append([f, pos, len(gz)])
            pos += len(gz)
        header = _header(entries)
        if len(header) == start:
            break
        start = len(header)
    return header + b"".join(gz for _, _, gz in order)


def header_length(prefix: bytes) -> int:
    """How many bytes from the start of a run file its header takes (magic, length and index)."""
    if len(prefix) < 8 or prefix[:4] != MAGIC:
        raise ValueError("not a run file (no WXRB header)")
    return 8 + struct.unpack("<I", prefix[4:8])[0]


def read_index(data: bytes) -> Index:
    """A run file's index, from its first ``header_length`` bytes (or more)."""
    n = header_length(data)
    if len(data) < n:
        raise ValueError(f"the run file's header is {n} bytes; only {len(data)} were read")
    doc = json.loads(data[8:n])
    if doc.get("v") != CONTAINER_VERSION:
        raise ValueError(f"run file version {doc.get('v')!r}, expected {CONTAINER_VERSION}")
    out: Index = {}
    for fid, entries in doc["fields"].items():
        out[fid] = {int(f): (int(off), int(length)) for f, off, length in entries}
    return out


def unpack_frames(data: bytes) -> Frames:
    """Every frame's gzip bytes in a whole run file."""
    out: Frames = {}
    for fid, hours in read_index(data).items():
        for f, (off, length) in hours.items():
            if off + length > len(data):
                raise ValueError(f"{fid} f{f:03d}: bytes {off}+{length} run past the file's {len(data)}")
            out.setdefault(fid, {})[f] = data[off:off + length]
    return out


def run_file_name(label: str, data: bytes) -> str:
    """``<label>.<digest>.bin``: the field (or ``f000`` in the archive) and its bytes' digest."""
    if not _FIELD_RE.match(label):
        raise ValueError(f"bad run file label {label!r}")
    return f"{label}.{hashlib.sha256(data).hexdigest()[:16]}.bin"


def files_in(manifest: dict | None) -> RunFiles:
    """The run files a manifest names ({} for one in the schema-3 layout, which has none)."""
    out: RunFiles = {}
    for run in (manifest or {}).get("runs", []):
        if run.get("files"):
            out[run["id"]] = dict(run["files"])
    return out


def file_keys(files: RunFiles) -> set[str]:
    """Keys (under the product's prefix) of every run file in ``files``."""
    return {FILE_TEMPLATE.format(run=r, file=name) for r, by_field in files.items() for name in by_field.values()}


# ---------------------------------------------------------------- the local store


class FrameStore:
    def __init__(self, data_dir: str | os.PathLike):
        self.root = Path(data_dir)
        self.runs_dir = self.root / "runs"
        self.staging_dir = self.root / ".staging"

    def _manifest(self) -> dict | None:
        try:
            return json.loads((self.root / "manifest.json").read_text())
        except (OSError, ValueError):
            return None

    # Run files

    def file_path(self, run_id: str, name: str) -> Path:
        return self.root / FILE_TEMPLATE.format(run=run_id, file=name)

    def run_files(self) -> RunFiles:
        """The run files the store's manifest names that are on disk."""
        out: RunFiles = {}
        for run_id, by_field in files_in(self._manifest()).items():
            present = {fid: name for fid, name in by_field.items() if self.file_path(run_id, name).is_file()}
            if present:
                out[run_id] = present
        return out

    def write_run_file(self, run_id: str, label: str, data: bytes) -> str:
        """Write a run file (atomically) and return its name."""
        name = run_file_name(label, data)
        path = self.file_path(run_id, name)
        if not path.is_file():
            path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_bytes(path, data)
        return name

    def read_index(self, run_id: str, name: str) -> Index:
        with open(self.file_path(run_id, name), "rb") as f:
            prefix = f.read(HEADER_PROBE)
            n = header_length(prefix)
            if n > len(prefix):
                prefix += f.read(n - len(prefix))
        return read_index(prefix)

    # Staged frames: fetched this pass, not packed yet

    def staged_path(self, run_id: str, field_id: str, fhr: int) -> Path:
        return self.staging_dir / run_id / field_id / f"f{fhr:03d}.bin.gz"

    def stage_frame(self, run_id: str, field_id: str, fhr: int, gz: bytes) -> Path:
        if gz[:2] != b"\x1f\x8b":
            raise ValueError("stage_frame expects gzip bytes")
        path = self.staged_path(run_id, field_id, fhr)
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(path, gz)
        return path

    def staged(self) -> Listing:
        return _scan_frames(self.staging_dir)

    # Frames in the schema-3 layout, which packing converts

    def legacy_path(self, run_id: str, field_id: str, fhr: int) -> Path:
        return self.root / LEGACY_TEMPLATE.format(run=run_id, field=field_id, fhr=fhr)

    def legacy(self) -> Listing:
        return _scan_frames(self.runs_dir)

    # Everything

    def run_ids(self) -> list[str]:
        """Runs with anything on disk (run files, staged or legacy frames), newest first."""
        ids = set()
        for d in (self.runs_dir, self.staging_dir):
            if d.is_dir():
                ids |= {p.name for p in d.iterdir() if p.is_dir() and _RUN_RE.match(p.name)}
        return sorted(ids, reverse=True)

    def listing(self, field_ids: list[str]) -> Listing:
        """The frames the store has: in its run files, staged, or in the schema-3 layout."""
        packed: Listing = {}
        for run_id, by_field in self.run_files().items():
            for fid, name in by_field.items():
                hours = self.read_index(run_id, name).get(fid)
                if hours:
                    packed.setdefault(run_id, {})[fid] = sorted(hours)
        merged = merge_listings(packed, self.staged(), self.legacy())
        out: Listing = {}
        for run_id, fields in merged.items():
            kept = {fid: h for fid, h in fields.items() if fid in field_ids}
            if kept:
                out[run_id] = kept
        return out

    def frames(self, run_id: str, field_id: str) -> dict[int, bytes]:
        """A field's frames on disk (gzip bytes by hour): its run file's, then any in the
        schema-3 layout, then staged ones (later wins)."""
        out: dict[int, bytes] = {}
        name = self.run_files().get(run_id, {}).get(field_id)
        if name:
            out.update(unpack_frames(self.file_path(run_id, name).read_bytes()).get(field_id, {}))
        for f in self.legacy().get(run_id, {}).get(field_id, []):
            out[f] = self.legacy_path(run_id, field_id, f).read_bytes()
        for f in self.staged().get(run_id, {}).get(field_id, []):
            out[f] = self.staged_path(run_id, field_id, f).read_bytes()
        return out

    def read_frame(self, run_id: str, field: FieldSpec, fhr: int, shape: tuple[int, int]) -> dict[str, np.ndarray]:
        frames = self.frames(run_id, field.id)
        if fhr not in frames:
            raise FileNotFoundError(f"{run_id} {field.id} f{fhr:03d} isn't in the store")
        return decode_frame(field, gzip.decompress(frames[fhr]), shape)

    def finish(self, files: RunFiles) -> int:
        """After a manifest naming ``files`` is written: clear the staged frames and the
        schema-3 layout, and delete run files it doesn't name. Returns the files deleted."""
        shutil.rmtree(self.staging_dir, ignore_errors=True)
        n = 0
        if not self.runs_dir.is_dir():
            return n
        for run_dir in self.runs_dir.iterdir():
            if not (run_dir.is_dir() and _RUN_RE.match(run_dir.name)):
                continue
            keep = set(files.get(run_dir.name, {}).values())
            for p in run_dir.iterdir():
                if p.is_dir() and _FIELD_RE.match(p.name):  # a schema-3 field directory
                    shutil.rmtree(p)
                elif p.is_file() and _FILE_RE.match(p.name) and p.name not in keep:
                    p.unlink()
                    n += 1
            if not any(run_dir.iterdir()):
                run_dir.rmdir()
        return n

    def remove_legacy(self) -> int:
        """Delete schema-1 frames (runs/<id>/fNNN.bin.gz, wind speed only)."""
        n = 0
        for run_id in self.run_ids():
            run_dir = self.runs_dir / run_id
            if not run_dir.is_dir():
                continue
            for p in run_dir.iterdir():
                if p.is_file() and _LEGACY_FRAME_RE.match(p.name):
                    p.unlink()
                    n += 1
        return n

    def prune(self, keep: set[str]) -> list[str]:
        """Delete runs not in ``keep``; return the ids removed."""
        removed = []
        for run_id in self.run_ids():
            if run_id not in keep:
                shutil.rmtree(self.runs_dir / run_id, ignore_errors=True)
                shutil.rmtree(self.staging_dir / run_id, ignore_errors=True)
                removed.append(run_id)
        return removed


def _scan_frames(root: Path) -> Listing:
    """``<root>/<run>/<field>/f<FFF>.bin.gz`` files: staged frames, or the schema-3 layout."""
    out: Listing = {}
    if not root.is_dir():
        return out
    for run_dir in root.iterdir():
        if not (run_dir.is_dir() and _RUN_RE.match(run_dir.name)):
            continue
        for field_dir in run_dir.iterdir():
            if not (field_dir.is_dir() and _FIELD_RE.match(field_dir.name)):
                continue
            hours = sorted(int(m.group(1)) for p in field_dir.iterdir() if (m := _LEGACY_FRAME_RE.match(p.name)))
            if hours:
                out.setdefault(run_dir.name, {})[field_dir.name] = hours
    return out


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

FRAME_CACHE_CONTROL = "public, max-age=31536000, immutable"  # a written run file never changes
MANIFEST_CACHE_CONTROL = "public, max-age=60"
R2_ENV = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
R2_WORKERS = 16  # concurrent uploads, downloads and deletes


class SyncError(RuntimeError):
    pass


def require_env(names: tuple[str, ...]) -> None:
    missing = [k for k in names if not os.environ.get(k)]
    if missing:
        raise SyncError(f"R2 needs these environment variables: {', '.join(missing)}")


def r2_client(access_key_id: str, secret_access_key: str):
    """A boto3 S3 client for the account's R2 endpoint ($R2_ACCOUNT_ID)."""
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
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


def list_pages(client, bucket: str, prefix: str, delimiter: str | None = None):
    """Every page of a listing (R2 returns at most 1000 keys per page)."""
    kwargs = {"Bucket": bucket, "Prefix": prefix}
    if delimiter:
        kwargs["Delimiter"] = delimiter
    while True:
        page = client.list_objects_v2(**kwargs)
        yield page
        if not page.get("IsTruncated"):
            return
        kwargs["ContinuationToken"] = page["NextContinuationToken"]


class R2Store:
    """One product's objects in an R2 bucket, through R2's S3 API.

    ``client`` is a boto3 S3 client (or a stand-in with the same methods).
    Run files are stored as they are on disk, with no Content-Encoding: their
    frames are gzipped one by one, and the browser reads them by byte range.
    """

    def __init__(self, client, bucket: str, product_id: str):
        self.client = client
        self.bucket = bucket
        self.prefix = f"{product_id}/"

    @classmethod
    def from_env(cls, product_id: str) -> R2Store:
        require_env(R2_ENV)
        client = r2_client(os.environ["R2_ACCESS_KEY_ID"], os.environ["R2_SECRET_ACCESS_KEY"])
        return cls(client, os.environ["R2_BUCKET"], product_id)

    def read_manifest(self) -> dict | None:
        """The product's manifest, or None if the bucket has none yet."""
        return self.read_json("manifest.json")

    def read_json(self, rel: str) -> dict | None:
        """A JSON object under the product's prefix, or None if there's none."""
        from botocore.exceptions import ClientError

        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=self.prefix + rel)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
                return None
            raise
        return json.loads(obj["Body"].read())

    def get_bytes(self, rel: str) -> bytes:
        """An object's bytes. A missing object raises FileNotFoundError."""
        from botocore.exceptions import ClientError

        try:
            return self.client.get_object(Bucket=self.bucket, Key=self.prefix + rel)["Body"].read()
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
                raise FileNotFoundError(f"{self.bucket}/{self.prefix}{rel} isn't in R2") from None
            raise

    def exists(self, rel: str) -> bool:
        """Whether an object is there (a HEAD request)."""
        from botocore.exceptions import ClientError

        try:
            self.client.head_object(Bucket=self.bucket, Key=self.prefix + rel)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("NoSuchKey", "404", "NotFound"):
                return False
            raise
        return True

    def get_range(self, rel: str, start: int, end: int) -> bytes:
        """Bytes ``start`` to ``end`` (inclusive) of an object, or fewer if it ends sooner."""
        obj = self.client.get_object(Bucket=self.bucket, Key=self.prefix + rel, Range=f"bytes={start}-{end}")
        return obj["Body"].read()

    def put_json(self, rel: str, payload: bytes) -> None:
        self.client.put_object(
            Bucket=self.bucket, Key=self.prefix + rel, Body=payload,
            ContentType="application/json", CacheControl=MANIFEST_CACHE_CONTROL,
        )

    def copy_from(self, source: R2Store, rel: str) -> None:
        """Copy one object from another bucket, server side, keeping its
        Content-Type and Cache-Control. The client's token must read the
        source bucket and write this one."""
        self.client.copy_object(
            Bucket=self.bucket, Key=self.prefix + rel, CopySource={"Bucket": source.bucket, "Key": source.prefix + rel},
        )

    def put_file(self, rel: str, data: bytes) -> None:
        """A run file: immutable, since its name is a digest of its bytes."""
        self.client.put_object(
            Bucket=self.bucket, Key=self.prefix + rel, Body=data,
            ContentType="application/octet-stream", CacheControl=FRAME_CACHE_CONTROL,
        )

    def put_manifest(self, payload: bytes) -> None:
        self.client.put_object(
            Bucket=self.bucket, Key=self.prefix + "manifest.json", Body=payload,
            ContentType="application/json", CacheControl=MANIFEST_CACHE_CONTROL,
        )

    def _list(self, prefix: str, delimiter: str | None = None):
        return list_pages(self.client, self.bucket, prefix, delimiter)

    def run_ids(self) -> list[str]:
        """Runs with any objects in the bucket, listed or not, newest first."""
        runs = self.prefix + "runs/"
        ids = {
            p["Prefix"][len(runs):].rstrip("/")
            for page in self._list(runs, delimiter="/") for p in page.get("CommonPrefixes", [])
        }
        return sorted((i for i in ids if _RUN_RE.match(i)), reverse=True)

    def delete_run(self, run_id: str, pool: ThreadPoolExecutor) -> int:
        """Delete every object under a run: its run files, any it no longer uses, and any
        left in the schema-3 layout. One DeleteObject per key: R2 doesn't document the
        checksum that boto3 now sends with batch DeleteObjects."""
        keys = [o["Key"] for page in self._list(f"{self.prefix}runs/{run_id}/") for o in page.get("Contents", [])]
        list(pool.map(lambda k: self.client.delete_object(Bucket=self.bucket, Key=k), keys))
        return len(keys)


@dataclass
class SyncResult:
    uploaded: list[str] = field(default_factory=list)  # run file keys, under the product's prefix
    already_published: int = 0
    pruned: list[str] = field(default_factory=list)


def sync_to_r2(store: FrameStore, remote: R2Store, workers: int = R2_WORKERS) -> SyncResult:
    """Publish the local manifest to R2.

    1. Read the remote manifest, and check the local one was built from it:
       every run file it names is on disk or already in R2, and R2's manifest
       hasn't changed since.
    2. Upload the run files R2 doesn't have yet. Files already there are never
       rewritten (they're cached as immutable).
    3. Upload the manifest.
    4. Delete runs the manifest no longer lists (with every object under them).

    Any failure stops before the next step, so R2's manifest only ever names
    files that are there. A run file a rewritten run no longer uses stays until
    the run is deleted, so a visitor holding the older manifest can still read it.
    """
    payload = (store.root / "manifest.json").read_bytes()
    manifest = json.loads(payload)
    if remote.prefix != f"{manifest['product']}/":
        raise SyncError(f"manifest is for product {manifest['product']}, not {remote.prefix.rstrip('/')}")
    listed = listed_in(manifest)
    if not listed:
        raise SyncError("the manifest lists no frames; refusing to publish it")
    files = files_in(manifest)
    unnamed = sorted(r for r in listed if set(files.get(r, {})) != set(listed[r]))
    if unnamed:
        raise SyncError(f"the manifest doesn't name a run file for every field it lists, e.g. run {unnamed[0]}")

    current = remote.read_manifest()
    if current and current["generated_at"] > manifest["generated_at"]:
        raise SyncError(
            f"R2's manifest ({current['generated_at']}) is newer than this one ({manifest['generated_at']}); "
            "run `wxtrend update --remote` again"
        )
    published = file_keys(files_in(current))
    result = SyncResult()
    missing = []
    for key in sorted(file_keys(files)):
        if key in published:
            result.already_published += 1
        elif (store.root / key).is_file():
            result.uploaded.append(key)
        else:
            missing.append(key)
    if missing:
        raise SyncError(f"{len(missing)} run files the manifest names are neither on disk nor in R2, e.g. {missing[0]}")

    with ThreadPoolExecutor(workers) as pool:
        list(pool.map(lambda key: remote.put_file(key, (store.root / key).read_bytes()), result.uploaded))
        log.info("uploaded %d run files (%d already in R2)", len(result.uploaded), result.already_published)
        remote.put_manifest(payload)
        log.info("uploaded manifest: latest %s, %d runs", manifest["latest"], len(listed))
        for run_id in remote.run_ids():
            if run_id not in listed:
                n = remote.delete_run(run_id, pool)
                result.pruned.append(run_id)
                log.info("deleted run %s from R2 (%d objects)", run_id, n)
    return result
