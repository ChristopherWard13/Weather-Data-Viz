"""Cross-language frame contract (frame format v3).

shared/test-vectors/frames.json holds small frames encoded by this pipeline;
web/tests/frames.test.ts decodes the same bytes. This test fails if the
encoder's output changes, so the two sides can't drift apart silently.
In "decoded", null marks a nodata sample (JSON has no NaN).
Regenerate with:  uv run python -m tests.test_contract
"""

import base64
import json

import numpy as np

from wxtrend.config import REPO_ROOT, Band, FieldSpec
from wxtrend.fields import decode_band, encode_band
from wxtrend.store import encode_frame

PATH = REPO_ROOT / "shared" / "test-vectors" / "frames.json"
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


def test_fixture_matches_encoder():
    assert json.loads(PATH.read_text()) == build()


if __name__ == "__main__":
    PATH.write_text(json.dumps(build(), indent=1) + "\n")
    print(f"wrote {PATH}")
