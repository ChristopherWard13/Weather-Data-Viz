"""Command-line entry point: ``wxtrend update | fetch | verify | sync | inspect``.

Each product's local store is ``<data-dir>/<product>/``, the same layout as the
R2 bucket. ``update --remote``, ``verify --remote`` and ``sync`` reach R2 with
the R2_* environment variables (see store.R2Store).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .alignment import pair
from .config import REPO_ROOT, Product, load_config
from .cycles import cycle_id, find_latest_complete_cycle, http_exists_fn, parse_cycle_id
from .fields import decode_band
from .manifest import build_manifest, load_schema, write_manifest
from .store import FrameStore, R2Store, SyncError, listed_in, sync_to_r2
from .update import Job, NoCompleteCycle, UpdateResult, fetch_frames, run_update

log = logging.getLogger("wxtrend")

DEFAULT_DATA_DIR = Path(os.environ.get("WXTREND_DATA_DIR", REPO_ROOT / "data"))
DEFAULT_PRODUCT = "gfs"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="wxtrend", description=__doc__)
    parser.add_argument("--config", help="path to the config directory (default: config/ at the repo root)")
    parser.add_argument(
        "--data-dir", type=Path, default=DEFAULT_DATA_DIR,
        help="data root; each product is stored in <data-dir>/<product>/ (default: data/ at the repo root, or $WXTREND_DATA_DIR)",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--product", default=DEFAULT_PRODUCT, help=f"product id (default: {DEFAULT_PRODUCT})")

    p = sub.add_parser("update", parents=[common], help="process the latest complete cycle and its retention window")
    p.add_argument("--cycle", help="treat this cycle (YYYYMMDDHH) as the latest instead of detecting it")
    p.add_argument("--now", help="pretend the current time is this ISO timestamp (UTC)")
    p.add_argument("--quick", action="store_true", help="fetch only the runs the latest run is compared against")
    p.add_argument("--hours", help="only these forecast hours, e.g. '0-60' (default: the product's full range)")
    p.add_argument("--remote", action="store_true",
                   help="treat frames listed in R2's manifest as present; the new manifest lists them too (publish with sync)")

    p = sub.add_parser("fetch", parents=[common], help="fetch specific frames (e.g. a one-hour dry run)")
    p.add_argument("--cycle", required=True, help="YYYYMMDDHH, or 'latest' for the latest complete cycle")
    p.add_argument("--hours", required=True, help="e.g. '0', '0,6,12', '0-48', or 'all'")
    p.add_argument("--fields", help="comma-separated field ids (default: all)")

    p = sub.add_parser("verify", parents=[common], help="check the manifest against the schema and every frame's size")
    p.add_argument("--remote", action="store_true", help="accept listed frames that aren't on disk if R2's manifest lists them")

    sub.add_parser("sync", parents=[common],
                   help="publish the local manifest to R2: upload new frames, then the manifest, then delete dropped runs")

    p = sub.add_parser("inspect", parents=[common], help="print Δ statistics for one band of one frame pair")
    p.add_argument("--run", help="current run id (default: latest)")
    p.add_argument("--fhr", type=int, required=True)
    p.add_argument("--lag", type=int, required=True)
    p.add_argument("--field", default="upper")
    p.add_argument("--band", default="speed")

    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    for noisy in ("urllib3", "herbie", "cfgrib"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    product = load_config(args.config).product(args.product)
    store = FrameStore(args.data_dir / product.id)
    handler = {"update": cmd_update, "fetch": cmd_fetch, "verify": cmd_verify, "sync": cmd_sync, "inspect": cmd_inspect}
    try:
        return handler[args.command](product, store, args)
    except SyncError as e:
        log.error("%s", e)
        return 1


def cmd_update(product: Product, store: FrameStore, args) -> int:
    from .fetch import fetch_hour

    now = _parse_now(args.now)
    latest = parse_cycle_id(args.cycle) if args.cycle else None
    hours = parse_hours(args.hours, product) if args.hours else None
    published = None
    if args.remote:
        published = R2Store.from_env(product.id).read_manifest() or {}
        log.info("R2 manifest: %s", f"latest {published['latest']}, generated {published['generated_at']}"
                 if published else "none yet")
    try:
        result = run_update(
            product, store, now=now, exists=http_exists_fn(), fetch=fetch_hour, latest=latest,
            quick=args.quick, hours=hours, executor="process", published=published,
        )
    except NoCompleteCycle as e:
        log.error("%s", e)
        _github_output(changed="false")
        return 1

    log.info(
        "latest=%s frames fetched=%d failed hours=%d pruned=%d changed=%s",
        result.latest, len(result.fetched), len(result.failed), len(result.pruned), result.changed,
    )
    _github_output(changed=str(result.changed).lower(), latest=result.latest)
    if result.failed and not result.fetched:
        return 1
    return 0


def cmd_fetch(product: Product, store: FrameStore, args) -> int:
    from .fetch import fetch_hour

    exists = http_exists_fn()
    hours = parse_hours(args.hours, product)
    field_ids = args.fields.split(",") if args.fields else [f.id for f in product.fields]
    for fid in field_ids:
        product.field(fid)  # KeyError on typos
    if args.cycle == "latest":
        init = find_latest_complete_cycle(product, datetime.now(timezone.utc), exists, hours)
        if init is None:
            log.error("no complete cycle found for hours %s", hours)
            return 1
    else:
        init = parse_cycle_id(args.cycle)
    run_id = cycle_id(init)
    jobs = []
    for f in hours:
        need = tuple(x.id for x in product.fields_for_hour(f) if x.id in field_ids)
        if need:
            jobs.append(Job(init, run_id, f, need))
    result = UpdateResult(latest=run_id, targets=[run_id])
    fetch_frames(product, store, jobs, fetch_hour, result, time.sleep, executor="process")
    write_manifest(store, build_manifest(product, store.listing([f.id for f in product.fields])))
    shape = (product.grid.ny, product.grid.nx)
    for rid, f, fid in result.fetched:
        spec = product.field(fid)
        path = store.frame_path(rid, fid, f)
        bands = store.read_frame(rid, spec, f, shape)
        summary = ", ".join(
            f"{b.name} {np.nanmin(decode_band(bands[b.name], b)):.4g}..{np.nanmax(decode_band(bands[b.name], b)):.4g} {b.units}"
            for b in spec.bands
        )
        log.info("wrote %s: %d bytes gzipped, %d bytes raw; %s",
                 path.relative_to(store.root), path.stat().st_size, spec.frame_bytes(shape[1], shape[0]), summary)
    for rid, f, err in result.failed:
        log.error("%s f%03d failed: %s", rid, f, err)
    return 1 if result.failed else 0


def cmd_verify(product: Product, store: FrameStore, args) -> int:
    import jsonschema

    path = store.root / "manifest.json"
    manifest = json.loads(path.read_text())
    jsonschema.validate(manifest, load_schema())
    published = listed_in(R2Store.from_env(product.id).read_manifest()) if args.remote else {}
    problems = []

    grid = manifest["grid"]
    if manifest["product"] != product.id:
        problems.append(f"manifest is for product {manifest['product']}, not {product.id}")
    if (grid["id"], grid["nx"], grid["ny"]) != (product.grid.id, product.grid.nx, product.grid.ny):
        problems.append(
            f"grid {grid['id']} {grid['nx']}x{grid['ny']} != config {product.grid.id} {product.grid.nx}x{product.grid.ny}"
        )
    shape = (grid["ny"], grid["nx"])
    listed = set()
    total_bytes = 0
    in_r2 = 0
    for run in manifest["runs"]:
        for fid, hours in run["hours"].items():
            spec = product.field(fid)
            for f in hours:
                listed.add((run["id"], fid, f))
                if not store.frame_path(run["id"], fid, f).exists() and f in published.get(run["id"], {}).get(fid, ()):
                    in_r2 += 1  # checked when it was uploaded
                    continue
                try:
                    store.read_frame(run["id"], spec, f, shape)
                    total_bytes += store.frame_path(run["id"], fid, f).stat().st_size
                except (OSError, ValueError) as e:
                    problems.append(f"{run['id']} {fid} f{f:03d}: {e}")
    on_disk = {(r, f.id, h) for r in store.run_ids() for f in product.fields for h in store.hours(r, f.id)}
    if on_disk - listed:
        problems.append(f"{len(on_disk - listed)} frames on disk are missing from the manifest")

    for p in problems:
        log.error("%s", p)
    log.info(
        "%s: %d runs, %d frames (%d on disk, %.1f MB; %d already in R2), %s",
        path, len(manifest["runs"]), len(listed), len(listed) - in_r2, total_bytes / 1e6, in_r2,
        "OK" if not problems else f"{len(problems)} problems",
    )
    return 1 if problems else 0


def cmd_sync(product: Product, store: FrameStore, args) -> int:
    import jsonschema

    jsonschema.validate(json.loads((store.root / "manifest.json").read_text()), load_schema())
    result = sync_to_r2(store, R2Store.from_env(product.id))
    _github_summary(
        f"**{product.id}** → R2: {len(result.uploaded)} frames uploaded, {result.already_published} already there, "
        f"runs deleted: {', '.join(result.pruned) or 'none'}"
    )
    return 0


def cmd_inspect(product: Product, store: FrameStore, args) -> int:
    run_id = args.run or (store.run_ids() or [None])[0]
    if run_id is None:
        log.error("no runs in %s", store.root)
        return 1
    spec = product.field(args.field)
    band = next(b for b in spec.bands if b.name == args.band)
    p = pair(parse_cycle_id(run_id), args.fhr, args.lag)
    older_id = cycle_id(p.older_init)
    shape = (product.grid.ny, product.grid.nx)
    print(f"field    {spec.id}.{band.name} ({band.units})")
    print(f"valid    {p.valid:%Y-%m-%d %HZ}")
    print(f"current  {run_id} F{p.current_fhr:03d}")
    print(f"older    {older_id} F{p.older_fhr:03d}")
    try:
        cur = decode_band(store.read_frame(run_id, spec, p.current_fhr, shape)[band.name], band)
        old = decode_band(store.read_frame(older_id, spec, p.older_fhr, shape)[band.name], band)
    except FileNotFoundError as e:
        print(f"comparison unavailable: {e.filename}")
        return 1
    d = cur - old
    lat = lambda i: product.grid.lat_max - i * product.grid.resolution  # noqa: E731
    lon = lambda j: product.grid.lon_min + j * product.grid.resolution  # noqa: E731
    for name, arr in (("current", cur), ("older", old), ("delta", d)):
        imax = np.unravel_index(np.argmax(arr), arr.shape)
        imin = np.unravel_index(np.argmin(arr), arr.shape)
        print(
            f"{name:8s} min {arr[imin]:8.2f} at ({lat(imin[0]):.2f}, {lon(imin[1]):.2f})   "
            f"max {arr[imax]:8.2f} at ({lat(imax[0]):.2f}, {lon(imax[1]):.2f})"
        )
    print(f"mean |delta| {np.abs(d).mean():.2f} {band.units}")
    return 0


def parse_hours(spec: str, product: Product) -> list[int]:
    if spec == "all":
        return product.fetch_hours
    hours: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            lo, hi = (int(x) for x in part.split("-", 1))
            hours.update(range(lo, hi + 1, product.fhr_step))
        else:
            hours.add(int(part))
    bad = [h for h in hours if h % product.fhr_step]
    if bad:
        raise SystemExit(f"hours must be multiples of {product.fhr_step}: {sorted(bad)}")
    return sorted(hours)


def _parse_now(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _github_summary(line: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write(line + "\n")


def _github_output(**values: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a") as f:
        for k, v in values.items():
            f.write(f"{k}={v}\n")


if __name__ == "__main__":
    sys.exit(main())
