"""Unit tests for POST /api/conversations/{conversation_id}/reprocess."""
from __future__ import annotations

import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Minimal stubs so reprocess_api can be imported without heavy deps
# ---------------------------------------------------------------------------

def _stub_modules(monkeypatch):
    """Stub out every heavy import so the module loads in the unit-test runner.

    IMPORTANT: every attribute is set via monkeypatch (auto-reverted at test
    end). A previous version assigned attributes directly (`mod.attr = ...`)
    on modules that were often ALREADY imported for real — permanently
    poisoning the real modules for every later test in the run (e.g.
    stt_settings_service.load_stt_settings silently became an AsyncMock,
    breaking test_stt_settings_service and friends).
    """
    async def _fake_session_gen():
        yield object()

    db_session = types.ModuleType("lct_python_backend.db_session")
    db_session.get_async_session = _fake_session_gen
    monkeypatch.setitem(sys.modules, "lct_python_backend.db_session", db_session)

    for mod_name in [
        "lct_python_backend.services.audio_storage",
        "lct_python_backend.services.import_pipeline.import_bulk_processor",
        "lct_python_backend.services.file_transcriber",
        "lct_python_backend.services.import_pipeline.import_graph_refinement",
        "lct_python_backend.services.llm_config",
        "lct_python_backend.services.stt.stt_settings_service",
        "lct_python_backend.services.artifact_settings_service",
        "lct_python_backend.services.artifact_export_service",
        "lct_python_backend.services.transcript.transcript_processing",
        "lct_python_backend.services.import_pipeline.import_diarization_queue",
    ]:
        if mod_name not in sys.modules:
            monkeypatch.setitem(sys.modules, mod_name, types.ModuleType(mod_name))

    def _set(mod_name, attr, value):
        # raising=False: the attr may not exist when the module is a fresh stub.
        monkeypatch.setattr(sys.modules[mod_name], attr, value, raising=False)

    # Stub AudioStorageManager so the module-level instance is safe to patch
    _set("lct_python_backend.services.audio_storage", "AudioStorageManager", MagicMock())

    _bulk = "lct_python_backend.services.import_pipeline.import_bulk_processor"
    _set(_bulk, "build_process_file_stream", AsyncMock())
    _set(_bulk, "cleanup_temp_file", MagicMock())
    _set(_bulk, "copy_temp_upload_for_async_job", AsyncMock())
    _set(_bulk, "diarization_job_urls", MagicMock())

    _ft = "lct_python_backend.services.file_transcriber"
    _set(_ft, "chunk_transcript_lines", MagicMock())
    _set(_ft, "transcribe_audio_segmented", AsyncMock())
    _set(_ft, "transcribe_uploaded_file", AsyncMock())

    _set("lct_python_backend.services.import_pipeline.import_graph_refinement",
         "refine_import_graph_nodes", AsyncMock())

    _llm = "lct_python_backend.services.llm_config"
    _set(_llm, "load_llm_config", MagicMock())
    _set(_llm, "load_llm_providers", AsyncMock())

    _set("lct_python_backend.services.stt.stt_settings_service",
         "load_stt_settings", AsyncMock())

    _set("lct_python_backend.services.artifact_settings_service",
         "load_artifact_export_settings", AsyncMock())

    _set("lct_python_backend.services.artifact_export_service",
         "auto_export_conversation_artifacts", AsyncMock())

    _set("lct_python_backend.services.transcript.transcript_processing",
         "TranscriptProcessor", MagicMock())

    _dq = "lct_python_backend.services.import_pipeline.import_diarization_queue"
    _set(_dq, "enqueue_import_diarization_job", AsyncMock())
    _set(_dq, "is_async_import_diarization_enabled", MagicMock(return_value=False))


def _load_reprocess_api(monkeypatch):
    _stub_modules(monkeypatch)
    # Force re-import so the stubs are picked up
    sys.modules.pop("lct_python_backend.reprocess_api", None)
    import importlib
    mod = importlib.import_module("lct_python_backend.reprocess_api")
    # Don't leak the stub-bound module: re-register it via monkeypatch with
    # "missing" as the recorded prior state, so teardown drops it and any
    # later test re-imports reprocess_api fresh against the real deps.
    saved = sys.modules.pop("lct_python_backend.reprocess_api")
    monkeypatch.setitem(sys.modules, "lct_python_backend.reprocess_api", saved)
    return mod


