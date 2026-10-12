"""Source adapters on synthetic GRIB: index parsing, byte ranges, decoding, recipes.

Anything that builds or decodes GRIB (ecCodes, cfgrib, Herbie) runs in a
spawned worker process, as the pipeline itself does (update.py decodes in a
process pool). On Linux, ecCodes in the pytest process made the interpreter
abort at exit (``munmap_chunk(): invalid pointer``, CI 2026-10-12) after every
test had passed; in a worker, the test process never loads it.
"""

import multiprocessing
import threading
from concurrent.futures import ProcessPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pytest

from wxtrend import fetch
from wxtrend.alignment import utc
from wxtrend.config import load_config
from wxtrend.fetch import (
    UpstreamMissing,
    fetch_hour,
    fetch_messages,
    idx_search_string,
    index_key,
    merge_ranges,
    parse_byteranges,
    range_header,
    read_grib_vars,
    select_idx_messages,
    select_messages,
    to_canonical_units,
)
from wxtrend.net import retrying_session

from .grib import LATS, eccodes_index, lats_for, message, wgrib2_index

CFG = load_config()
INIT = utc(2026, 10, 9, 0)
LAT = LATS[:, None]
U500 = 10 * np.cos(np.radians(LAT))  # solid-body rotation: known vorticity


def in_worker(fn, *args):
    """Run ``fn(*args)`` in a fresh spawned process and return its result (or raise its error)."""
    with ProcessPoolExecutor(1, mp_context=multiprocessing.get_context("spawn")) as pool:
        return pool.submit(fn, *args).result()


def test_index_key():
    assert index_key("gh500") == ("gh", "pl", "500")
    assert index_key("t2m") == ("2t", "sfc", None)
    assert index_key("fg10") == ("10fg", "sfc", None)
    assert index_key("msl") == ("msl", "sfc", None)


def test_select_messages_matches_param_levtype_and_level():
    text, _ = eccodes_index([
        ({"param": "u", "levtype": "pl", "levelist": "250"}, b"a" * 10),
        ({"param": "u", "levtype": "pl", "levelist": "500"}, b"b" * 20),
        ({"param": "2t", "levtype": "sfc"}, b"c" * 5),
    ], step=6)
    got = select_messages(text, {"u500": ("u", "pl", "500"), "t2m": ("2t", "sfc", None),
                                 "gh500": ("gh", "pl", "500")})
    assert got == {"u500": (10, 20), "t2m": (30, 5)}


def test_merge_ranges():
    spans = [(100, 10), (0, 50), (2_000_000, 5), (60, 10)]
    assert merge_ranges(spans, gap=1_000_000) == [(0, 110), (2_000_000, 2_000_005)]
    assert merge_ranges(spans, gap=0) == [(0, 50), (60, 70), (100, 110), (2_000_000, 2_000_005)]


def test_water_amounts_are_read_in_mm():
    assert to_canonical_units("tp", np.array([0.0254]), "m")[0] == pytest.approx(25.4)
    assert to_canonical_units("sf", np.array([0.01]), "m of water equivalent")[0] == pytest.approx(10)
    assert to_canonical_units("tp", np.array([3.0]), "kg m**-2")[0] == 3.0  # GFS, AIFS
    assert to_canonical_units("t2m", np.array([280.0]), "K")[0] == 280.0
    with pytest.raises(ValueError, match="unexpected units"):
        to_canonical_units("tp", np.array([1.0]), "in")


def _read_levels(tmp: Path, wanted: set[str]):
    path = tmp / "x.grib2"
    path.write_bytes(
        message("u", "isobaricInhPa", 250, 30.0, centre=7)
        + message("u", "isobaricInhPa", 500, 12.0, centre=7)
        + message("tp", "surface", None, 0.005, start_step=0)
    )
    got, lats, lons = read_grib_vars(path, wanted)
    return {k: float(v.mean()) for k, v in got.items()}, float(lats[0]), lons.size


def test_read_grib_vars_splits_levels_of_one_variable(tmp_path):
    # cfgrib merges u at 250 and 500 mb into one variable with a level dimension
    got, lat0, nlon = in_worker(_read_levels, tmp_path, {"u250", "u500", "tp"})
    assert got["u250"] == pytest.approx(30, abs=1e-3)
    assert got["u500"] == pytest.approx(12, abs=1e-3)
    assert got["tp"] == pytest.approx(5.0, abs=1e-3)  # metres -> mm
    assert lat0 == 90 and nlon == 1440
    with pytest.raises(UpstreamMissing, match="gh500"):
        in_worker(_read_levels, tmp_path, {"u250", "gh500"})


