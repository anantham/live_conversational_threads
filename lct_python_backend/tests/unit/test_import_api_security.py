import importlib
import sys
import types
from unittest.mock import patch

import pytest
from fastapi import HTTPException


def _load_import_api_with_stubs(monkeypatch):
    async def dummy_get_async_session():
        yield object()

    dummy_db_session = types.ModuleType("lct_python_backend.db_session")
    dummy_db_session.get_async_session = dummy_get_async_session

    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db_session)
    sys.modules.pop("lct_python_backend.import_api", None)
    return importlib.import_module("lct_python_backend.import_api")


def test_validate_import_url_accepts_public_https(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    validated = import_api._validate_import_url("https://example.com/transcript.txt")
    assert validated == "https://example.com/transcript.txt"


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.com/file.txt",
        "http://localhost:8000/internal",
        "http://127.0.0.1/file.txt",
        "http://10.0.0.4/private.txt",
        "http://[::1]/file.txt",
        "not-a-url",
    ],
)
def test_validate_import_url_rejects_disallowed_hosts_or_scheme(monkeypatch, url):
    import_api = _load_import_api_with_stubs(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        import_api._validate_import_url(url)

    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_import_health_hides_url_support_when_disabled(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    with patch.dict("os.environ", {"ENABLE_URL_IMPORT": "false"}, clear=False):
        payload = await import_api.health_check()

    assert payload["url_import_enabled"] is False
    assert "url" not in payload["supported_formats"]


@pytest.mark.asyncio
async def test_import_health_exposes_url_support_when_enabled(monkeypatch):
    import_api = _load_import_api_with_stubs(monkeypatch)
    with patch.dict("os.environ", {"ENABLE_URL_IMPORT": "true"}, clear=False):
        payload = await import_api.health_check()

    assert payload["url_import_enabled"] is True
    assert "url" in payload["supported_formats"]
