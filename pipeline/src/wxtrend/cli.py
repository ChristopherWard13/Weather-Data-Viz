"""Command-line entry point: ``wxtrend update | fetch | verify | inspect``."""

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
from .config import REPO_ROOT, Config, load_config
from .cycles import cycle_id, find_latest_complete_cycle, http_exists_fn, parse_cycle_id
from .fields import delta_kt
from .manifest import build_manifest, load_schema, write_manifest
from .store import FrameStore
from .update import NoCompleteCycle, UpdateResult, fetch_frames, run_update

log = logging.getLogger("wxtrend")

DEFAULT_DATA_DIR = Path(os.environ.get("WXTREND_DATA_DIR", REPO_ROOT / "data"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="wxtrend", description=__doc__)
    parser.add_argument("--config", help="path to config.json (default: repo root)")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("update", help="process the latest complete cycle and its retention window")
    p.add_argument("--cycle", help="treat this cycle (YYYYMMDDHH) as the latest instead of detecting it")
    p.add_argument("--now", help="pretend the current time is this ISO timestamp (UTC)")
    p.add_argument("--quick", action="store_true", help="keep only the runs the latest run is compared against")

    p = sub.add_parser("fetch", help="fetch specific frames (e.g. a one-hour dry run)")
    p.add_argument("--cycle", required=True, help="YYYYMMDDHH, or 'latest' for the latest complete cycle")
    p.add_argument("--hours", required=True, help="e.g. '0', '0,6,12', '0-48', or 'all'")

    sub.add_parser("verify", help="check the manifest against the schema and every frame's size")

    p = sub.add_parser("inspect", help="print Δ statistics for one frame pair")
    p.add_argument("--run", help="current run id (default: latest)")
    p.add_argument("--fhr", type=int, required=True)
    p.add_argument("--lag", type=int, required=True)

    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    for noisy in ("urllib3", "herbie", "cfgrib"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    cfg = load_config(args.config)
    store = FrameStore(args.data_dir)
    handler = {"update": cmd_update, "fetch": cmd_fetch, "verify": cmd_verify, "inspect": cmd_inspect}
    return handler[args.command](cfg, store, args)


def cmd_update(cfg: Config, store: FrameStore, args) -> int:
    from .fetch import fetch_frame

    now = _parse_now(args.now)
    latest = parse_cycle_id(args.cycle) if args.cycle else None
    try:
        result = run_update(
            cfg, store, now=now, exists=http_exists_fn(), fetch=fetch_frame, latest=latest, quick=args.quick
        )
    except NoCompleteCycle as e:
        log.error("%s", e)
        _github_output(changed="false")
        return 1

    log.info(
        "latest=%s fetched=%d failed=%d pruned=%d changed=%s",
        result.latest, len(result.fetched), len(result.failed), len(result.pruned), result.changed,
    )
    _github_output(changed=str(result.changed).lower(), latest=result.latest)
    if result.failed and not result.fetched:
        return 1
    return 0


def cmd_fetch(cfg: Config, store: FrameStore, args) -> int:
    from .fetch import fetch_frame

    exists = http_exists_fn()
    hours = parse_hours(args.hours, cfg)
    if args.cycle == "latest":
        init = find_latest_complete_cycle(cfg, datetime.now(timezone.utc), exists, hours)
        if init is None:
            log.error("no complete cycle found for hours %s", hours)
            return 1
    else:
        init = parse_cycle_id(args.cycle)
    run_id = cycle_id(init)
    result = UpdateResult(latest=run_id, targets=[run_id])
    fetch_frames(cfg, store, [(init, run_id, f) for f in hours], fetch_frame, result, time.sleep)
    write_manifest(store, build_manifest(cfg, store))
    for rid, f in result.fetched:
        path = store.frame_path(rid, f)
        frame = store.read_frame(rid, f, (cfg.domain.ny, cfg.domain.nx))
        log.info(
            "wrote %s: %d bytes gzipped, %d bytes raw (%d x %d), speed %d..%d kt",
            path.relative_to(store.root), path.stat().st_size, frame.size,
            frame.shape[0], frame.shape[1], frame.min(), frame.max(),
        )
    for rid, f, err in result.failed:
        log.error("%s f%03d failed: %s", rid, f, err)
    return 1 if result.failed else 0


def cmd_verify(cfg: Config, store: FrameStore, args) -> int:
    import jsonschema

    path = store.root / "manifest.json"
    manifest = json.loads(path.read_text())
    jsonschema.validate(manifest, load_schema())
    problems = []

    grid = manifest["grid"]
    if (grid["nx"], grid["ny"]) != (cfg.domain.nx, cfg.domain.ny):
        problems.append(f"grid {grid['nx']}x{grid['ny']} != config {cfg.domain.nx}x{cfg.domain.ny}")
    shape = (grid["ny"], grid["nx"])
    listed = set()
    total_bytes = 0
    for run in manifest["runs"]:
        for f in run["hours"]:
            listed.add((run["id"], f))
            try:
                store.read_frame(run["id"], f, shape)
                total_bytes += store.frame_path(run["id"], f).stat().st_size
            except (OSError, ValueError) as e:
                problems.append(str(e))
    on_disk = {(r, f) for r in store.run_ids() for f in store.hours(r)}
    if on_disk - listed:
        problems.append(f"{len(on_disk - listed)} frames on disk are missing from the manifest")

    for p in problems:
        log.error("%s", p)
    log.info(
        "%s: %d runs, %d frames, %.1f MB, %s",
        path, len(manifest["runs"]), len(listed), total_bytes / 1e6,
        "OK" if not problems else f"{len(problems)} problems",
    )
    return 1 if problems else 0


def cmd_inspect(cfg: Config, store: FrameStore, args) -> int:
    run_id = args.run or (store.run_ids() or [None])[0]
    if run_id is None:
        log.error("no runs in %s", store.root)
        return 1
    p = pair(parse_cycle_id(run_id), args.fhr, args.lag)
    older_id = cycle_id(p.older_init)
    shape = (cfg.domain.ny, cfg.domain.nx)
    print(f"valid    {p.valid:%Y-%m-%d %HZ}")
    print(f"current  {run_id} F{p.current_fhr:03d}")
    print(f"older    {older_id} F{p.older_fhr:03d}")
    try:
        cur = store.read_frame(run_id, p.current_fhr, shape)
        old = store.read_frame(older_id, p.older_fhr, shape)
    except FileNotFoundError as e:
        print(f"comparison unavailable: {e.filename}")
        return 1
    d = delta_kt(cur, old)
    lat = lambda i: cfg.domain.lat_max - i * cfg.domain.resolution  # noqa: E731
    lon = lambda j: cfg.domain.lon_min + j * cfg.domain.resolution  # noqa: E731
    for name, arr in (("current |V|", cur), ("older |V|", old), ("delta", d)):
        imax = np.unravel_index(np.argmax(arr), arr.shape)
        imin = np.unravel_index(np.argmin(arr), arr.shape)
        print(
            f"{name:12s} min {int(arr[imin]):5d} kt at ({lat(imin[0]):.2f}, {lon(imin[1]):.2f})   "
            f"max {int(arr[imax]):5d} kt at ({lat(imax[0]):.2f}, {lon(imax[1]):.2f})"
        )
    print(f"mean |delta| {np.abs(d).mean():.1f} kt")
    return 0


def parse_hours(spec: str, cfg: Config) -> list[int]:
    if spec == "all":
        return cfg.fetch_hours
    hours: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            lo, hi = (int(x) for x in part.split("-", 1))
            hours.update(range(lo, hi + 1, cfg.fhr_step))
        else:
            hours.add(int(part))
    bad = [h for h in hours if h % cfg.fhr_step]
    if bad:
        raise SystemExit(f"hours must be multiples of {cfg.fhr_step}: {sorted(bad)}")
    return sorted(hours)


def _parse_now(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _github_output(**values: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a") as f:
        for k, v in values.items():
            f.write(f"{k}={v}\n")


if __name__ == "__main__":
    sys.exit(main())