# ------------------------------------------------------------------ ECMWF open data adapter


class FakeResponse:
    def __init__(self, status, content=b""):
        self.status_code = status
        self.content = content
        self.text = content.decode() if isinstance(content, bytes) and status == 200 else ""

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeBucket:
    """ECMWF open data on S3: an .index and a .grib2 per step, with Range support."""

    def __init__(self, product, files: dict[int, list[tuple[dict, bytes]]]):
        self.objects = {}
        for step, messages in files.items():
            text, blob = eccodes_index(messages, step)
            idx = product.model.index_url_for(INIT, step)
            self.objects[idx] = text.encode()
            self.objects[idx.removesuffix(".index") + ".grib2"] = blob
        self.requests = []

    def get(self, url, headers=None, timeout=None):
        self.requests.append((url, (headers or {}).get("Range")))
        if url not in self.objects:
            return FakeResponse(404)
        body = self.objects[url]
        if headers and "Range" in headers:
            a, b = (int(x) for x in headers["Range"].removeprefix("bytes=").split("-"))
            return FakeResponse(206, body[a:b + 1])
        return FakeResponse(200, body)


def sfc(param):
    return {"param": param, "levtype": "sfc"}


def pl(param, level):
    return {"param": param, "levtype": "pl", "levelist": str(level)}


def _ifs_bucket(product) -> FakeBucket:
    snow_north = np.where(LAT >= 45, 5.0, 12.0)  # instantaneous type: snow north of 45N, freezing drizzle south
    bucket = FakeBucket(product, {
        6: [
            (sfc("tp"), message("tp", "surface", None, 0.0254, start_step=0)),  # 25.4 mm since T0
            (sfc("2d"), message("2d", "heightAboveGround", 2, 270.0)),  # not needed: sliced out
            (sfc("sf"), message("sf", "surface", None, 0.0200, start_step=0)),
            (sfc("ptype"), message("ptype", "surface", None, snow_north)),
            (sfc("10fg"), message("10fg", "heightAboveGround", 10, 10.0, start_step=5)),
            (sfc("2t"), message("2t", "heightAboveGround", 2, 280.0)),
            (pl("gh", 500), message("gh", "isobaricInhPa", 500, 5500 + LAT)),
            (pl("u", 500), message("u", "isobaricInhPa", 500, U500)),
            (pl("v", 500), message("v", "isobaricInhPa", 500, 0.0)),
        ],
        3: [(sfc("ptype"), message("ptype", "surface", None, 0.0, step=3))],
        0: [
            (sfc("tp"), message("tp", "surface", None, 0.0, step=0, start_step=0)),
            (sfc("sf"), message("sf", "surface", None, 0.0, step=0, start_step=0)),
        ],
    })
    return bucket


def _ifs_fetch(fhr: int, fields: list[str], tmp: Path, beyond_f144: bool = False):
    """fetch_hour for the ecmwf product against a fake bucket; returns (values, requests, leftover files)."""
    product = CFG.product("ecmwf")
    bucket = _ifs_bucket(product)
    if beyond_f144:  # the same files as steps 150 and 144, and no 3-hourly step
        bucket.objects = {u.replace("-6h-", "-150h-").replace("-0h-", "-144h-"): b
                          for u, b in bucket.objects.items() if "-3h-" not in u}
    fetch._session = bucket
    out = fetch_hour(product, INIT, fhr, fields, tmp)
    return out, bucket.requests, list(tmp.iterdir())


