"""An in-memory stand-in for the slice of boto3's S3 client that R2Store uses."""

from __future__ import annotations

import io
import threading

from botocore.exceptions import ClientError


class FakeS3:
    def __init__(self, bucket: str = "test-bucket", page_size: int = 1000):
        self.bucket = bucket
        self.page_size = page_size  # R2 returns at most 1000 keys per listing page
        self.objects: dict[str, dict] = {}
        self.ops: list[tuple[str, str]] = []  # ("put" | "delete", key), in call order
        self.fail_puts: set[str] = set()
        self._lock = threading.Lock()

    def _check(self, bucket: str) -> None:
        assert bucket == self.bucket, f"wrong bucket {bucket!r}"

    def get_object(self, Bucket, Key):
        self._check(Bucket)
        with self._lock:
            obj = self.objects.get(Key)
        if obj is None:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "The specified key does not exist."}}, "GetObject")
        return {"Body": io.BytesIO(obj["Body"]), "ContentType": obj["ContentType"], "CacheControl": obj["CacheControl"]}

    def put_object(self, Bucket, Key, Body, ContentType, CacheControl):
        self._check(Bucket)
        with self._lock:
            self.ops.append(("put", Key))
            if Key in self.fail_puts:
                raise ClientError({"Error": {"Code": "InternalError", "Message": "boom"}}, "PutObject")
            self.objects[Key] = {"Body": bytes(Body), "ContentType": ContentType, "CacheControl": CacheControl}
        return {}

    def delete_object(self, Bucket, Key):
        self._check(Bucket)
        with self._lock:
            self.ops.append(("delete", Key))
            self.objects.pop(Key, None)
        return {}

    def list_objects_v2(self, Bucket, Prefix, Delimiter=None, ContinuationToken=None):
        """S3 listing semantics: keys under Prefix; with Delimiter, keys that
        continue past it roll up into CommonPrefixes. Paginated."""
        self._check(Bucket)
        with self._lock:
            keys = sorted(k for k in self.objects if k.startswith(Prefix))
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
        page = entries[start:start + self.page_size]
        out = {
            "Contents": [{"Key": k} for k, is_prefix in page if not is_prefix],
            "CommonPrefixes": [{"Prefix": k} for k, is_prefix in page if is_prefix],
            "IsTruncated": start + self.page_size < len(entries),
        }
        if out["IsTruncated"]:
            out["NextContinuationToken"] = str(start + self.page_size)
        return out

    # helpers for assertions
    def keys(self, prefix: str = "") -> set[str]:
        return {k for k in self.objects if k.startswith(prefix)}

    def puts(self) -> list[str]:
        return [k for op, k in self.ops if op == "put"]
