"""An in-memory stand-in for the slice of boto3's S3 client that R2Store uses.

One FakeS3 is one bucket. ``link`` lets one client reach another bucket too, as
the archive's token reaches both the public bucket and the archive: a call
naming the other bucket acts on that FakeS3's objects.
"""

from __future__ import annotations

import io
import threading

from botocore.exceptions import ClientError


class FakeS3:
    def __init__(self, bucket: str = "test-bucket", page_size: int = 1000):
        self.bucket = bucket
        self.page_size = page_size  # R2 returns at most 1000 keys per listing page
        self.objects: dict[str, dict] = {}
        self.ops: list[tuple[str, str]] = []  # ("put" | "copy" | "delete", key), in call order
        self.gets: list[tuple[str, str | None]] = []  # (key, Range or None): reads, kept apart from writes
        self.fail_puts: set[str] = set()  # keys (or key prefixes) whose put or copy fails
        self._lock = threading.Lock()
        self._buckets: dict[str, FakeS3] = {bucket: self}

    def link(self, other: FakeS3) -> FakeS3:
        """Let this client reach ``other``'s bucket; returns self."""
        self._buckets[other.bucket] = other
        return self

    def _at(self, bucket: str) -> FakeS3:
        assert bucket in self._buckets, f"wrong bucket {bucket!r}"
        return self._buckets[bucket]

    def get_object(self, Bucket, Key, Range=None):
        """With ``Range`` ("bytes=a-b"), bytes a to b inclusive, or fewer if the object ends sooner."""
        b = self._at(Bucket)
        with b._lock:
            obj = b.objects.get(Key)
            b.gets.append((Key, Range))
        if obj is None:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "The specified key does not exist."}}, "GetObject")
        body = obj["Body"]
        if Range is not None:
            start, end = (int(x) for x in Range.removeprefix("bytes=").split("-"))
            if start >= len(body):
                raise ClientError({"Error": {"Code": "InvalidRange", "Message": "416"}}, "GetObject")
            body = body[start:end + 1]
        return {"Body": io.BytesIO(body), "ContentType": obj["ContentType"], "CacheControl": obj["CacheControl"]}

    def put_object(self, Bucket, Key, Body, ContentType, CacheControl):
        b = self._at(Bucket)
        with b._lock:
            b.ops.append(("put", Key))
            if b._fails(Key):
                raise ClientError({"Error": {"Code": "InternalError", "Message": "boom"}}, "PutObject")
            b.objects[Key] = {"Body": bytes(Body), "ContentType": ContentType, "CacheControl": CacheControl}
        return {}

    def copy_object(self, Bucket, Key, CopySource):
        """Server-side copy; the metadata comes along (S3's default COPY directive)."""
        src, b = self._at(CopySource["Bucket"]), self._at(Bucket)
        with src._lock:
            obj = src.objects.get(CopySource["Key"])
        if obj is None:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "The specified key does not exist."}}, "CopyObject")
        with b._lock:
            b.ops.append(("copy", Key))
            if b._fails(Key):
                raise ClientError({"Error": {"Code": "InternalError", "Message": "boom"}}, "CopyObject")
            b.objects[Key] = dict(obj)
        return {}

    def _fails(self, key: str) -> bool:
        return any(key.startswith(p) for p in self.fail_puts)

    def delete_object(self, Bucket, Key):
        b = self._at(Bucket)
        with b._lock:
            b.ops.append(("delete", Key))
            b.objects.pop(Key, None)
        return {}

    def list_objects_v2(self, Bucket, Prefix, Delimiter=None, ContinuationToken=None):
        """S3 listing semantics: keys under Prefix; with Delimiter, keys that
        continue past it roll up into CommonPrefixes. Paginated."""
        b = self._at(Bucket)
        with b._lock:
            keys = sorted(k for k in b.objects if k.startswith(Prefix))
        entries: list[tuple[str, bool]] = []  # (key or common prefix, is_prefix)
        for k in keys:
            rest = k[len(Prefix):]
            if Delimiter and Delimiter in rest:
                cp = Prefix + rest.split(Delimiter, 1)[0] + Delimiter
                if not entries or entries[-1] != (cp, True):
                    entries.append((cp, True))
            else:
                entries.append((k, False))
        start = int(ContinuationToken or 0)
        page = entries[start:start + b.page_size]
        out = {
            "Contents": [{"Key": k} for k, is_prefix in page if not is_prefix],
            "CommonPrefixes": [{"Prefix": k} for k, is_prefix in page if is_prefix],
            "IsTruncated": start + b.page_size < len(entries),
        }
        if out["IsTruncated"]:
            out["NextContinuationToken"] = str(start + b.page_size)
        return out

    # helpers for assertions
    def keys(self, prefix: str = "") -> set[str]:
        return {k for k in self.objects if k.startswith(prefix)}

    def puts(self) -> list[str]:
        return [k for op, k in self.ops if op == "put"]

    def copies(self) -> list[str]:
        return [k for op, k in self.ops if op == "copy"]
