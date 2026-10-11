import json
from pathlib import Path

import pytest

from wxtrend.config import REPO_ROOT, load_config

VECTORS = REPO_ROOT / "shared" / "test-vectors"


@pytest.fixture(scope="session")
def product():
    return load_config().product("gfs")


def load_vectors(name: str) -> list[dict]:
    return json.loads((VECTORS / name).read_text())["cases"]