def test_ecmwf_adapter_end_to_end(tmp_path):
    product = CFG.product("ecmwf")
    out, requests, leftovers = in_worker(
        _ifs_fetch, 6, ["precip", "gust", "hgt500", "t2m", "vort500"], tmp_path)
    grid = product.grid
    lat = (grid.lat_max - grid.resolution * np.arange(grid.ny))[:, None]

    np.testing.assert_allclose(out["precip"]["qpf"], 1.0, atol=1e-3)  # (25.4 - 0) mm = 1 in
    # snow share 20/25.4 -> snow, then freezing drizzle at f overrides south of 45N
    assert set(np.unique(out["precip"]["ptype"][lat[:, 0] >= 45.25])) == {2}
    assert set(np.unique(out["precip"]["ptype"][lat[:, 0] < 44.75])) == {4}
    np.testing.assert_allclose(out["gust"]["gust"], 19.4384, atol=1e-3)
    np.testing.assert_allclose(out["t2m"]["temp"], 44.33, atol=0.01)
    hgt = out["hgt500"]["hgt"]
    assert hgt[0, 0] == pytest.approx(5570, abs=0.05) and hgt[-1, 0] == pytest.approx(5515, abs=0.05)
    vort = out["vort500"]["vort"]
    expected = (2 * 10 / 6_371_000 + 2 * 7.2921e-5) * np.sin(np.radians(lat)) * 1e5
    np.testing.assert_allclose(vort[1:-1, 1:-1], np.broadcast_to(expected, vort.shape)[1:-1, 1:-1], atol=1e-3)
    assert np.isnan(vort[0]).all()

    # Each step's index once, then its messages: f, f-3 (ptype), f-6 (totals)
    urls = [u for u, _ in requests]
    steps = [u.rsplit("-", 3)[-3] for u in urls if u.endswith(".index")]
    assert steps == ["6h", "3h", "0h"]
    ranges6 = [r for u, r in requests if u.endswith("-6h-oper-fc.grib2")]
    assert len(ranges6) == 1  # the messages are adjacent, so one request covers them all
    assert leftovers == []  # the downloaded files are removed


def test_ecmwf_adapter_beyond_f144_skips_f_minus_3(tmp_path):
    product = CFG.product("ecmwf")
    out, requests, _ = in_worker(_ifs_fetch, 150, ["precip"], tmp_path, True)
    assert out["precip"]["qpf"].shape == (product.grid.ny, product.grid.nx)
    assert not any("-147h-" in u for u, _ in requests)


def test_ecmwf_adapter_reports_missing_steps_and_messages(tmp_path):
    with pytest.raises(UpstreamMissing, match="no index"):
        in_worker(_ifs_fetch, 12, ["t2m"], tmp_path)
    with pytest.raises(UpstreamMissing, match=r"not in the index: \['msl'\]"):
        in_worker(_ifs_fetch, 6, ["mslp"], tmp_path)


# ------------------------------------------------------------------ Herbie adapter (GFS)


class FakeHerbie:
    searches = []

    def __init__(self, date, *, model, product, fxx, priority, save_dir, **kw):
        self.save_dir, self.fxx = save_dir, fxx
        self.grib = self.idx = "https://example/fake"

    def download(self, search, **kw):
        FakeHerbie.searches.append(search)
        path = self.save_dir / f"subset_{self.fxx}.grib2"
        path.write_bytes(
            message("u", "isobaricInhPa", 250, 50.0, centre=7)
            + message("v", "isobaricInhPa", 250, 0.0, centre=7)
            + message("u", "isobaricInhPa", 500, U500, centre=7)
            + message("v", "isobaricInhPa", 500, 0.0, centre=7)
            + message("gh", "isobaricInhPa", 500, 5600.0, centre=7)
            + message("t", "isobaricInhPa", 850, 263.15, centre=7)
        )
        return path


def _herbie_fetch(tmp: Path):
    import herbie

    herbie.Herbie = FakeHerbie
    out = fetch_hour(CFG.product("gfs"), INIT, 6, ["wspd250", "vort500", "hgt500", "t850"], tmp)
    return out, FakeHerbie.searches, list(tmp.iterdir())


def test_herbie_adapter_end_to_end(tmp_path):
    out, searches, leftovers = in_worker(_herbie_fetch, tmp_path)
    assert searches[-1] == ":(?:UGRD|VGRD):250 mb:|:HGT:500 mb:|:(?:UGRD|VGRD):500 mb:|:TMP:850 mb:"
    np.testing.assert_allclose(out["wspd250"]["speed"], 50 * 1.94384, atol=0.01)
    np.testing.assert_allclose(out["hgt500"]["hgt"], 5600, atol=0.1)
    np.testing.assert_allclose(out["t850"]["temp"], -10, atol=0.01)
    assert out["vort500"]["vort"][100, 240] == pytest.approx(10.31 + 0.22, abs=0.01)  # 45N: f + 2U sin/R
    assert leftovers == []


