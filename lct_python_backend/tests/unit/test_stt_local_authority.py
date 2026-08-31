"""Behavioral contract for ADR-066's explicit local STT authority set.

Test intent:
- Live and import resolution use owner-approved M5 then Asus records, not URL heuristics.
- A disabled/unavailable primary can fall through only to another approved local authority.
- Saved cloud configuration and ordinary provider overrides never authorize cloud egress.
- A validated session-scoped BYOK overlay authorizes only its requested cloud provider.
- Segmented transcription consumes the same ordered candidates and retains authority identity.
"""

from pathlib import Path

import pytest

from lct_python_backend.services import audio_transcriber
from lct_python_backend.services.byok_session_store import (
    build_runtime_stt_settings_for_byok,
)
from lct_python_backend.services.provider_selection import resolve_import_audio_candidates
from lct_python_backend.services.stt.stt_live_provider_selection import (
    resolve_live_stt_candidates,
)


def _authority_settings(*, m5_enabled: bool = True, asus_enabled: bool = True):
    return {
        "provider": "openai_audio",
        "local_only": False,
        "local_authorities": [
            {
                "id": "m5",
                "enabled": m5_enabled,
                "provider": "parakeet",
                "http_url": "https://m5.example.test/v1/audio/transcriptions",
                "supports_diarization": True,
            },
            {
                "id": "asus",
                "enabled": asus_enabled,
                "provider": "whisper",
                "http_url": "http://asus.example.test/api/transcribe",
                "ws_url": "ws://asus.example.test/api/transcribe/stream",
                "supports_diarization": True,
            },
        ],
        "cloud_fallback_providers": {
            "openai_audio": {
                "enabled": True,
                "base_url": "https://api.openai.com",
                "model": "gpt-4o-mini-transcribe",
                "diarize_model": "gpt-4o-transcribe-diarize",
                "api_key": "saved-key-must-not-grant-egress",
            }
        },
    }


def test_live_and_import_share_m5_then_asus_authority_order():
    settings = _authority_settings()

    live = resolve_live_stt_candidates(
        settings=settings,
        provider_override="openai_audio",
    )
    imported = resolve_import_audio_candidates(
        settings=settings,
        provider_override="openai_audio",
    )

    assert [candidate["authority_id"] for candidate in live] == ["m5", "asus"]
    assert [candidate["authority_id"] for candidate in imported] == ["m5", "asus"]
    assert all(candidate["authority_scope"] == "owner_approved_local" for candidate in live)
    assert all(candidate["provider"] != "openai_audio" for candidate in live + imported)


def test_disabled_m5_falls_through_to_asus_and_local_exhaustion_is_terminal():
    asus_only = resolve_import_audio_candidates(
        settings=_authority_settings(m5_enabled=False),
        provider_override=None,
    )
    exhausted = resolve_live_stt_candidates(
        settings=_authority_settings(m5_enabled=False, asus_enabled=False),
        provider_override="openai_audio",
    )

    assert [candidate["authority_id"] for candidate in asus_only] == ["asus"]
    assert exhausted == []


def test_validated_byok_overlay_is_the_only_cloud_authority():
    settings = _authority_settings()
    runtime = build_runtime_stt_settings_for_byok(
        settings,
        {
            "provider": "openai_audio",
            "base_url": "https://api.openai.com",
            "model": "gpt-4o-mini-transcribe",
            "diarize_model": "gpt-4o-transcribe-diarize",
            "api_key": "session-key",
        },
    )

    candidates = resolve_import_audio_candidates(
        settings=runtime,
        provider_override="openai_audio",
    )

    assert candidates[0]["provider"] == "openai_audio"
    assert candidates[0]["authority_scope"] == "validated_session_byok"
    assert candidates[0]["api_key"] == "session-key"
    assert [candidate["authority_id"] for candidate in candidates[1:]] == ["m5", "asus"]


@pytest.mark.asyncio
async def test_segmented_transcription_falls_back_across_the_resolved_authority_set(
    monkeypatch,
    tmp_path: Path,
):
    source = tmp_path / "meeting.wav"
    source.write_bytes(b"source")
    segment = tmp_path / "segment.wav"
    calls = []

    monkeypatch.setattr(audio_transcriber, "detect_segment_boundaries", lambda *_args, **_kwargs: [0, 1000])

    def _extract(*_args, **_kwargs):
        segment.write_bytes(b"segment")
        return segment

    async def _transcribe(_path, *, http_url, **_kwargs):
        calls.append(http_url)
        if "m5.example.test" in http_url:
            raise ConnectionError("M5 unavailable")
        return "Asus completed the segment."

    monkeypatch.setattr(audio_transcriber, "extract_audio_segment", _extract)
    monkeypatch.setattr(audio_transcriber, "transcribe_audio_chunked", _transcribe)

    candidates = resolve_import_audio_candidates(
        settings=_authority_settings(),
        provider_override=None,
    )
    results = [
        result
        async for result in audio_transcriber.transcribe_audio_segmented(
            source,
            http_url=candidates[0]["http_url"],
            candidates=candidates,
        )
    ]

    assert calls == [
        "https://m5.example.test/v1/audio/transcriptions",
        "http://asus.example.test/api/transcribe",
    ]
    assert results[0].transcript_text == "Asus completed the segment."
    assert results[0].metadata["authority_id"] == "asus"
