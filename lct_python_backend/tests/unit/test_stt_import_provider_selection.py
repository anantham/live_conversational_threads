"""Tests for ``resolve_import_audio_candidates`` — the LCT upload STT routing.

Separate from the live STT tests (``test_stt_live_provider_selection.py``)
because import/upload audio has different routing priorities — quality and
cost matter more than time-to-first-token.

The 2026-05-31 change makes ``upload_local_first`` actually win for uploads
when a local URL is configured, instead of being silently shadowed by the
cloud-primary block. Cloud remains available via ``fallback_enabled``.
"""

from lct_python_backend.services.provider_selection import (
    resolve_import_audio_candidates,
)


def _openai_provider_block():
    return {
        "enabled": True,
        "base_url": "https://api.openai.com",
        "model": "gpt-4o-mini-transcribe",
        "diarize_model": "gpt-4o-transcribe-diarize",
        "api_key": "sk-openai-secret",
    }


def test_local_first_wins_primary_when_local_url_configured():
    """upload_local_first=true + local parakeet URL → parakeet primary, not OpenAI.

    Pre-2026-05-31 this returned OpenAI as primary because the cloud-primary
    block ran before the local_first block.
    """
    candidates = resolve_import_audio_candidates(
        settings={
            "provider": "whisper",
            "provider_http_urls": {
                "parakeet": "http://127.0.0.1:5092/v1/audio/transcriptions",
            },
            "upload_local_first": True,
            "upload_remote_fallback": True,
            "live_cloud_fallback_enabled": True,
            "cloud_fallback_providers": {"openai_audio": _openai_provider_block()},
        },
        provider_override=None,
    )

    assert candidates, "expected at least one candidate"
    assert candidates[0]["provider"] == "parakeet"
    assert candidates[0]["reason"] == "local_first"
    # OpenAI still present as fallback when upload_remote_fallback enabled.
    providers = [c["provider"] for c in candidates]
    assert "openai_audio" in providers


def test_cloud_remains_primary_when_no_local_url():
    """No local URL configured → cloud (OpenAI) is still the primary.

    Regression guard: the change must not break the cloud-only case.
    """
    candidates = resolve_import_audio_candidates(
        settings={
            "provider": "whisper",
            "provider_http_urls": {},  # no local urls
            "upload_local_first": True,
            "live_cloud_fallback_enabled": True,
            "cloud_fallback_providers": {"openai_audio": _openai_provider_block()},
        },
        provider_override=None,
    )

    assert candidates
    assert candidates[0]["provider"] == "openai_audio"


def test_local_only_skips_cloud_entirely():
    """local_only=true → cloud must NOT appear in the candidate list.

    Strictest privacy mode: refuse the request rather than route to cloud.
    """
    candidates = resolve_import_audio_candidates(
        settings={
            "provider": "whisper",
            "provider_http_urls": {
                "parakeet": "http://127.0.0.1:5092/v1/audio/transcriptions",
            },
            "upload_local_first": True,
            "local_only": True,
            "upload_remote_fallback": False,  # also block fallback cloud
            "live_cloud_fallback_enabled": True,
            "cloud_fallback_providers": {"openai_audio": _openai_provider_block()},
        },
        provider_override=None,
    )

    providers = {c["provider"] for c in candidates}
    assert "openai_audio" not in providers
    assert "openrouter_audio" not in providers
    # parakeet local should still be present
    assert "parakeet" in providers


def test_cloud_override_still_forces_cloud():
    """provider_override='openai_audio' wins over local_first.

    Regression guard: explicit caller override (e.g. via admin UI) must
    not be silently ignored by the local-first preference.
    """
    candidates = resolve_import_audio_candidates(
        settings={
            "provider": "whisper",
            "provider_http_urls": {
                "parakeet": "http://127.0.0.1:5092/v1/audio/transcriptions",
            },
            "upload_local_first": True,
            "live_cloud_fallback_enabled": True,
            "cloud_fallback_providers": {"openai_audio": _openai_provider_block()},
        },
        provider_override="openai_audio",
    )

    assert candidates
    assert candidates[0]["provider"] == "openai_audio"