# ------------------------------------------------------------------ NOMADS adapter (AIGFS, AIGEFS, HGEFS)

IDX = """1:0:d=2026101100:UGRD:10 m above ground:6 hour fcst:
2:100:d=2026101100:VGRD:10 m above ground:6 hour fcst:
3:250:d=2026101100:TMP:2 m above ground:6 hour fcst:
4:400:d=2026101100:PRMSL:mean sea level:6 hour fcst:
5:600:d=2026101100:APCP:surface:0-6 hour acc fcst:
6:700:d=2026101100:APCP:surface:0-6 hour acc fcst:
7:800:d=2026101100:TMP:2 m above ground:6 hour fcst:ens mean
"""


def test_idx_search_string_matches_herbies():
    assert idx_search_string("3:250:d=2026101100:TMP:2 m above ground:6 hour fcst:") == (
        ":TMP:2 m above ground:6 hour fcst:")


def test_select_idx_messages_dedupes_and_leaves_the_last_open():
    # F006's bucket and running total are the same line: read it once
    assert select_idx_messages(IDX, ":APCP:surface:0-6 hour acc") == [(600, 100)]
    assert select_idx_messages(IDX, ":(?:UGRD|VGRD):10 m above ground:|:PRMSL:") == [(0, 100), (100, 150), (400, 200)]
    assert select_idx_messages(IDX, ":TMP:2 m above ground:6 hour fcst:ens mean") == [(800, None)]
    assert select_idx_messages(IDX, ":HGT:500 mb:") == []


def test_range_header_joins_adjacent_spans():
    assert range_header([(400, 200), (0, 100), (100, 150), (800, None)]) == "bytes=0-249,400-599,800-"
    assert range_header([(5, 5)]) == "bytes=5-9"


def multipart(parts: list[tuple[int, bytes]], total: int, boundary: str = "B0UND") -> bytes:
    out = b""
    for start, data in parts:
        out += (f"\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n"
                f"Content-Range: bytes {start}-{start + len(data) - 1}/{total}\r\n\r\n").encode() + data
    return out + f"\r\n--{boundary}--\r\n".encode()


def test_parse_byteranges():
    body = multipart([(0, b"--B0UND\r\n" + b"x" * 5), (100, b"\r\n\r\nyy")], 200)  # parts may contain anything
    assert parse_byteranges(body, 'multipart/byteranges; boundary="B0UND"', None) == [
        (0, b"--B0UND\r\nxxxxx"), (100, b"\r\n\r\nyy")]
    assert parse_byteranges(b"abc", "application/octet-stream", "bytes 7-9/50") == [(7, b"abc")]
    with pytest.raises(UpstreamMissing, match="Content-Range"):
        parse_byteranges(b"abc", "application/octet-stream", None)


class NomadsResponse(FakeResponse):
    def __init__(self, status, content=b"", headers=None):
        self.status_code, self.content, self.headers = status, content, headers or {}
        self.text = content.decode(errors="replace") if status == 200 else ""

    def close(self):
        pass


class FakeNomads:
    """NOMADS: a .idx and a .grib2 per file, answering multi-range GETs the way Apache does."""

    def __init__(self, files: dict[str, tuple[str, bytes]], ignore_ranges: bool = False, apache_merge: bool = False):
        self.objects = {}
        for url, (idx, blob) in files.items():
            self.objects[url + ".idx"] = idx.encode()
            self.objects[url] = blob
        self.ignore_ranges = ignore_ranges
        self.apache_merge = apache_merge  # answer with one part spanning every range, gaps included
        self.requests = []

    def get(self, url, headers=None, timeout=None, stream=False):
        rng = (headers or {}).get("Range")
        self.requests.append((url, rng))
        if url not in self.objects:
            return NomadsResponse(404)
        body = self.objects[url]
        if not rng or self.ignore_ranges:
            return NomadsResponse(200, body)
        spans = []
        for part in rng.removeprefix("bytes=").split(","):
            a, b = part.split("-")
            spans.append((int(a), int(b) if b else len(body) - 1))
        if self.apache_merge:
            spans = [(min(a for a, _ in spans), max(b for _, b in spans))]
        if len(spans) == 1:
            a, b = spans[0]
            return NomadsResponse(206, body[a:b + 1], {"Content-Type": "application/octet-stream",
                                                       "Content-Range": f"bytes {a}-{b}/{len(body)}"})
        return NomadsResponse(206, multipart([(a, body[a:b + 1]) for a, b in reversed(spans)], len(body)),
                              {"Content-Type": "multipart/byteranges; boundary=B0UND"})


