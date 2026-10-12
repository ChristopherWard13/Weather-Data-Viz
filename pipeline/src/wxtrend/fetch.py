"""Fetch every needed GRIB message for one (run, forecast hour), then compute
each field's bands.

Three source adapters, chosen by the model's ``source.adapter``:

- ``herbie`` (GFS, GEFS mean): Herbie reads the wgrib2-style ``.idx`` and
  downloads only the messages matching the fields' search regexes, in one pass
  per hour (~9 MB of byte ranges instead of ~500 MB per file).
- ``nomads`` (AIGFS, AIGEFS and HGEFS means): NOMADS limits each IP to a
  number of requests a minute, so this adapter reads each of the hour's files
  in two requests: its ``.idx``, then one multi-range GET for every needed
  message (answered as ``multipart/byteranges``). Requests are paced
  (``net.PacedSession``).
- ``ecmwf_opendata`` (IFS, AIFS): reads the eccodes ``.index`` (JSON lines,
  one per message, with byte offsets) next to each GRIB2 file and downloads
  the needed messages' byte ranges itself, through a session that backs off on
  ``503 SlowDown``. A recipe may need messages from earlier steps (f−6 for
  running totals), which are separate files.

Messages are decoded by cfgrib and identified by their GRIB attributes
(shortName, typeOfLevel, level) via ``catalog.GRIB_KEYS``, then cropped to the
display grid, or regridded (``regrid.py``) for products whose source has
another spacing. The update step runs this in worker processes, so ecCodes is
never shared between threads.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import warnings
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import numpy as np
import requests

from .catalog import CATEGORICAL_VARS, GRIB_KEYS, Need, needs_for, recipes_for
from .config import Product
from .fields import crop_to_domain
from .net import PacedSession, paced_session, retrying_session

log = logging.getLogger(__name__)

_DECODE_LOCK = threading.Lock()

Values = dict[str, dict[str, np.ndarray]]  # field id -> band name -> physical values


class UpstreamMissing(RuntimeError):
    """The requested GRIB2 file, inventory, or messages are not published."""


class NotPublished(UpstreamMissing):
    """The source has no such file (HTTP 404): an answer, so the job isn't retried.

    NOMADS keeps AIGEFS and HGEFS only 2 days, so after an outage the oldest
    runs of the window can be gone for good; retrying them would only spend
    the rate budget.
    """


def fetch_hour(product: Product, init: datetime, fhr: int, field_ids: list[str], work_dir: Path) -> Values:
    needs = needs_for(product.model.id, field_ids, fhr)
    if product.model.adapter == "herbie":
        grib, lats, lons = _fetch_herbie(product, init, fhr, field_ids, needs, work_dir)
    elif product.model.adapter == "nomads":
        grib, lats, lons = _fetch_nomads(product, init, fhr, field_ids, needs, work_dir)
    else:
        grib, lats, lons = _fetch_ecmwf(product, init, fhr, needs, work_dir)
    cropped = to_display_grid(product, grib, lats, lons)
    recipes = recipes_for(product.model.id)
    out = {}
    for fid in field_ids:
        inputs = {n.key: cropped[n.key] for n in recipes[fid].needs_at(fhr)}
        out[fid] = recipes[fid].compute(inputs, product.grid)
    return out


def to_display_grid(product: Product, grib: dict[str, np.ndarray], lats, lons) -> dict[str, np.ndarray]:
    """Crop (same spacing) or regrid (``product.regrid``) every input to the display grid."""
    if not product.regrid:
        return {k: crop_to_domain(v, lats, lons, product.grid).data for k, v in grib.items()}
    from .regrid import weights_for

    w = weights_for(lats, lons, product.grid)
    return {k: w.apply_nearest(v) if k.split("@")[0] in CATEGORICAL_VARS else w.apply(v) for k, v in grib.items()}


# ------------------------------------------------------------------ Herbie (wgrib2 .idx)


def _fetch_herbie(product: Product, init: datetime, fhr: int, field_ids: list[str], needs: list[Need],
                  work_dir: Path):
    from herbie import Herbie  # deferred: slow import, and tests don't need it

    if any(n.offset for n in needs):
        raise ValueError(f"{product.id}: the Herbie adapter reads one step per hour; recipes can't use offsets")
    search = product.search_for(fhr, field_ids)
    if not search:
        raise ValueError(f"no fields {field_ids} exist at f{fhr:03d}")
    member = {"member": product.model.herbie_member} if product.model.herbie_member else {}
    H = Herbie(
        init.replace(tzinfo=None),  # Herbie wants naive UTC
        model=product.model.herbie_model,
        product=product.model.herbie_product,
        fxx=fhr,
        priority=[product.model.source],
        save_dir=work_dir,
        overwrite=True,
        verbose=False,
        **member,
    )
    tag = f"{product.id} {init:%Y%m%d%H} f{fhr:03d}"
    if H.grib is None or H.idx is None:
        # Not NotPublished: Herbie's existence check reads a throttled 503
        # (AWS "Slow Down") as "not found", so this must stay retryable.
        raise UpstreamMissing(f"{tag} not found on {product.model.source}")

    path = H.download(search, verbose=False, errors="raise")
    if path is None or not Path(path).exists():
        raise UpstreamMissing(f"{tag}: no messages matched {search!r}")
    path = Path(path)
    try:
        with _DECODE_LOCK:
            return read_grib_vars(path, {n.var for n in needs})
    finally:
        path.unlink(missing_ok=True)


# ------------------------------------------------------------------ ECMWF open data (eccodes .index)

MERGE_GAP_BYTES = 1_000_000  # read across gaps this small: fewer requests to a throttled bucket

_session: requests.Session | None = None


def _ecmwf_session(product: Product) -> requests.Session:
    global _session  # one per worker process
    if _session is None:
        _session = retrying_session(product.model.max_connections or 4)
    return _session


def index_key(var: str) -> tuple[str, str, str | None]:
    """The (param, levtype, levelist) an eccodes index uses for a GRIB_KEYS variable."""
    short, level_type, level = GRIB_KEYS[var]
    if level_type == "isobaricInhPa":
        return short, "pl", str(int(level))
    return short, "sfc", None


def select_messages(index_text: str, wanted: dict[str, tuple[str, str, str | None]]) -> dict[str, tuple[int, int]]:
    """{var: (offset, length)} for each wanted variable in an eccodes index."""
    found: dict[str, tuple[int, int]] = {}
    by_key = {key: var for var, key in wanted.items()}
    for line in index_text.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        key = (row["param"], row["levtype"], row.get("levelist"))
        var = by_key.get(key)
        if var is not None and var not in found:
            found[var] = (int(row["_offset"]), int(row["_length"]))
    return found


def merge_ranges(spans: list[tuple[int, int]], gap: int = MERGE_GAP_BYTES) -> list[tuple[int, int]]:
    """(offset, length) spans -> sorted [start, end) ranges, joining ranges at most ``gap`` bytes apart."""
    out: list[list[int]] = []
    for off, length in sorted(spans):
        if out and off - out[-1][1] <= gap:
            out[-1][1] = max(out[-1][1], off + length)
        else:
            out.append([off, off + length])
    return [(a, b) for a, b in out]


def _fetch_ecmwf(product: Product, init: datetime, fhr: int, needs: list[Need], work_dir: Path):
    session = _ecmwf_session(product)
    by_offset: dict[int, list[Need]] = defaultdict(list)
    for n in needs:
        by_offset[n.offset].append(n)
    found: dict[str, np.ndarray] = {}
    lats = lons = None
    for offset in sorted(by_offset, reverse=True):  # step f first: it's the one known to be posted
        group = by_offset[offset]
        step = fhr + offset
        tag = f"{product.id} {init:%Y%m%d%H} step {step} (for f{fhr:03d})"
        idx_url = product.model.index_url_for(init, step)
        grib_url = idx_url.removesuffix(".index") + ".grib2"
        r = session.get(idx_url, timeout=60)
        if r.status_code == 404:
            raise NotPublished(f"{tag}: no index at {idx_url}")
        r.raise_for_status()
        wanted = {n.var: index_key(n.var) for n in group}
        spans = select_messages(r.text, wanted)
        missing = sorted(set(wanted) - set(spans))
        if missing:
            raise UpstreamMissing(f"{tag}: not in the index: {missing}")

        path = work_dir / f"{product.id}-{init:%Y%m%d%H}-f{fhr:03d}-s{step:03d}.grib2"
        with open(path, "wb") as out:
            for start, end in merge_ranges(list(spans.values())):
                r = session.get(grib_url, headers={"Range": f"bytes={start}-{end - 1}"}, timeout=120)
                r.raise_for_status()
                if r.status_code != 206 or len(r.content) != end - start:
                    raise UpstreamMissing(f"{tag}: range {start}-{end - 1} returned HTTP {r.status_code}, "
                                          f"{len(r.content)} bytes")
                # Keep only the wanted messages: a merged range can span others.
                for off, length in sorted(spans.values()):
                    if start <= off and off + length <= end:
                        out.write(r.content[off - start:off - start + length])
        try:
            with _DECODE_LOCK:
                grib, lats, lons = read_grib_vars(path, set(wanted))
        finally:
            path.unlink(missing_ok=True)
        for n in group:
            found[n.key] = grib[n.var]
    return found, lats, lons


# ------------------------------------------------------------------ NOMADS (wgrib2 .idx, multi-range GETs)

_nomads: PacedSession | None = None


def _nomads_session(product: Product) -> PacedSession:
    global _nomads  # one per worker process; the product's budget is split across its workers
    if _nomads is None:
        _nomads = paced_session(product.model.requests_per_minute or 60, product.workers,
                                pool_size=product.model.max_connections or 4)
    return _nomads


def idx_search_string(line: str) -> str:
    """The text a search regex sees for one wgrib2 .idx line, as Herbie builds it:
    ``1:0:d=2026101100:TMP:2 m above ground:6 hour fcst:`` -> ``:TMP:2 m above ground:6 hour fcst:``."""
    return ":" + ":".join(line.split(":")[3:])


def select_idx_messages(idx_text: str, search: str) -> list[tuple[int, int | None]]:
    """(offset, length) of every message whose .idx line matches ``search``.

    The last message's length is None (it runs to the end of the file).
    Identical lines count once: AIGFS lists F006's 6-hour precipitation twice
    (``0-6 hour acc``, as the bucket and as the running total).
    """
    rows = []
    for line in idx_text.splitlines():
        parts = line.split(":")
        if len(parts) >= 4 and parts[1].isdigit():
            rows.append((int(parts[1]), idx_search_string(line)))
    pattern = re.compile(search)
    out, seen = [], set()
    for i, (offset, text) in enumerate(rows):
        if pattern.search(text) and text not in seen:
            seen.add(text)
            out.append((offset, rows[i + 1][0] - offset if i + 1 < len(rows) else None))
    return out


def range_header(spans: list[tuple[int, int | None]]) -> str:
    """One Range header for every span; adjacent spans are joined (servers merge them anyway)."""
    parts: list[list[int | None]] = []
    for off, length in sorted(spans, key=lambda s: s[0]):
        end = None if length is None else off + length - 1
        if parts and parts[-1][1] is not None and off == parts[-1][1] + 1:
            parts[-1][1] = end
        else:
            parts.append([off, end])
    return "bytes=" + ",".join(f"{a}-" if b is None else f"{a}-{b}" for a, b in parts)


_CONTENT_RANGE = re.compile(rb"content-range:\s*bytes\s+(\d+)-(\d+)/", re.IGNORECASE)


def parse_byteranges(body: bytes, content_type: str, content_range: str | None) -> list[tuple[int, bytes]]:
    """(start offset, bytes) of each part of a 206 response: one part, or ``multipart/byteranges``."""
    if not content_type.lower().startswith("multipart/byteranges"):
        m = _CONTENT_RANGE.search(b"content-range: " + (content_range or "").encode())
        if not m:
            raise UpstreamMissing(f"206 response without a usable Content-Range ({content_range!r})")
        return [(int(m.group(1)), body)]
    boundary = re.search(r'boundary="?([^";]+)"?', content_type)
    if not boundary:
        raise UpstreamMissing(f"multipart response without a boundary: {content_type!r}")
    delimiter = b"--" + boundary.group(1).encode()
    parts, pos = [], 0
    while True:
        pos = body.find(delimiter, pos)
        if pos < 0 or body[pos + len(delimiter):pos + len(delimiter) + 2] == b"--":
            break
        head_end = body.find(b"\r\n\r\n", pos)
        if head_end < 0:
            raise UpstreamMissing("truncated multipart/byteranges response")
        m = _CONTENT_RANGE.search(body[pos:head_end])
        if not m:
            raise UpstreamMissing("a multipart/byteranges part has no Content-Range")
        start, end = int(m.group(1)), int(m.group(2))
        data = body[head_end + 4:head_end + 4 + end - start + 1]  # by length: GRIB bytes may contain anything
        if len(data) != end - start + 1:
            raise UpstreamMissing("truncated multipart/byteranges part")
        parts.append((start, data))
        pos = head_end + 4 + len(data)
    if not parts:
        raise UpstreamMissing("multipart/byteranges response with no parts")
    return parts


def fetch_messages(session, url: str, spans: list[tuple[int, int | None]], tag: str) -> list[bytes]:
    """Each span's bytes, in one GET. Refuses a 200: that's the whole file (~80 MB), not the ranges."""
    r = session.get(url, headers={"Range": range_header(spans)}, timeout=180, stream=True)
    try:
        if r.status_code == 404:
            raise NotPublished(f"{tag}: no file at {url}")
        if r.status_code != 206:
            r.raise_for_status()
            raise UpstreamMissing(f"{tag}: the server ignored the Range header (HTTP {r.status_code})")
        parts = parse_byteranges(r.content, r.headers.get("Content-Type", ""), r.headers.get("Content-Range"))
    finally:
        r.close()
    out = []
    for off, length in spans:
        for start, data in parts:
            if start <= off < start + len(data):
                chunk = data[off - start:] if length is None else data[off - start:off - start + length]
                if length is not None and len(chunk) != length:
                    raise UpstreamMissing(f"{tag}: a part ends inside bytes {off}+{length} (truncated response)")
                out.append(chunk)
                break
        else:
            raise UpstreamMissing(f"{tag}: the response doesn't cover bytes {off}+{length}")
    return out


def _fetch_nomads(product: Product, init: datetime, fhr: int, field_ids: list[str], needs: list[Need],
                  work_dir: Path):
    if any(n.offset for n in needs):
        raise ValueError(f"{product.id}: the NOMADS adapter reads one step per hour; recipes can't use offsets")
    session = _nomads_session(product)
    searches = product.searches_by_file(fhr, field_ids)
    if not searches:
        raise ValueError(f"no fields {field_ids} exist at f{fhr:03d}")
    path = work_dir / f"{product.id}-{init:%Y%m%d%H}-f{fhr:03d}.grib2"
    try:
        with open(path, "wb") as out:
            for kind, search in searches.items():
                tag = f"{product.id} {init:%Y%m%d%H} f{fhr:03d} {kind}"
                url = product.model.file_url_for(kind, init, fhr)
                r = session.get(url + ".idx", timeout=60)
                if r.status_code == 404:
                    raise NotPublished(f"{tag}: no index at {url}.idx")
                r.raise_for_status()
                spans = select_idx_messages(r.text, search)
                if not spans:
                    raise UpstreamMissing(f"{tag}: no messages matched {search!r}")
                for data in fetch_messages(session, url, spans, tag):
                    out.write(data)
        with _DECODE_LOCK:
            return read_grib_vars(path, {n.var for n in needs})
    finally:
        path.unlink(missing_ok=True)


# ------------------------------------------------------------------ decoding

# Precipitation comes in different units per model: GFS and AIFS use kg m-2
# (= mm of water), IFS uses metres. Water amounts are converted to mm as they
# are read, from each message's own units, so recipes see one unit.
WATER_VARS = {"tp", "sf"}
WATER_TO_MM = {"kg m**-2": 1.0, "kg m-2": 1.0, "mm": 1.0, "m": 1000.0, "m of water equivalent": 1000.0}


def to_canonical_units(name: str, values: np.ndarray, units: str | None) -> np.ndarray:
    if name not in WATER_VARS:
        return values
    try:
        return values * WATER_TO_MM[units]
    except KeyError:
        raise ValueError(f"{name}: unexpected units {units!r} for a water amount") from None


def read_grib_vars(path: Path, wanted: set[str]):
    """Return ({logical name: 2-D array}, lats, lons) for the ``wanted`` variables.

    One variable at several levels (u at 250 and 500 mb) comes out of cfgrib
    with a level dimension; each level is matched on its own. Water amounts
    (``WATER_VARS``) are returned in mm whatever their GRIB units.
    """
    import cfgrib

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FutureWarning)
        datasets = cfgrib.open_datasets(str(path), backend_kwargs={"indexpath": ""})
    found: dict[str, np.ndarray] = {}
    lats = lons = None
    try:
        for ds in datasets:
            for da in ds.data_vars.values():
                tol = da.attrs.get("GRIB_typeOfLevel")
                layers = [da.sel({tol: lev}) for lev in da[tol].values] if tol in da.dims else [da]
                for layer in layers:
                    name = match_grib_key(layer.attrs, layer.coords)
                    if name is None or name not in wanted or name in found:
                        continue  # duplicates (e.g. F006's two identical APCP messages): first wins
                    if layer.dims != ("latitude", "longitude"):
                        raise ValueError(f"{path.name}: {name} has dims {layer.dims}")
                    found[name] = to_canonical_units(
                        name, layer.values.astype(np.float64), layer.attrs.get("GRIB_units"))
                    lats = layer["latitude"].values
                    lons = layer["longitude"].values
    finally:
        for ds in datasets:
            ds.close()
    missing = sorted(wanted - found.keys())
    if missing:
        raise UpstreamMissing(f"{path.name}: GRIB variables not found: {missing}")
    return found, lats, lons


def match_grib_key(attrs, coords) -> str | None:
    short = attrs.get("GRIB_shortName")
    tol = attrs.get("GRIB_typeOfLevel")
    for name, (k_short, k_tol, k_level) in GRIB_KEYS.items():
        if short != k_short or tol != k_tol:
            continue
        if k_level is not None:
            if tol not in coords or float(coords[tol]) != k_level:
                continue
        return name
    return None
