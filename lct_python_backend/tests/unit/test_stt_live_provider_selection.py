from lct_python_backend.services.stt_live_provider_selection import (
    build_live_stt_background_refinement_candidate,
    resolve_live_stt_candidates,
)


def test_resolve_live_stt_candidates_prefers_remote_whisper_then_openai_when_diarization_required():
    candidates = resolve_live_stt_candidates(
        settings={
            "provider": "parakeet",
            "provider_http_urls": {
                "parakeet": "http://localhost:5092/v1/audio/transcriptions",
                "whisper": "http://100.81.65.74:7777/api/transcribe",
            },
            "http_url": "http://localhost:5092/v1/audio/transcriptions",
            "local_only": False,
            "live_cloud_fallback_enabled": True,
            "live_require_diarization": True,
            "live_allow_text_only_fallback": False,
            "cloud_fallback_providers": {
                "openai_audio": {
                    "enabled": True,
                    "base_url": "https://api.openai.com",
                    "model": "gpt-4o-mini-transcribe",
                    "diarize_model": "gpt-4o-transcribe-diarize",
                    "api_key": "sk-openai-secret",
                },
                "openrouter_audio": {
                    "enabled": True,
                    "base_url": "https://openrouter.ai/api",
                    "model": "google/gemini-2.5-flash",
                    "api_key": "or-secret",
                },
            },
        },
        provider_override="parakeet",
    )

    assert [candidate["provider"] for candidate in candidates] == [
        "parakeet",
        "whisper",
        "openai_audio",
    ]
    assert [candidate["transport"] for candidate in candidates] == [
        "backend_http",
        "backend_http",
        "openai_audio",
    ]
    assert candidates[2]["request_diarization"] is False


def test_resolve_live_stt_candidates_respects_configured_fallback_priority():
    candidates = resolve_live_stt_candidates(
        settings={
            "provider": "parakeet",
            "provider_http_urls": {
                "parakeet": "http://localhost:5092/v1/audio/transcriptions",
                "whisper": "http://100.81.65.74:7777/api/transcribe",
            },
            "http_url": "http://localhost:5092/v1/audio/transcriptions",
            "local_only": False,
            "external_fallback_http_url": "https://fallback.example.com/api/transcribe",
            "live_cloud_fallback_enabled": True,
            "live_require_diarization": False,
            "live_allow_text_only_fallback": True,
            "live_fallback_priority": [
                "openai_audio",
                "external_http",
                "remote_whisper",
                "openrouter_audio",
            ],
            "cloud_fallback_providers": {
                "openai_audio": {
                    "enabled": True,
                    "base_url": "https://api.openai.com",
                    "model": "gpt-4o-mini-transcribe",
                    "diarize_model": "gpt-4o-transcribe-diarize",
                    "api_key": "sk-openai-secret",
                },
                "openrouter_audio": {
                    "enabled": True,
                    "base_url": "https://openrouter.ai/api",
                    "model": "google/gemini-2.5-flash",
                    "api_key": "or-secret",
                },
            },
        },
        provider_override="parakeet",
    )

    assert [candidate["route_id"] for candidate in candidates] == [
        "configured_provider",
        "openai_audio",
        "external_http",
        "remote_whisper",
        "openrouter_audio",
    ]


def test_resolve_live_stt_candidates_allows_openrouter_when_text_only_fallback_is_enabled():
    candidates = resolve_live_stt_candidates(
        settings={
            "provider": "whisper",
            "provider_http_urls": {
                "whisper": "http://100.81.65.74:7777/api/transcribe",
            },
            "http_url": "http://100.81.65.74:7777/api/transcribe",
            "local_only": False,
            "live_cloud_fallback_enabled": True,
            "live_require_diarization": False,
            "live_allow_text_only_fallback": True,
            "cloud_fallback_providers": {
                "openrouter_audio": {
                    "enabled": True,
                    "base_url": "https://openrouter.ai/api",
                    "model": "google/gemini-2.5-flash",
                    "api_key": "or-secret",
                },
            },
        },
        provider_override="whisper",
    )

    assert [candidate["provider"] for candidate in candidates] == [
        "whisper",
        "openrouter_audio",
    ]
    assert candidates[1]["transport"] == "openrouter_audio"
    assert candidates[1]["degraded"] is True
    assert candidates[1]["supports_diarization"] is False


def test_resolve_live_stt_candidates_prefers_openai_before_remote_whisper_when_whisper_is_primary_remote_route():
    candidates = resolve_live_stt_candidates(
        settings={
            "provider": "whisper",
            "provider_http_urls": {
                "whisper": "http://100.81.65.74:7777/api/transcribe",
            },
            "http_url": "http://100.81.65.74:7777/api/transcribe",
            "local_only": False,
            "live_cloud_fallback_enabled": True,
            "live_require_diarization": True,
            "live_allow_text_only_fallback": False,
            "live_fallback_priority": [
                "openai_audio",
                "remote_whisper",
                "external_http",
                "openrouter_audio",
            ],
            "cloud_fallback_providers": {
                "openai_audio": {
                    "enabled": True,
                    "base_url": "https://api.openai.com",
                    "model": "gpt-4o-mini-transcribe",
                    "diarize_model": "gpt-4o-transcribe-diarize",
                    "api_key": "sk-openai-secret",
                },
            },
        },
        provider_override="whisper",
    )

    assert [candidate["route_id"] for candidate in candidates] == [
        "openai_audio",
        "configured_provider",
    ]
    assert [candidate["provider"] for candidate in candidates] == [
        "openai_audio",
        "whisper",
    ]
    assert candidates[0]["request_diarization"] is False


def test_build_live_stt_background_refinement_candidate_uses_separate_diarize_model():
    primary_candidate = {
        "provider": "openai_audio",
        "transport": "openai_audio",
        "model": "gpt-4o-mini-transcribe",
        "http_url": "https://api.openai.com/v1/audio/transcriptions",
    }

    candidate = build_live_stt_background_refinement_candidate(
        settings={
            "live_require_diarization": True,
            "cloud_fallback_providers": {
                "openai_audio": {
                    "enabled": True,
                    "base_url": "https://api.openai.com",
                    "model": "gpt-4o-mini-transcribe",
                    "diarize_model": "gpt-4o-transcribe-diarize",
                    "api_key": "sk-openai-secret",
                }
            },
        },
        primary_candidate=primary_candidate,
    )

    assert candidate is not None
    assert candidate["route_id"] == "openai_audio_diarize_background"
    assert candidate["model"] == "gpt-4o-transcribe-diarize"
    assert candidate["request_diarization"] is True
