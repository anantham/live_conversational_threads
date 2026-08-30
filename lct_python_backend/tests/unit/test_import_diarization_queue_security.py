"""Behavioral and security intent for delayed diarization jobs.

- Queuing must not retain credential-shaped fields at any nesting depth.
- Foreground provider/BYOK authority must not survive into delayed execution.
- Delayed STT may retain configured non-secret local endpoints, but cloud and
  external fallback routes must be removed and local-only routing made explicit.
- The worker must receive the sanitized settings through its normal public
  enqueue/process behavior, not merely through a helper-level assertion.
"""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from types import SimpleNamespace

import pytest

from lct_python_backend.services.import_pipeline import import_diarization_queue as queue_module


def _assert_no_secret_keys(value):
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = str(key).strip().lower()
            assert normalized not in {
                "api_key",
                "access_token",
                "refresh_token",
                "token",
                "secret",
                "password",
            }
            assert not normalized.endswith(("_api_key", "_token", "_secret", "_password"))
            _assert_no_secret_keys(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _assert_no_secret_keys(item)


def test_queue_sanitizers_strip_nested_credentials_and_cloud_authority():
    sanitized = queue_module._sanitize_stt_settings_for_queue({
        "provider": "openai_audio",
        "http_url": "https://api.openai.com/v1/audio/transcriptions",
        "provider_http_urls": {
            "parakeet": "http://127.0.0.1:5092/v1/audio/transcriptions",
            "whisper": "http://100.81.65.74:7777/api/transcribe",
            "openai_audio": "https://api.openai.com/v1/audio/transcriptions",
        },
        "cloud_fallback_providers": {
            "openai_audio": {
                "enabled": True,
                "api_key": "must-not-survive",
                "nested": {"refresh_token": "must-not-survive"},
            },
        },
        "external_fallback_http_url": "https://third-party.example/transcribe",
        "live_cloud_fallback_enabled": True,
        "upload_remote_fallback": True,
        "download_token": "must-not-survive",
    })

    _assert_no_secret_keys(sanitized)
    assert "provider" not in sanitized
    assert "http_url" not in sanitized
    assert sanitized["provider_http_urls"] == {
        "parakeet": "http://127.0.0.1:5092/v1/audio/transcriptions",
        "whisper": "http://100.81.65.74:7777/api/transcribe",
    }
    assert "cloud_fallback_providers" not in sanitized
    assert "external_fallback_http_url" not in sanitized
    assert sanitized["local_only"] is True
    assert sanitized["live_cloud_fallback_enabled"] is False
    assert sanitized["upload_remote_fallback"] is False


def test_public_enqueue_worker_receives_only_sanitized_delayed_state(monkeypatch, tmp_path):
    captured = {}

    async def fake_transcribe_uploaded_file(**kwargs):
        captured["transcribe"] = kwargs
        return SimpleNamespace(
            transcript_text="A: delayed local transcript",
            source_type="audio",
            metadata={"provider": "parakeet", "timings_ms": {}},
            speaker_segments=[],
        )

    class FakeProcessor:
        def __init__(self, *, llm_config, **_kwargs):
            captured["llm_config"] = llm_config
            self.existing_json = []
            self.chunk_dict = {}

        async def handle_final_text(self, text):
            self.existing_json = [{"id": "n1", "node_name": text}]
            self.chunk_dict = {"c1": text}

        async def flush(self):
            return None

    monkeypatch.setattr(queue_module, "transcribe_uploaded_file", fake_transcribe_uploaded_file)
    monkeypatch.setattr(queue_module, "TranscriptProcessor", FakeProcessor)

    async def scenario():
        audio_path = tmp_path / "audio.wav"
        audio_path.write_bytes(b"RIFF-test")
        queue = queue_module.ImportDiarizationQueue()
        snapshot = await queue.enqueue(
            audio_path=Path(audio_path),
            filename="audio.wav",
            content_type="audio/wav",
            source_type_override="audio",
            provider_override="openai_audio",
            conversation_id="conversation-1",
            speaker_id="speaker-1",
            stt_settings={
                "provider": "whisper",
                "provider_http_urls": {
                    "whisper": "http://100.81.65.74:7777/api/transcribe",
                },
                "cloud_fallback_providers": {
                    "openai_audio": {"api_key": "must-not-survive"},
                },
            },
            llm_config={
                "mode": "local",
                "model": "qwen3.8:latest",
                "nested": {"access_token": "must-not-survive"},
            },
            source_metadata={"session_token": "must-not-survive"},
        )

        try:
            for _ in range(100):
                current = await queue.get_job(snapshot["job_id"])
                if current and current["status"] in {"completed", "failed"}:
                    break
                await asyncio.sleep(0.01)
            else:
                pytest.fail("Delayed diarization worker did not reach a terminal state")

            assert current["status"] == "completed"
            transcribe = captured["transcribe"]
            assert transcribe["provider_override"] is None
            assert transcribe["stt_settings"]["provider"] == "whisper"
            assert transcribe["stt_settings"]["local_only"] is True
            assert "cloud_fallback_providers" not in transcribe["stt_settings"]
            _assert_no_secret_keys(transcribe["stt_settings"])
            assert captured["llm_config"] == {
                "mode": "local",
                "model": "qwen3.8:latest",
                "nested": {},
            }
            _assert_no_secret_keys(captured["llm_config"])
            # Security-sensitive custody assertion: public snapshots correctly
            # hide request state, so inspect the retained serialization boundary
            # directly to prove the secret values never entered queue memory.
            retained_request = queue._jobs[snapshot["job_id"]].request
            assert "must-not-survive" not in repr(retained_request)
            assert retained_request["provider_override"] is None
            assert "source_metadata" not in retained_request
            _assert_no_secret_keys(retained_request)
        finally:
            if queue._worker_task:
                queue._worker_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await queue._worker_task

    asyncio.run(scenario())
