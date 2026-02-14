import importlib
import sys
import types

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _load_bookmarks_api_with_stubs(monkeypatch):
    async def dummy_get_async_session():
        yield object()

    dummy_db_session = types.ModuleType("lct_python_backend.db_session")
    dummy_db_session.get_async_session = dummy_get_async_session

    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db_session)
    sys.modules.pop("lct_python_backend.bookmarks_api", None)
    return importlib.import_module("lct_python_backend.bookmarks_api")


def test_bookmarks_health_route_not_shadowed_by_bookmark_id(monkeypatch):
    bookmarks_api = _load_bookmarks_api_with_stubs(monkeypatch)

    app = FastAPI()
    app.include_router(bookmarks_api.router)

    client = TestClient(app)
    response = client.get("/api/bookmarks/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "healthy"
    assert payload["service"] == "bookmarks_api"