AI_INIT = utc(2026, 10, 9, 0)


def _ai_files(product, drop: str = ""):
    keep = lambda m: [x for x in m if not (drop and x[0].startswith(drop))]  # noqa: E731
    sfc_idx, sfc = wgrib2_index(keep([
        ("UGRD:10 m above ground:6 hour fcst:", message("10u", "heightAboveGround", 10, 3.0, centre=7)),
        ("VGRD:10 m above ground:6 hour fcst:", message("10v", "heightAboveGround", 10, 4.0, centre=7)),
        ("TMP:2 m above ground:6 hour fcst:", message("2t", "heightAboveGround", 2, 293.15, centre=7)),
        ("PRMSL:mean sea level:6 hour fcst:", message("prmsl", "meanSea", None, 101000.0, centre=7)),
        ("APCP:surface:0-6 hour acc fcst:", message("tp", "surface", None, 12.7, start_step=0, centre=7)),
        ("APCP:surface:0-6 hour acc fcst:", message("tp", "surface", None, 12.7, start_step=0, centre=7)),
    ]))
    pres_idx, pres = wgrib2_index(keep([
        ("HGT:500 mb:6 hour fcst:", message("gh", "isobaricInhPa", 500, 5600.0, centre=7)),
        ("SPFH:500 mb:6 hour fcst:", message("q", "isobaricInhPa", 500, 0.001, centre=7)),  # not needed
        ("TMP:850 mb:6 hour fcst:", message("t", "isobaricInhPa", 850, 263.15, centre=7)),
        ("UGRD:250 mb:6 hour fcst:", message("u", "isobaricInhPa", 250, 50.0, centre=7)),
        ("UGRD:500 mb:6 hour fcst:", message("u", "isobaricInhPa", 500, U500, centre=7)),
        ("VGRD:250 mb:6 hour fcst:", message("v", "isobaricInhPa", 250, 0.0, centre=7)),
        ("VGRD:500 mb:6 hour fcst:", message("v", "isobaricInhPa", 500, 0.0, centre=7)),
        ("VVEL:500 mb:6 hour fcst:", message("w", "isobaricInhPa", 500, 0.1, centre=7)),  # not needed, last
    ]))
    return {product.model.file_url_for("sfc", AI_INIT, 6): (sfc_idx, sfc),
            product.model.file_url_for("pres", AI_INIT, 6): (pres_idx, pres)}


def _nomads_fetch(product_id: str, fields: list[str], tmp: Path, ignore_ranges: bool = False,
                  fhr: int = 6, drop: str = ""):
    from wxtrend.net import PacedSession

    product = CFG.product(product_id)
    server = FakeNomads(_ai_files(product, drop), ignore_ranges)
    fetch._nomads = PacedSession(server, 0.0)
    out = fetch_hour(product, AI_INIT, fhr, fields, tmp)
    return out, server.requests, list(tmp.iterdir())


@pytest.mark.parametrize("product_id", ["aigfs", "aigefs", "hgefs"])
def test_nomads_adapter_end_to_end(tmp_path, product_id):
    fields = [f.id for f in CFG.product(product_id).fields]
    out, requests, leftovers = in_worker(_nomads_fetch, product_id, fields, tmp_path)
    np.testing.assert_allclose(out["wspd10"]["speed"], 5 * 1.94384, atol=0.01)  # 3-4-5
    np.testing.assert_allclose(out["t2m"]["temp"], 68, atol=0.01)
    np.testing.assert_allclose(out["mslp"]["mslp"], 1010, atol=0.01)
    np.testing.assert_allclose(out["precip"]["qpf"], 0.5, atol=1e-3)  # 12.7 mm
    assert set(np.unique(out["precip"]["ptype"])) == {5}  # no type output: unspecified
    np.testing.assert_allclose(out["wspd250"]["speed"], 50 * 1.94384, atol=0.01)
    np.testing.assert_allclose(out["hgt500"]["hgt"], 5600, atol=0.1)
    np.testing.assert_allclose(out["t850"]["temp"], -10, atol=0.01)
    assert out["vort500"]["vort"][100, 240] == pytest.approx(10.31 + 0.22, abs=0.01)
    # Two requests per file: its index, then every needed message in one multi-range GET
    assert [(u.rsplit("/", 1)[1], r) for u, r in requests] == [
        ("aigfs.t00z.sfc.f006.grib2.idx" if product_id == "aigfs" else f"{product_id}.t00z.sfc.avg.f006.grib2.idx", None),
        (requests[1][0].rsplit("/", 1)[1], requests[1][1]),
        (requests[2][0].rsplit("/", 1)[1], None),
        (requests[3][0].rsplit("/", 1)[1], requests[3][1]),
    ]
    assert requests[1][1].count(",") == 0  # the five sfc messages are adjacent: one range
    assert requests[3][1].count(",") == 1  # gh500, then t850..v500 (the SPFH between is skipped)
    assert leftovers == []


