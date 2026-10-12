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
    index_key,
    merge_ranges,
    read_grib_vars,
    select_messages,
    to_canonical_units,
)
from wxtrend.net import retrying_session

from .grib import LATS, eccodes_index, message

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
