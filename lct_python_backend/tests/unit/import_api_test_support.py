"""Shared stubs and helpers for import API unit tests."""

from __future__ import annotations

import importlib
import json
import sys
import types
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

try:
    from google import genai as _google_genai  # noqa: F401
except ImportError:
    google_module = sys.modules.get("google")
    if google_module is None:
        google_module = types.ModuleType("google")
        sys.modules["google"] = google_module

    genai_module = types.ModuleType("google.genai")

    class _UnavailableGenaiClient:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("google-genai test stub should not be used at runtime")

    genai_module.Client = _UnavailableGenaiClient
    types_module = types.ModuleType("google.genai.types")
    genai_module.types = types_module
    setattr(google_module, "genai", genai_module)
    sys.modules["google.genai"] = genai_module
    sys.modules["google.genai.types"] = types_module

try:
    from pydub import AudioSegment as _PydubAudioSegment  # noqa: F401
except ImportError:
    pydub_module = types.ModuleType("pydub")

    class _StubAudioSegment:
        pass

    silence_module = types.ModuleType("pydub.silence")
    silence_module.detect_silence = lambda *args, **kwargs: []
    pydub_module.AudioSegment = _StubAudioSegment
    pydub_module.silence = silence_module
    sys.modules["pydub"] = pydub_module
    sys.modules["pydub.silence"] = silence_module

try:
    import pdfplumber as _pdfplumber  # noqa: F401
except ImportError:
    pdfplumber_module = types.ModuleType("pdfplumber")

    def _pdfplumber_open(*args, **kwargs):
        raise RuntimeError("pdfplumber test stub should not be used at runtime")

    pdfplumber_module.open = _pdfplumber_open
    sys.modules["pdfplumber"] = pdfplumber_module


def load_import_api_with_stubs(monkeypatch):
    async def dummy_get_async_session():
        yield object()

    dummy_db_session = types.ModuleType("lct_python_backend.db_session")
    dummy_db_session.get_async_session = dummy_get_async_session

    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", dummy_db_session)
    sys.modules.pop("lct_python_backend.import_api", None)
    module = importlib.import_module("lct_python_backend.import_api")
    monkeypatch.setattr(
        module,
        "load_artifact_export_settings",
        AsyncMock(
            return_value={
                "enabled": False,
                "root_path": "",
                "write_canvas": True,
                "write_transcript": True,
                "include_chunks": False,
                "trigger_on_import_complete": True,
                "trigger_on_live_finalize": False,
            }
        ),
    )
    monkeypatch.setattr(
        module,
        "auto_export_conversation_artifacts",
        AsyncMock(return_value={"ok": True, "written_files": []}),
    )
    return module


def build_test_client(import_api_module):
    app = FastAPI()
    app.include_router(import_api_module.router)
    return TestClient(app)


def parse_sse_events(raw_stream: str):
    events = []
    current_event = "message"
    data_lines = []

    for line in raw_stream.splitlines():
        if line == "":
            if data_lines:
                payload = json.loads("\n".join(data_lines))
                events.append((current_event, payload))
            current_event = "message"
            data_lines = []
            continue

        if line.startswith("event:"):
            current_event = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            data_lines.append(line.split(":", 1)[1].strip())

    if data_lines:
        payload = json.loads("\n".join(data_lines))
        events.append((current_event, payload))
    return events