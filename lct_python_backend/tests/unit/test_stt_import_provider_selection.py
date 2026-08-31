"""Behavioral tests for ADR-066 import STT authority resolution.

Test intent:
- Endpoint preferences and provider overrides never mint authority.
- Import order comes only from explicit owner-approved local records.
- A session-scoped BYOK grant authorizes only its matching provider.
"""

from lct_python_backend.services.byok_session_store import (
    build_runtime_stt_settings_for_byok,
)
from lct_python_backend.services.provider_selection import resolve_import_audio_candidates


def _settings():
    return {
        "local_authorities": [
            {
                "id": "m5",
                "enabled": True,
                "provider": "parakeet",
                "http_url": "https://m5.example.test/v1/audio/transcriptions",
                "supports_diarization": True,
            },
            {
                "id": "asus",
                "enabled": True,
                "provider": "whisper",
                "http_url": "http://asus.example.test/api/transcribe",
                "supports_diarization": True,
            },
        ],
        "cloud_fallback_providers": {
            "openai_audio": {
                "enabled": True,
                "base_url": "https://api.openai.com",
                "model": "gpt-4o-mini-transcribe",
                "diarize_model": "gpt-4o-transcribe-diarize",
                "api_key": "saved-key-is-not-authority",
            }
        },
    }


def test_import_uses_explicit_local_authority_order_only():
    settings = _settings()
    settings["provider_http_urls"] = {
        "openai_audio": "https://api.openai.com/v1/audio/transcriptions",
        "whisper": "https://unapproved.example/transcribe",
    }

    candidates = resolve_import_audio_candidates(
        settings=settings,
        provider_override="openai_audio",
    )

    assert [candidate["authority_id"] for candidate in candidates] == ["m5", "asus"]
    assert all(candidate["authority_scope"] == "owner_approved_local" for candidate in candidates)


def test_import_without_authority_fails_closed():
    candidates = resolve_import_audio_candidates(
        settings={
            "provider": "openai_audio",
            "provider_http_urls": {
                "openai_audio": "https://api.openai.com/v1/audio/transcriptions"
            },
            "cloud_fallback_providers": _settings()["cloud_fallback_providers"],
        },
        provider_override="openai_audio",
    )

    assert candidates == []


def test_validated_byok_is_scoped_to_the_matching_requested_provider():
    runtime = build_runtime_stt_settings_for_byok(
        _settings(),
        {
            "provider": "openai_audio",
            "base_url": "https://api.openai.com",
            "model": "gpt-4o-mini-transcribe",
            "diarize_model": "gpt-4o-transcribe-diarize",
            "api_key": "session-key",
        },
    )

    granted = resolve_import_audio_candidates(
        settings=runtime,
        provider_override="openai_audio",
    )
    mismatched = resolve_import_audio_candidates(
        settings=runtime,
        provider_override="openrouter_audio",
    )

    assert granted[0]["provider"] == "openai_audio"
    assert granted[0]["authority_scope"] == "validated_session_byok"
    assert [candidate["authority_id"] for candidate in granted[1:]] == ["m5", "asus"]
    assert [candidate["authority_id"] for candidate in mismatched] == ["m5", "asus"]
