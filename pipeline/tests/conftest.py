import json
from pathlib import Path

import pytest

from wxtrend.config import REPO_ROOT, load_config
from wxtrend.store import R2_ENV

VECTORS = REPO_ROOT / "shared" / "test-vectors"


@pytest.fixture(scope="session")
def product():
    return load_config().product("gfs")


def load_vectors(name: str) -> list[dict]:
    return json.loads((VECTORS / name).read_text())["cases"]


@pytest.fixture(autouse=True)
def no_real_bucket(monkeypatch):
    """No test may reach the real R2 bucket: drop the credentials and refuse to build a client."""
    import boto3

    for name in R2_ENV:
        monkeypatch.delenv(name, raising=False)

    def refuse(*args, **kwargs):
        raise AssertionError("tests must use tests/fake_s3.py, never a real S3 client")

    monkeypatch.setattr(boto3, "client", refuse)
