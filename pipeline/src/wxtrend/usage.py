"""Storage alarms (build plan decision 26): what the public bucket and the
archive hold, against a budget for each.

``wxtrend storage`` lists every object in both buckets, sums them by top-level
prefix (a product, or ``games``), and fails when a bucket is over its budget
(``pipeline.storage_budget_gb`` in config/site.json). ``storage.yml`` runs it
daily, and a failed scheduled run gets GitHub to send an email. An
alarm means deciding what to do, never deleting: the archive is kept whole,
and its budget is a line raised by hand as it grows.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .store import list_pages

GB = 1e9


@dataclass
class BucketUsage:
    name: str  # "public" or "archive", as in the budget
    bucket: str
    budget_gb: float
    by_prefix: dict[str, list[int]] = field(default_factory=dict)  # top-level prefix -> [objects, bytes]

    @property
    def objects(self) -> int:
        return sum(n for n, _ in self.by_prefix.values())

    @property
    def bytes(self) -> int:
        return sum(b for _, b in self.by_prefix.values())

    @property
    def over(self) -> bool:
        return self.bytes > self.budget_gb * GB


def bucket_usage(client, name: str, bucket: str, budget_gb: float) -> BucketUsage:
    """Every object in ``bucket``, summed by the first part of its key."""
    usage = BucketUsage(name, bucket, budget_gb)
    for page in list_pages(client, bucket, ""):
        for obj in page.get("Contents", []):
            top = obj["Key"].split("/", 1)[0] if "/" in obj["Key"] else ""  # "": at the bucket's root
            counts = usage.by_prefix.setdefault(top, [0, 0])
            counts[0] += 1
            counts[1] += obj["Size"]
    return usage


def report(usages: list[BucketUsage]) -> str:
    """A Markdown table for the job summary: each bucket's total, then its prefixes."""
    lines = ["| Bucket | Prefix | Objects | Size | Budget |", "|---|---|---:|---:|---:|"]
    for u in usages:
        flag = " **over budget**" if u.over else ""
        share = f" ({u.bytes / (u.budget_gb * GB):.0%})" if u.budget_gb > 0 else ""
        lines.append(f"| **{u.name}** (`{u.bucket}`) | all | {u.objects:,} | {u.bytes / GB:.2f} GB | "
                     f"{u.budget_gb:g} GB{share}{flag} |")
        for prefix, (n, b) in sorted(u.by_prefix.items(), key=lambda kv: -kv[1][1]):
            lines.append(f"| | {f'`{prefix}/`' if prefix else '(root)'} | {n:,} | {b / GB:.2f} GB | |")
    return "\n".join(lines)
