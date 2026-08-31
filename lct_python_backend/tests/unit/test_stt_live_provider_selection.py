"""Behavioral tests for ADR-066 live STT authority resolution.

Test intent:
- Saved endpoint maps and cloud preferences are not authority.
- Explicit local authorities retain their configured order and websocket derivation.
- Background diarization stays inside that authority set.
- Cloud background work requires the same validated session BYOK grant.
"""

from lct_python_backend.services.byok_session_store import (
    build_runtime_stt_settings_for_byok,
)
from lct_python_backend.services.stt.stt_live_provider_selection import (
    build_live_stt_background_refinement_candidate,
    resolve_live_stt_candidates,
)


def _settings():
    return {
        "live_require_diarization": True,
        "local_authorities": [
            {
                "id": "m5",
                "enabled": True,
                "provider": "parakeet",
                "http_url": "https://m5.example.test/v1/audio/transcriptions",
                "supports_diarization": False,
            },
            {
                "id": "asus",
                "enabled": True,
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
                "api_key": "saved-key-is-not-authority",
            }
        },
    }


def test_live_candidates_ignore_saved_routes_and_preserve_local_authority_order():
    settings = _settings()
    settings["provider_http_urls"] = {
        "openai_audio": "https://api.openai.com/v1/audio/transcriptions",
        "whisper": "https://unapproved.example/transcribe",
    }

    candidates = resolve_live_stt_candidates(
        settings=settings,
        provider_override="openai_audio",
    )

    assert [candidate["authority_id"] for candidate in candidates] == ["m5", "asus"]
    assert [candidate["provider"] for candidate in candidates] == ["parakeet", "whisper"]
    assert candidates[1]["ws_url"] == "ws://asus.example.test/api/transcribe/stream"
    assert candidates[1]["supports_realtime_streaming"] is True


def test_background_refinement_uses_next_approved_local_diarizer():
    settings = _settings()
    primary = resolve_live_stt_candidates(settings=settings, provider_override=None)[0]

    candidate = build_live_stt_background_refinement_candidate(
        settings=settings,
        primary_candidate=primary,
    )

    assert candidate is not None
    assert candidate["authority_id"] == "asus"
    assert candidate["authority_scope"] == "owner_approved_local"
    assert candidate["request_diarization"] is True


def test_live_whisper_background_refinement_retains_authority_identity():
    settings = _settings()
    primary = resolve_live_stt_candidates(settings=settings, provider_override=None)[1]

    candidate = build_live_stt_background_refinement_candidate(
        settings=settings,
        primary_candidate=primary,
    )

    assert candidate is not None
    assert candidate["route_id"] == "whisper_diarize_background"
    assert candidate["authority_id"] == "asus"
    assert candidate["request_diarization"] is True


def test_validated_byok_can_create_matching_cloud_background_refinement():
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
    runtime["local_authorities"] = []
    primary = resolve_live_stt_candidates(
        settings=runtime,
        provider_override="openai_audio",
    )[0]

    candidate = build_live_stt_background_refinement_candidate(
        settings=runtime,
        primary_candidate=primary,
    )

    assert candidate is not None
    assert candidate["authority_scope"] == "validated_session_byok"
    assert candidate["model"] == "gpt-4o-transcribe-diarize"
    assert candidate["api_key"] == "session-key"


def test_saved_cloud_configuration_cannot_create_background_refinement():
    candidate = build_live_stt_background_refinement_candidate(
        settings={
            "live_require_diarization": True,
            "cloud_fallback_providers": _settings()["cloud_fallback_providers"],
        },
        primary_candidate={
            "provider": "parakeet",
            "transport": "backend_http",
            "supports_diarization": False,
        },
    )

    assert candidate is None
