from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import cdf_integration, main, storage


@pytest.fixture(autouse=True)
def isolate_db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    db_file = tmp_path / "state.sqlite3"
    monkeypatch.setattr(storage, "db_path", lambda: db_file)
    monkeypatch.setattr(cdf_integration, "_ensure_loaded", lambda: None)
    monkeypatch.setattr(cdf_integration, "warmup", lambda *_args, **_kwargs: 0.0)
    storage.init_db()
    yield


@pytest.fixture
def client() -> TestClient:
    with TestClient(main.app) as c:
        yield c


@pytest.fixture
def png_bytes() -> bytes:
    img = Image.new("RGB", (32, 32), (255, 255, 255))
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()
