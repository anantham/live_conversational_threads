"""Deployment-aware retention and inference routing for conversation data.

This module is deliberately content-free: it decides whether bytes may be
stored or which configured provider records may receive them, but it never
inspects or logs transcript text.  URL shape is not a trust signal.  Provider
trust is an explicit operator-authored property and missing/invalid values are
treated as external.
"""

import os
from typing import Any, Dict, List, Optional


PERSONAL_PRIVATE = "personal_private"
HOSTED_SHARED = "hosted_shared"
DEPLOYMENT_PROFILES = frozenset({PERSONAL_PRIVATE, HOSTED_SHARED})

OWNER_PRIVATE = "owner_private"
EXTERNAL = "external"
PROVIDER_TRUST_SCOPES = frozenset({OWNER_PRIVATE, EXTERNAL})


class DeploymentPrivacyError(ValueError):
    """Raised when deployment or conversation policy permits no safe action."""


def current_deployment_profile() -> str:
    """Return the validated deployment profile.

    LCT is a single-owner, self-hosted application by default.  A hosted or
    multi-user operator must opt into ``hosted_shared`` explicitly, where raw
    transcript retention is refused.
    """
    profile = str(os.getenv("LCT_DEPLOYMENT_PROFILE", PERSONAL_PRIVATE)).strip().lower()
    if profile not in DEPLOYMENT_PROFILES:
        allowed = ", ".join(sorted(DEPLOYMENT_PROFILES))
        raise DeploymentPrivacyError(
            f"Unsupported LCT_DEPLOYMENT_PROFILE={profile!r}; expected one of: {allowed}."
        )
    return profile


def assert_raw_transcript_retention_allowed() -> None:
    """Fail unless this deployment is the owner's private LCT instance."""
    profile = current_deployment_profile()
    if profile != PERSONAL_PRIVATE:
        raise DeploymentPrivacyError(
            "redaction_applied=false rejected: raw transcript retention is disabled "
            f"for LCT_DEPLOYMENT_PROFILE={profile}. Send a privacy-transformed "
            "transcript to hosted/shared deployments."
        )


def normalize_provider_trust_scope(value: Any) -> str:
    """Normalize provider trust without guessing from hostname or provider type."""
    scope = str(value or "").strip().lower()
    return scope if scope in PROVIDER_TRUST_SCOPES else EXTERNAL


def _consent_bool(privacy: Optional[Dict[str, Any]], key: str) -> bool:
    if not isinstance(privacy, dict):
        return False
    return privacy.get(key) is True


def select_providers_for_privacy(
    providers: Optional[List[Dict[str, Any]]],
    privacy: Optional[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Return enabled providers permitted by the conversation privacy block.

    ``local_llm_ok`` authorizes routes explicitly marked ``owner_private``;
    ``external_llm_ok`` authorizes routes marked ``external``.  Missing consent,
    missing trust scope, and an empty permitted set all fail closed.
    """
    owner_private_ok = _consent_bool(privacy, "local_llm_ok")
    external_ok = _consent_bool(privacy, "external_llm_ok")

    selected: List[Dict[str, Any]] = []
    configured: List[str] = []
    for provider in providers or []:
        if not isinstance(provider, dict) or provider.get("enabled", True) is False:
            continue
        provider_id = str(provider.get("id") or "unnamed").strip() or "unnamed"
        scope = normalize_provider_trust_scope(provider.get("trust_scope"))
        configured.append(f"{provider_id}:{scope}")
        if scope == OWNER_PRIVATE and owner_private_ok:
            selected.append(provider)
        elif scope == EXTERNAL and external_ok:
            selected.append(provider)

    if not selected:
        configured_summary = ", ".join(configured) if configured else "none"
        raise DeploymentPrivacyError(
            "No enabled LLM provider is permitted by this conversation's privacy "
            f"policy (local_llm_ok={owner_private_ok}, external_llm_ok={external_ok}; "
            f"configured provider trust scopes: {configured_summary})."
        )
    return selected


def constrain_llm_config_for_privacy(
    llm_config: Optional[Dict[str, Any]],
    privacy: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Disable the direct online-Gemini branch when external inference is denied."""
    constrained = dict(llm_config or {})
    if not _consent_bool(privacy, "external_llm_ok"):
        constrained["mode"] = "local"
    return constrained
