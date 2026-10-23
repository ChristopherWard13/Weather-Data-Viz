"""Cross-language frame contract (frame format v3, run file container wxrb1).

shared/test-vectors/frames.json holds small frames encoded by this pipeline;
web/tests/frames.test.ts decodes the same bytes. This test fails if the
encoder's output changes, so the two sides can't drift apart silently.
In "decoded", null marks a nodata sample (JSON has no NaN).
shared/test-vectors/runfile.json holds a run file packed from two fields'
frames; web/tests/frames.test.ts reads its index and frames.
Regenerate with:  uv run python -m tests.test_contract
"""

import base64
import gzip
import json

import numpy as np

from wxtrend.config import REPO_ROOT, Band, FieldSpec
from wxtrend.fields import decode_band, encode_band
from wxtrend.store import CONTAINER, HEADER_PROBE, encode_frame, gzip_frame, pack_frames, read_index, unpack_frames

PATH = REPO_ROOT / "shared" / "test-vectors" / "frames.json"
RUN_FILE_PATH = REPO_ROOT / "shared" / "test-vectors" / "runfile.json"
SHAPE = (3, 4)

FIELD = FieldSpec(
    "demo", "demo", "x", 0,
    (
        Band("temp", "F", "uint8", 1.0, -80.0),
        Band("dir", "deg", "uint8", 1.40625, 0.0, wrap=360.0),
        Band("mslp", "hPa", "uint16", 0.1, 0.0),
        Band("speed", "kt", "uint8", 1.0, 0.0, nodata=255),
        Band("qpf", "in", "uint16", 0.01, 0.0, nodata=65535),
    ),
)
NAN = np.nan
VALUES = {
    "temp": np.array([[-80, -40, 0, 32], [33, 70, 98.6, 175], [200, -100, 50, 51]], dtype=float),
    "dir": np.array([[0, 90, 180, 270], [359, 1.4, 45, 315], [10, 20, 30, 40]], dtype=float),
    "mslp": np.array([[1013.25, 980.0, 1050.1, 870.0], [1000, 1001, 999.9, 1100], [1012, 1012, 1012, 1012]]),
    # nodata: NaN is stored as 255 / 65535; valid values clip to one below
    "speed": np.array([[NAN, 0, 10, 254], [255, 300, NAN, 100], [1, 2, 3, NAN]]),
    "qpf": np.array([[0, 0.01, NAN, 655.34], [655.35, 700, 1.5, NAN], [NAN, NAN, 0.25, 0]]),
}


def build() -> dict:
    raw = encode_frame(FIELD, VALUES, SHAPE)
    stored = {}
    for b in FIELD.bands:
        decoded = decode_band(encode_band(VALUES[b.name], b), b).ravel()
        stored[b.name] = [None if np.isnan(x) else round(float(x), 6) for x in decoded]
    return {
        "description": __doc__.strip().splitlines()[0],
        "frame_format": 3,
        "nx": SHAPE[1],
        "ny": SHAPE[0],
        "field": {"label": "demo", "min_fhr": 0, "frame_bytes": len(raw), "bands": [b.manifest() for b in FIELD.bands]},
        "raw_base64": base64.b64encode(raw).decode(),
        "decoded": stored,
    }


def run_file_frames() -> dict[str, dict[int, bytes]]:
    """Raw frames for the run file: the demo field at F000 and F006 (warmer), and a second field."""
    warmer = {**VALUES, "temp": VALUES["temp"] + 1}
    return {"demo": {0: encode_frame(FIELD, VALUES, SHAPE), 6: encode_frame(FIELD, warmer, SHAPE)},
            "other": {6: encode_frame(FIELD, VALUES, SHAPE)}}


def build_run_file() -> dict:
    raw = run_file_frames()
    data = pack_frames({fid: {f: gzip_frame(r) for f, r in hours.items()} for fid, hours in raw.items()})
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    return {
        "description": "A run file holding two fields' frames (store.py); raw_base64 is each frame gunzipped",
        "container": CONTAINER,
        "header_probe": HEADER_PROBE,
        "nx": SHAPE[1],
        "ny": SHAPE[0],
        "run_file_base64": b64(data),
        "index": {fid: {str(f): list(span) for f, span in hours.items()} for fid, hours in read_index(data).items()},
        "raw_base64": {fid: {str(f): b64(r) for f, r in hours.items()} for fid, hours in raw.items()},
    }


def test_fixture_matches_encoder():
    assert json.loads(PATH.read_text()) == build()


def test_run_file_fixture_matches_the_container():
    # Compared through the container, not byte for byte: gzip's output can differ between zlib builds
    fixture = json.loads(RUN_FILE_PATH.read_text())
    data = base64.b64decode(fixture["run_file_base64"])
    frames = unpack_frames(data)
    assert pack_frames(frames) == data  # the container is deterministic
    assert {fid: {f: gzip.decompress(gz) for f, gz in hours.items()} for fid, hours in frames.items()} == run_file_frames()
    index = {fid: {str(f): list(span) for f, span in hours.items()} for fid, hours in read_index(data).items()}
    expected = build_run_file()
    assert (fixture["index"], fixture["raw_base64"]) == (index, expected["raw_base64"])
    assert {k: v for k, v in fixture.items() if k not in ("run_file_base64", "index")} == \
        {k: v for k, v in expected.items() if k not in ("run_file_base64", "index")}


if __name__ == "__main__":
    PATH.write_text(json.dumps(build(), indent=1) + "\n")
    RUN_FILE_PATH.write_text(json.dumps(build_run_file(), indent=1) + "\n")
    print(f"wrote {PATH} and {RUN_FILE_PATH}")
