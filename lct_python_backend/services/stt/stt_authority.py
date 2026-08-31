"""Explicit STT authority records shared by live and import routing.

Authority is configuration identity, not a property inferred from a hostname.
Only environment-built ``local_authorities`` records and a validated BYOK
marker minted by ``byok_session_store`` are trusted by the resolvers.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional

from lct_python_backend.services.coercion_helpers import coerce_str, to_bool

LOCAL_AUTHORITY_SCOPE = "owner_approved_local"
VALIDATED_BYOK_SCOPE = "validated_session_byok"
VALIDATED_STT_BYOK_PROVIDER_KEY = "_validated_stt_byok_provider"


def resolve_local_authority_candidates(
    settings: Mapping[str, Any],
) -> List[Dict[str, Any]]:
    raw_authorities = settings.get("local_authorities")
    if not isinstance(raw_authorities, list):
        return []

    candidates: List[Dict[str, Any]] = []
    seen_ids: set[str] = set()
    for raw in raw_authorities:
        if not isinstance(raw, Mapping) or not to_bool(raw.get("enabled"), False):
            continue
        authority_id = coerce_str(raw.get("id")).lower()
        provider = coerce_str(raw.get("provider")).lower()
        http_url = coerce_str(raw.get("http_url"))
        if not authority_id or authority_id in seen_ids or not provider or not http_url:
            continue
        seen_ids.add(authority_id)
        candidate: Dict[str, Any] = {
            "route_id": f"local_authority_{authority_id}",
            "authority_id": authority_id,
            "authority_scope": LOCAL_AUTHORITY_SCOPE,
            "provider": provider,
            "transport": "backend_http",
            "http_url": http_url,
            "reason": f"approved_local_{authority_id}",
            "supports_diarization": to_bool(raw.get("supports_diarization"), False),
            "degraded": to_bool(raw.get("degraded"), False),
            "request_diarization": to_bool(raw.get("request_diarization"), True),
        }
        for optional_key in ("ws_url", "model", "language"):
            optional_value = coerce_str(raw.get(optional_key))
            if optional_value:
                candidate[optional_key] = optional_value
        candidates.append(candidate)
    return candidates


def validated_byok_provider(
    settings: Mapping[str, Any],
    requested_provider: Optional[str],
) -> str:
    requested = coerce_str(requested_provider).lower()
    granted = coerce_str(settings.get(VALIDATED_STT_BYOK_PROVIDER_KEY)).lower()
    return requested if requested and requested == granted else ""