def test_nomads_adapter_refuses_a_whole_file_and_reports_what_is_missing(tmp_path):
    with pytest.raises(UpstreamMissing, match="ignored the Range header"):
        in_worker(_nomads_fetch, "aigfs", ["t2m"], tmp_path, True)
    with pytest.raises(UpstreamMissing, match="no index at .*sfc.f012.grib2.idx"):
        in_worker(_nomads_fetch, "aigfs", ["t2m"], tmp_path, False, 12)
    with pytest.raises(UpstreamMissing, match="no messages matched"):
        in_worker(_nomads_fetch, "aigfs", ["precip"], tmp_path, False, 6, "APCP")
    assert list(tmp_path.iterdir()) == []


def test_fetch_messages_slices_each_span_from_its_part():
    blob = bytes(range(256)) * 4
    server = FakeNomads({"https://x/f.grib2": ("", blob)})
    got = fetch_messages(server, "https://x/f.grib2", [(10, 5), (15, 5), (900, None)], "t")
    assert got == [blob[10:15], blob[15:20], blob[900:]]
    assert server.requests == [("https://x/f.grib2", "bytes=10-19,900-")]


# ------------------------------------------------------------------ GEFS mean (Herbie, 0.5° -> regrid)


class FakeGefsHerbie:
    calls = []

    def __init__(self, date, *, model, product, fxx, priority, save_dir, member=None, **kw):
        FakeGefsHerbie.calls.append((model, product, member))
        self.save_dir, self.fxx = save_dir, fxx
        self.grib = self.idx = "https://example/fake"

    def download(self, search, **kw):
        lat = lats_for(0.5)[:, None]
        path = self.save_dir / f"gefs_{self.fxx}.grib2"
        path.write_bytes(b"".join([
            message("2t", "heightAboveGround", 2, 293.15, centre=7, res=0.5),
            message("2r", "heightAboveGround", 2, 50.0, centre=7, res=0.5),
            message("prmsl", "meanSea", None, 100000 + 100 * lat, centre=7, res=0.5),  # linear in latitude
            message("tp", "surface", None, 25.4, start_step=0, centre=7, res=0.5),
            message("crain", "surface", None, 0.2, start_step=0, centre=7, res=0.5),
            message("csnow", "surface", None, np.where(lat >= 45, 0.6, 0.0), start_step=0, centre=7, res=0.5),
            message("cicep", "surface", None, 0.0, start_step=0, centre=7, res=0.5),
            message("cfrzr", "surface", None, 0.0, start_step=0, centre=7, res=0.5),
        ]))
        return path


def _gefs_fetch(tmp: Path):
    import os

    import herbie

    os.environ["WXTREND_REGRID_CACHE"] = str(tmp / "regrid")
    herbie.Herbie = FakeGefsHerbie
    work = tmp / "work"
    work.mkdir()
    out = fetch_hour(CFG.product("gefs"), INIT, 6, ["t2m", "d2m", "mslp", "precip"], work)
    return out, FakeGefsHerbie.calls, list(work.iterdir()), sorted(p.name for p in (tmp / "regrid").iterdir())