def _make_request():
    return MagicMock()  # reprocess_api passes request straight to build_process_file_stream


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_returns_404_when_no_audio_on_disk(monkeypatch):
    mod = _load_reprocess_api(monkeypatch)
    with patch.object(mod._audio_storage, "_find_source_audio", return_value=None):
        resp = await mod.reprocess_conversation(
            conversation_id="no-such-conv",
            request=_make_request(),
            db=MagicMock(),
        )
    assert resp.status_code == 404
    import json
    body = json.loads(resp.body)
    assert "no-such-conv" in body["detail"]
    assert "stored audio" in body["detail"].lower()


@pytest.mark.asyncio
async def test_path_traversal_id_returns_404(monkeypatch):
    """A crafted conversation_id that escapes the recordings dir must not open
    any file — AudioStorageManager._conversation_path raises ValueError which
    _find_source_audio catches and returns None.  The endpoint sees None → 404."""
    mod = _load_reprocess_api(monkeypatch)
    with patch.object(mod._audio_storage, "_find_source_audio", return_value=None):
        resp = await mod.reprocess_conversation(
            conversation_id="../../etc/passwd",
            request=_make_request(),
            db=MagicMock(),
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delegates_to_build_process_file_stream_with_correct_id(monkeypatch, tmp_path):
    """When stored audio exists, the endpoint copies it to a temp file and
    delegates to build_process_file_stream, passing conversation_id through."""
    mod = _load_reprocess_api(monkeypatch)

    fake_audio = tmp_path / "abc123.wav"
    fake_audio.write_bytes(b"RIFF")  # needs to exist for shutil.copy2

    sentinel_response = object()

    with (
        patch.object(mod._audio_storage, "_find_source_audio", return_value=fake_audio),
        patch("lct_python_backend.reprocess_api.build_process_file_stream", new=AsyncMock(return_value=sentinel_response)) as mock_bps,
        patch("lct_python_backend.reprocess_api.shutil.copy2"),
        patch("lct_python_backend.reprocess_api.tempfile.NamedTemporaryFile") as mock_ntf,
    ):
        # NamedTemporaryFile returns an object with .name and .close()
        mock_ntf.return_value.__enter__ = MagicMock()
        mock_ntf.return_value.__exit__ = MagicMock()
        mock_ntf.return_value.name = str(tmp_path / "reprocess_tmp.wav")
        mock_ntf.return_value.close = MagicMock()

        result = await mod.reprocess_conversation(
            conversation_id="abc123",
            request=_make_request(),
            db=MagicMock(),
        )

    assert result is sentinel_response
    assert mock_bps.called
    call_kwargs = mock_bps.call_args.kwargs
    assert call_kwargs["conversation_id"] == "abc123"


@pytest.mark.asyncio
async def test_stored_audio_file_shim_has_expected_filename(monkeypatch, tmp_path):
    """_StoredAudioFile.filename reflects the conversation_id + suffix so the
    downstream pipeline can log the correct filename."""
    mod = _load_reprocess_api(monkeypatch)
    fake_audio = tmp_path / "myconv.flac"
    fake_audio.write_bytes(b"fLaC")

    with (
        patch.object(mod._audio_storage, "_find_source_audio", return_value=fake_audio),
        patch("lct_python_backend.reprocess_api.build_process_file_stream", new=AsyncMock()) as mock_bps,
        patch("lct_python_backend.reprocess_api.shutil.copy2"),
        patch("lct_python_backend.reprocess_api.tempfile.NamedTemporaryFile") as mock_ntf,
    ):
        mock_ntf.return_value.name = str(tmp_path / "reprocess_tmp.flac")
        mock_ntf.return_value.close = MagicMock()

        await mod.reprocess_conversation(
            conversation_id="myconv",
            request=_make_request(),
            db=MagicMock(),
        )

    file_shim = mock_bps.call_args.kwargs["file"]
    assert file_shim.filename == "myconv.flac"
