"""Command-line entry point: ``wxtrend update | fetch | verify | sync | archive | repack | inspect | game | storage``.

Each product's local store is ``<data-dir>/<product>/``, the same layout as the
R2 bucket. ``update --remote``, ``verify --remote`` and ``sync`` reach R2 with
the R2_* environment variables (see store.R2Store); ``archive`` with the
ARCHIVE_* ones as well (see archive.py). ``game`` makes a daily game's puzzle
under ``<data-dir>/games/`` (see games/). ``storage`` checks both buckets'
sizes against their budgets, with the archive's token (see usage.py).
"""

from __future__ import annotations

import argparse
import gzip
import json
import logging
import multiprocessing
import os
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .alignment import pair
from .config import DEFAULT_CONFIG_DIR, REPO_ROOT, Product, load_config
from .cycles import cycle_id, exists_fn_for, find_latest_complete_cycle, parse_cycle_id
from .fields import decode_band
from .manifest import build_manifest, config_drift, load_schema, read_manifest, write_manifest
from .store import (
    FILE_TEMPLATE, FrameStore, R2Store, SyncError, decode_frame, file_keys, files_in, r2_client, require_env,
    run_file_name, sync_to_r2, unpack_frames,
)
from .update import Job, NoCompleteCycle, UpdateResult, fetch_frames, pack_runs, repack, run_update

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

    p = sub.add_parser("verify", parents=[common], help="check the manifest against the schema and every run file's frames")
    p.add_argument("--remote", action="store_true", help="accept run files that aren't on disk if R2's manifest names them")

    sub.add_parser("sync", parents=[common],
                   help="publish the local manifest to R2: upload new frames, then the manifest, then delete dropped runs")

    sub.add_parser("archive", parents=[common],
                   help="copy into the private archive the frames it should keep but doesn't, from the public bucket")

    sub.add_parser("repack", parents=[common],
                   help="pack the local store's frames into run files and rewrite its manifest, without fetching "
                        "(converts a store in the schema-3 layout, such as an e2e fixture bundle)")

    p = sub.add_parser("inspect", parents=[common], help="print Δ statistics for one band of one frame pair")
    p.add_argument("--run", help="current run id (default: latest)")
    p.add_argument("--fhr", type=int, required=True)
    p.add_argument("--lag", type=int, required=True)
    p.add_argument("--field", default="upper")
    p.add_argument("--band", default="speed")

    p = sub.add_parser("game", help="make a daily game's puzzle (build plan Phase G)")
    p.add_argument("game", choices=["spot", "measured", "station", "beat"],
                   help="spot: Wx Marks the Spot; measured: Modeled or Measured; station: Station ID (after spot); "
                        "beat: Beat the Models (after station: the verdicts up to the day, the next day's models' "
                        "calls, and the puzzle for the day after)")
    p.add_argument("--date", help="the day the puzzle is about, YYYY-MM-DD (default: the newest day ended in the Lower 48)")
    p.add_argument("--now", help="pretend the current time is this ISO timestamp (UTC)")
    p.add_argument("--publish", action="store_true", help="also upload it to R2 (the R2_* environment variables)")
    p.add_argument("--replace", action="store_true",
                   help="with --publish, replace a day R2 already has (by default it's left alone: people may be playing it)")
    p.add_argument("--no-maps", action="store_true", help="spot: skip the GFS maps under each round's reveal (quicker)")
    p.add_argument("--station-follows", action="store_true",
                   help="spot with --replace: Station ID's puzzle for the day will be remade next, so its fields may change")

    sub.add_parser("storage", help="sum what the public bucket and the archive hold, and fail if either is over "
                                   "its budget (pipeline.storage_budget_gb in site.json)")

    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    for noisy in ("urllib3", "herbie", "cfgrib"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    if args.command == "game":
        return cmd_game(args)
    if args.command == "storage":
        return cmd_storage(args)

    product = load_config(args.config).product(args.product)
    store = FrameStore(args.data_dir / product.id)
    handler = {
        "update": cmd_update, "fetch": cmd_fetch, "verify": cmd_verify, "sync": cmd_sync, "archive": cmd_archive,
        "repack": cmd_repack, "inspect": cmd_inspect,
    }
    try:
        return handler[args.command](product, store, args)
    except SyncError as e:
        log.error("%s", e)
        return 1


def cmd_storage(args) -> int:
    from .archive import ARCHIVE_ENV
    from .usage import GB, bucket_usage, report

    config_dir = Path(args.config or os.environ.get("WXTREND_CONFIG") or DEFAULT_CONFIG_DIR)
    budgets = json.loads((config_dir / "site.json").read_text())["pipeline"]["storage_budget_gb"]
    try:
        require_env(ARCHIVE_ENV)
    except SyncError as e:
        log.error("%s", e)
        return 1
    # The archive's token reads both buckets
    client = r2_client(os.environ["ARCHIVE_ACCESS_KEY_ID"], os.environ["ARCHIVE_SECRET_ACCESS_KEY"])
    usages = [bucket_usage(client, "public", os.environ["R2_BUCKET"], budgets["public"]),
              bucket_usage(client, "archive", os.environ["ARCHIVE_BUCKET"], budgets["archive"])]
    for u in usages:
        log.log(logging.ERROR if u.over else logging.INFO, "%s (%s): %d objects, %.2f GB of a %g GB budget%s",
                u.name, u.bucket, u.objects, u.bytes / GB, u.budget_gb, " (over budget)" if u.over else "")
    _github_summary(report(usages))
    return 1 if any(u.over for u in usages) else 0


def cmd_game(args) -> int:
    from datetime import date

    from .games import daily

    newest = daily.default_day(_parse_now(args.now))
    day = date.fromisoformat(args.date) if args.date else newest
    if day > newest:
        log.error("%s hasn't ended everywhere in the Lower 48 yet (the newest day that has is %s)", day, newest)
        return 1
    if args.game == "station":
        from .games import station

        if day < station.EPOCH:
            # Before it, the pin game's fixed rounds show both temperatures: no first card
            log.info("Station ID starts on %s (#1); nothing to make for %s", station.EPOCH, day)
            _github_summary(f"Station ID {day}: before its first day ({station.EPOCH}); nothing made")
            return 0
    config_dir = Path(args.config or os.environ.get("WXTREND_CONFIG") or DEFAULT_CONFIG_DIR)
    if args.game == "beat":
        return cmd_beat(day, args, config_dir)
    regions = {r["id"]: r for r in json.loads((config_dir / "regions.json").read_text())["regions"]}
    remote = None
    if args.publish:
        try:
            remote = R2Store.from_env(f"games/{args.game}")
        except SyncError as e:
            log.error("%s", e)
            return 1
        if not args.replace and remote.read_json(f"{day.isoformat()}.json") is not None:
            caught_up = daily.catch_up_latest(remote, day.isoformat())
            log.info("%s is already published; leaving it (--replace to change it)%s", day,
                     "; latest.json was behind it and now points at it" if caught_up else "")
            _github_summary(f"{daily.NAMES[args.game]} {day}: already published" + ("; latest.json caught up" if caught_up else ""))
            return 0
    if args.game == "measured":
        puzzle = daily.make_measured(day, regions["us"], config_dir=config_dir)
    elif args.game == "station":
        spot_puzzle = _spot_puzzle(day, args, regions["us"], config_dir)
        if spot_puzzle is None:
            log.error("Wx Marks the Spot's puzzle for %s isn't published yet: Station ID leaves out its fields, "
                      "so it's made second", day)
            return 1
        read = _reader(args, "station")
        beat = _reader(args, "beat")
        puzzle = daily.make_station(day, regions["us"], spot_puzzle, lambda d: read(d.isoformat()), config_dir,
                                    beat_puzzle=lambda d: beat(d.isoformat()))
    else:
        puzzle = daily.make_spot(day, regions["us"], with_maps=not args.no_maps, config_dir=config_dir)
        clash = _station_clash(day, args, puzzle)
        if clash:
            log.error("%s", clash)
            return 1
    log.info("wrote %s", ", ".join(daily.write(args.data_dir, puzzle)))
    if remote is not None:
        log.info("published %s", ", ".join(daily.publish(puzzle, remote)))
    line = daily.summary(puzzle)
    log.info("%s", line)
    _github_summary(line)
    return 0


def cmd_beat(day, args, config_dir: Path) -> int:
    """Beat the Models: its three steps for ``day``, the newest day ended (see daily.run_beat). Fails if
    any step did, after trying them all."""
    from .games import daily

    try:
        remote = R2Store.from_env("games/beat") if args.publish else None
        station_remote = R2Store.from_env("games/station") if args.publish else None
    except SyncError as e:
        log.error("%s", e)
        return 1
    lines, errors = daily.run_beat(
        day, daily.GameFiles(args.data_dir, "beat", remote), daily.GameFiles(args.data_dir, "station", station_remote),
        config_dir, _parse_now(args.now), replace=args.replace)
    for line in lines:
        log.info("%s", line)
        _github_summary(line)
    for e in errors:
        log.error("%s", e)
        _github_summary(f"Beat the Models: {e}")
    return 1 if errors else 0


def _reader(args, game: str):
    """A game's published puzzles by date ("YYYY-MM-DD"), or None: R2's when publishing, else the data dir's."""
    if args.publish:
        remote = R2Store.from_env(f"games/{game}")
        return lambda day: remote.read_json(f"{day}.json")
    root = args.data_dir / "games" / game
    return lambda day: json.loads((root / f"{day}.json").read_text()) if (root / f"{day}.json").exists() else None


def _spot_puzzle(day, args, area: dict, config_dir: Path) -> dict | None:
    """Wx Marks the Spot's puzzle for ``day``: R2's when publishing, else the data dir's, else made here."""
    from .games import daily

    found = _reader(args, "spot")(day.isoformat())
    if found is not None or args.publish:
        return found
    log.info("no Wx Marks the Spot puzzle for %s in the data dir; making one (without maps) to see its fields", day)
    return daily.make_spot(day, area, with_maps=False, config_dir=config_dir)


def _station_clash(day, args, spot_puzzle: dict) -> str | None:
    """Why a remade pin game puzzle can't be kept: it shows a field the day's Station ID already uses.

    The dry-day swap follows the data, which IEM keeps filling in, so a remake
    can show different families. Remake both (``--station-follows``, which the
    workflow passes when it makes every game) or neither."""
    from .games import draft

    if not args.replace or args.station_follows:
        return None
    made = _reader(args, "station")(day.isoformat())
    if made is None or set(made.get("spot", [])) == draft.families_shown(spot_puzzle):
        return None
    return (f"Wx Marks the Spot for {day} would now show {sorted(draft.families_shown(spot_puzzle))}, but Station ID's "
            f"puzzle for the day was made beside {sorted(made.get('spot', []))}; remake both (game all) or neither")


def cmd_update(product: Product, store: FrameStore, args) -> int:
    from .fetch import fetch_hour

    now = _parse_now(args.now)
    latest = parse_cycle_id(args.cycle) if args.cycle else None
    hours = parse_hours(args.hours, product) if args.hours else None
    published = read_remote = None
    if args.remote:
        remote = R2Store.from_env(product.id)
        published = remote.read_manifest() or {}
        read_remote = remote.get_bytes
        log.info("R2 manifest: %s", f"schema {published['schema_version']}, latest {published['latest']}, "
                 f"generated {published['generated_at']}" if published else "none yet")
    try:
        result = run_update(
            product, store, now=now, exists=exists_fn_for(product), fetch=fetch_hour, latest=latest,
            quick=args.quick, hours=hours, executor="process", published=published, read_remote=read_remote,
        )
    except NoCompleteCycle as e:
        log.error("%s", e)
        _github_output(changed="false")
        return 1

    log.info(
        "latest=%s frames fetched=%d failed hours=%d gone from the source: %d hours, %d runs; run files written=%d "
        "pruned=%d changed=%s",
        result.latest, len(result.fetched), len(result.failed), len(result.gone), len(result.unavailable),
        len(result.packed), len(result.pruned), result.changed,
    )
    _github_output(changed=str(result.changed).lower(), latest=result.latest)
    if result.failed and not result.fetched:
        return 1
    return 0


def cmd_fetch(product: Product, store: FrameStore, args) -> int:
    from .fetch import fetch_hour

    exists = exists_fn_for(product)
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
    listed = store.listing([f.id for f in product.fields])
    files, _, listed = pack_runs(product, store, listed, read_manifest(store))
    write_manifest(store, build_manifest(product, listed, files))
    store.finish(files)
    shape = (product.grid.ny, product.grid.nx)
    frames: dict[tuple[str, str], dict[int, bytes]] = {}
    for rid, f, fid in result.fetched:
        spec = product.field(fid)
        gz = frames.setdefault((rid, fid), store.frames(rid, fid))[f]
        bands = decode_frame(spec, gzip.decompress(gz), shape)
        summary = ", ".join(
            f"{b.name} {np.nanmin(decode_band(bands[b.name], b)):.4g}..{np.nanmax(decode_band(bands[b.name], b)):.4g} {b.units}"
            for b in spec.bands
        )
        log.info("%s %s f%03d (%s): %d bytes gzipped, %d bytes raw; %s", rid, fid, f, files[rid][fid], len(gz),
                 spec.frame_bytes(shape[1], shape[0]), summary)
    for rid, f, err in result.failed + result.gone:
        log.error("%s f%03d failed: %s", rid, f, err)
    bad_mean = not check_member_means(product, init, hours, field_ids)
    return 1 if result.failed or result.gone or bad_mean else 0


def check_member_means(product: Product, init: datetime, hours: list[int], field_ids: list[str],
                       compare=None) -> bool:
    """For an ensemble whose mean the pipeline averages from members (catalog.MEAN_CHECKS),
    compare that mean with the ensemble's own at each hour, when the fields asked for
    include one averaged from members; False if any differs too much or can't be checked."""
    from .catalog import MEAN_CHECKS, recipes_for
    from .fetch import compare_member_mean

    compare = compare or compare_member_mean  # tests pass a fake (a module-level function: it runs in a worker)
    recipes = recipes_for(product.model.id)
    if product.model.id not in MEAN_CHECKS or not any(
            n.kind == "members" for fid in field_ids for n in recipes[fid].needs):
        return True
    var, limit = MEAN_CHECKS[product.model.id]
    # Only hours with a member-averaged field to check: GEFS snowfall starts at F006
    exists = {f.id for f in product.fields}
    hours = [f for f in hours if any(
        fid in exists and f >= product.field(fid).min_fhr and any(n.kind == "members" for n in recipes[fid].needs_at(f))
        for fid in field_ids)]
    ok = True
    with tempfile.TemporaryDirectory(prefix="wxtrend-check-") as tmp, ProcessPoolExecutor(
        max_workers=1, mp_context=multiprocessing.get_context("spawn")) as pool:  # ecCodes stays out of this process
        for f in hours:
            try:
                mean, worst = pool.submit(compare, product, init, f, var, Path(tmp)).result()
            except Exception as e:  # noqa: BLE001 - reported, and fails the run
                log.error("f%03d %s: the members' mean couldn't be checked: %s: %s", f, var, type(e).__name__, e)
                ok = False
                continue
            good = mean <= limit
            ok &= good
            (log.info if good else log.error)(
                "f%03d %s: the %d members' mean differs from the ensemble's own by %.3g on average "
                "(limit %.3g), %.3g at most", f, var, product.model.members, mean, limit, worst)
    return ok


def cmd_verify(product: Product, store: FrameStore, args) -> int:
    import jsonschema

    path = store.root / "manifest.json"
    manifest = json.loads(path.read_text())
    jsonschema.validate(manifest, load_schema())
    published = file_keys(files_in(R2Store.from_env(product.id).read_manifest())) if args.remote else set()
    problems = []

    grid = manifest["grid"]
    if manifest["product"] != product.id:
        problems.append(f"manifest is for product {manifest['product']}, not {product.id}")
    problems += config_drift(product, manifest)
    if (grid["id"], grid["nx"], grid["ny"]) != (product.grid.id, product.grid.nx, product.grid.ny):
        problems.append(
            f"grid {grid['id']} {grid['nx']}x{grid['ny']} != config {product.grid.id} {product.grid.nx}x{product.grid.ny}"
        )
    shape = (grid["ny"], grid["nx"])
    ids = {f.id for f in product.fields}
    named = set()
    frames = files = total_bytes = in_r2 = 0
    for run in manifest["runs"]:
        for fid, hours in run["hours"].items():
            if fid not in ids or not hours:
                continue  # an unknown field is reported by config_drift
            spec = product.field(fid)
            name = run["files"].get(fid)
            if name is None:
                problems.append(f"{run['id']} {fid}: no run file named for its {len(hours)} hours")
                continue
            key = FILE_TEMPLATE.format(run=run["id"], file=name)
            named.add(key)
            frames += len(hours)
            if not (store.root / key).is_file():
                if key in published:
                    in_r2 += 1  # checked when it was uploaded
                else:
                    problems.append(f"{key} is neither on disk nor in R2")
                continue
            data = (store.root / key).read_bytes()
            files += 1
            total_bytes += len(data)
            try:
                if run_file_name(fid, data) != name:
                    raise ValueError("its bytes don't match the digest in its name")
                held = unpack_frames(data)
                if sorted(held) != [fid] or sorted(held[fid]) != hours:
                    raise ValueError(f"it holds {({k: sorted(v) for k, v in held.items()})}, not {fid} {hours}")
                for f in hours:
                    decode_frame(spec, gzip.decompress(held[fid][f]), shape)
            except (OSError, ValueError, EOFError, gzip.BadGzipFile) as e:
                problems.append(f"{key}: {e}")
    on_disk = {str(p.relative_to(store.root)) for p in store.runs_dir.glob("*/*.bin")} if store.runs_dir.is_dir() else set()
    if on_disk - named:
        problems.append(f"{len(on_disk - named)} run files on disk aren't in the manifest, e.g. {sorted(on_disk - named)[0]}")
    if store.staged() or store.legacy():
        problems.append("frames are staged or in the schema-3 layout: run update or repack to pack them")

    for p in problems:
        log.error("%s", p)
    log.info(
        "%s: %d runs, %d frames in %d run files (%d on disk, %.1f MB; %d already in R2), %s",
        path, len(manifest["runs"]), frames, files + in_r2, files, total_bytes / 1e6, in_r2,
        "OK" if not problems else f"{len(problems)} problems",
    )
    return 1 if problems else 0


def cmd_sync(product: Product, store: FrameStore, args) -> int:
    import jsonschema

    jsonschema.validate(json.loads((store.root / "manifest.json").read_text()), load_schema())
    result = sync_to_r2(store, R2Store.from_env(product.id))
    _github_summary(
        f"**{product.id}** → R2: {len(result.uploaded)} run files uploaded, {result.already_published} already there, "
        f"runs deleted: {', '.join(result.pruned) or 'none'}"
    )
    return 0


def cmd_archive(product: Product, store: FrameStore, args) -> int:
    from .archive import archive_product, stores_from_env

    result = archive_product(product, *stores_from_env(product.id))
    _github_summary(
        f"**{product.id}** → archive ({product.archive}): {len(result.written)} run files written "
        f"({result.frames} new frames), {result.already_archived} frames already there, "
        f"runs updated: {', '.join(result.runs_written) or 'none'}"
    )
    return 0


def cmd_repack(product: Product, store: FrameStore, args) -> int:
    written = repack(product, store, datetime.now(timezone.utc))
    log.info("%s: %s", store.root, f"{len(written)} run files written" if written else "already packed")
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
    except (FileNotFoundError, KeyError) as e:
        print(f"comparison unavailable: {e}")
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