def test_gefs_adapter_regrids_to_the_display_grid(tmp_path):
    product = CFG.product("gefs")
    out, calls, leftovers, cached = in_worker(_gefs_fetch, tmp_path)
    grid = product.grid
    lat = (grid.lat_max - grid.resolution * np.arange(grid.ny))[:, None]
    assert calls == [("gefs", "atmos.5", "avg")]  # the ensemble mean, 0.5° primary fields
    assert out["t2m"]["temp"].shape == (grid.ny, grid.nx)
    np.testing.assert_allclose(out["t2m"]["temp"], 68, atol=0.01)
    np.testing.assert_allclose(out["d2m"]["dewpt"], 9.2611 * 9 / 5 + 32, atol=0.02)  # Magnus, 20 °C at 50 %
    # Linear in latitude, so the barycentric regrid is exact at the 0.25° rows between 0.5° rows
    np.testing.assert_allclose(out["mslp"]["mslp"], np.broadcast_to(1000 + lat, (grid.ny, grid.nx)), atol=0.02)
    np.testing.assert_allclose(out["precip"]["qpf"], 1.0, atol=1e-3)
    ptype = out["precip"]["ptype"]
    assert set(np.unique(ptype[lat[:, 0] >= 45.5])) == {2} and set(np.unique(ptype[lat[:, 0] <= 44.5])) == {1}
    assert leftovers == []
    assert len(cached) == 1 and cached[0].startswith("na025-")


class MissingHerbie(FakeHerbie):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.grib = None  # what Herbie reports for a 404, and for a throttled 503 too


def _herbie_missing(tmp: Path):
    import herbie

    herbie.Herbie = MissingHerbie
    try:
        fetch_hour(CFG.product("gfs"), INIT, 6, ["t850"], tmp)
    except UpstreamMissing as e:
        return type(e).__name__
    return None


def test_herbie_not_found_stays_retryable(tmp_path):
    # Herbie can't tell AWS throttling from absence, so it's never NotPublished
    assert in_worker(_herbie_missing, tmp_path) == "UpstreamMissing"


# ------------------------------------------------------------------ throttling


class Throttled(BaseHTTPRequestHandler):
    """503 SlowDown twice, then the body."""

    calls = 0

    def do_GET(self):
        Throttled.calls += 1
        if Throttled.calls <= 2:
            self.send_response(503)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def do_HEAD(self):
        self.send_response(404)
        self.end_headers()

    def log_message(self, *args):
        pass


def test_session_backs_off_on_slowdown_and_does_not_retry_404():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Throttled)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/x"
        s = retrying_session(attempts=4, backoff=0.01)
        r = s.get(url, timeout=5)
        assert (r.status_code, r.content, Throttled.calls) == (200, b"ok", 3)
        assert s.head(url, timeout=5).status_code == 404
    finally:
        server.shutdown()


def test_paced_session_spaces_requests():
    from wxtrend.net import PacedSession, paced_session

    t = [0.0]
    slept = []

    def sleep(d):
        slept.append(round(d, 6))
        t[0] += d

    class Inner:
        def get(self, url, **kw):
            return url

    s = PacedSession(Inner(), 4.0, clock=lambda: t[0], sleep=sleep)
    assert [s.get(f"u{i}") for i in range(3)] == ["u0", "u1", "u2"]
    assert slept == [4.0, 4.0]  # the first goes at once
    t[0] += 10  # idle longer than the interval: no wait
    s.get("u3")
    assert slept == [4.0, 4.0]
    # 60 requests a minute over 4 workers: each worker sends one every 4 s
    assert paced_session(60, workers=4).interval == 4.0


def test_fetch_messages_survives_merged_and_reordered_parts():
    blob = bytes(range(256)) * 4
    spans = [(10, 5), (300, 20), (900, None)]
    want = [blob[10:15], blob[300:320], blob[900:]]
    assert fetch_messages(FakeNomads({"https://x/f.grib2": ("", blob)}), "https://x/f.grib2", spans, "t") == want
    merged = FakeNomads({"https://x/f.grib2": ("", blob)}, apache_merge=True)
    assert fetch_messages(merged, "https://x/f.grib2", spans, "t") == want


def test_fetch_messages_refuses_a_truncated_part():
    class Short(FakeNomads):
        def get(self, url, headers=None, timeout=None, stream=False):
            r = super().get(url, headers, timeout, stream)
            r.content = r.content[:-3]
            r.headers["Content-Range"] = "bytes 10-16/1024"
            return r

    blob = bytes(range(256)) * 4
    with pytest.raises(UpstreamMissing, match="truncated"):
        fetch_messages(Short({"https://x/f.grib2": ("", blob)}), "https://x/f.grib2", [(10, 10)], "t")
