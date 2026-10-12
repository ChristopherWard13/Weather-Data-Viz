import json
import sys
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


GRIB_MODULES = ("gribapi", "eccodes", "cfgrib", "herbie")


def pytest_sessionfinish(session, exitstatus):
    """Keep the GRIB libraries out of the test process: tests that need them
    run in a worker (``tests/test_fetch.py:in_worker``). With ecCodes loaded,
    the Linux interpreter aborted at exit after every test had passed."""
    loaded = [m for m in GRIB_MODULES if m in sys.modules]
    if loaded and session.exitstatus == 0:
        print(f"\nthe test process imported {', '.join(loaded)}; run that test's GRIB work through in_worker()")
        session.exitstatus = 1
