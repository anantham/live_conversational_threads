"""BYOK session resolution and runtime overlay helpers for bulk import."""

from __future__ import annotations

from typing import Any, Optional, Tuple

from lct_python_backend.services.byok_session_store import (
    BYOK_SCOPE_LLM_IMPORT,
    BYOK_SCOPE_STT_IMPORT,
    ByokSessionLookupError,
    build_runtime_llm_config_for_byok,
    build_runtime_llm_providers_for_byok,
    build_runtime_stt_settings_for_byok,
    resolve_byok_session,
)


def resolve_stt_byok_session(byok_session_token: Optional[str]) -> Optional[dict[str, Any]]:
    token = str(byok_session_token or "").strip()
    if not token:
        return None
    try:
        return resolve_byok_session(token, required_scope=BYOK_SCOPE_STT_IMPORT)
    except ByokSessionLookupError as exc:
        raise ValueError(str(exc)) from exc


def apply_stt_byok_overlay(
    stt_settings: dict[str, Any],
    byok_session: Optional[dict[str, Any]],
    provider: Optional[str],
) -> Tuple[dict[str, Any], Optional[str]]:
    runtime_stt_settings = build_runtime_stt_settings_for_byok(stt_settings, byok_session)
    provider_override = str((byok_session or {}).get("provider") or provider or "").strip() or None
    return runtime_stt_settings, provider_override


def apply_llm_byok_overlay(
    llm_config: dict[str, Any],
    llm_providers: list[dict[str, Any]],
    byok_session: Optional[dict[str, Any]],
) -> Tuple[dict[str, Any], list[dict[str, Any]]]:
    runtime_llm_config = build_runtime_llm_config_for_byok(
        llm_config,
        byok_session,
        required_scope=BYOK_SCOPE_LLM_IMPORT,
    )
    runtime_llm_providers = build_runtime_llm_providers_for_byok(
        llm_providers,
        byok_session,
        required_scope=BYOK_SCOPE_LLM_IMPORT,
    )
    return runtime_llm_config, runtime_llm_providers