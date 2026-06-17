"""Per-contact privacy policy — LCT CONSUMES, never authors.

Contextual integrity (Nissenbaum): each contact has their own norms for how their
conversation data may be processed. "No real names in committed code" was ONE
friend's norm, not a universal rule. IndrasNet is the policy AUTHORITY (stores,
and per the owner's design will cryptographically SIGN, each policy); LCT fetches
a policy over loopback, optionally verifies the signature, and ENFORCES it. LCT
never mutates a policy.

STATE OF THE WORLD (codex review 2026-06-17), which is why PR#1 is local-only:
  * There is NO ``GET /api/contacts/{id}/privacy-policy`` endpoint yet.
  * The existing ``/api/contacts`` wire shape carries only ``external_llm_ok``
    (+ ``privacy_tier``) — NOT ``local_llm_ok`` / ``privacy_norms`` / ``enabled``
    (``enabled`` lives in owner_settings, not the contacts row).
  * IndrasNet's ENS/keystore signs HTTP request envelopes, not policy objects —
    so a signed-policy artifact is greenfield (PR#2).
So ``fetch_policy`` fail-closes to a local-only default today; that is the honest
reason the frontier path stays dark until PR#2 ships the endpoint.

TRUST MODEL — "v1 loopback-trust, signature seam for federation":
  * v1 (single box): the loopback boundary IS the trust boundary; signature
    verification is ADVISORY (logged, not enforced).
  * federation (future): for a policy from a REMOTE IndrasNet, signature
    verification becomes MANDATORY. ``verify_signature(require=True)`` already
    fails closed (returns False until real verification lands in PR#2), so the
    seam is built; only the flag flips.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import httpx

from lct_python_backend.services import indrasnet_client
from lct_python_backend.services.egress_guard import local_only_enabled
from lct_python_backend.services.env_helpers import env_float

logger = logging.getLogger(__name__)

POLICY_CONTRACT_VERSION = "1.0.0"
_POLICY_TIMEOUT_S = env_float("SYNTHESIS_POLICY_TIMEOUT_SECONDS", 5.0)


@dataclass
class ContactPrivacyPolicy:
    """A single contact's processing policy. Defaults are fail-closed for the
    external path: an unknown contact may be processed LOCALLY but never sent to
    a frontier engine."""

    contact_id: str
    enabled: bool = True
    local_llm_ok: bool = True
    external_llm_ok: bool = False
    privacy_norms: Dict[str, Any] = field(default_factory=dict)
    redaction_map_id: Optional[str] = None
    contract_version: str = POLICY_CONTRACT_VERSION
    signature: Optional[str] = None
    signer_pubkey: Optional[str] = None
    # True when this object is the synthesized fail-closed default (no real
    # policy was fetched) — surfaced so callers/observability can tell.
    is_default: bool = False


@dataclass
class EngineDecision:
    """Result of resolving which engine may actually run, given all policies."""

    engine: str  # "local" | "codex" | "claude"
    downgraded: bool
    reason: str


def default_policy(contact_id: str = "") -> ContactPrivacyPolicy:
    """Fail-closed default: local processing allowed, external refused."""
    return ContactPrivacyPolicy(
        contact_id=contact_id,
        enabled=True,
        local_llm_ok=True,
        external_llm_ok=False,
        is_default=True,
    )


def _parse_policy(contact_id: str, body: Dict[str, Any]) -> ContactPrivacyPolicy:
    norms = body.get("privacy_norms")
    if isinstance(norms, str):
        try:
            norms = json.loads(norms)
        except (ValueError, TypeError):
            norms = {}
    sig = body.get("signature")
    sig_val = sig.get("value") if isinstance(sig, dict) else sig
    pubkey = sig.get("signer_pubkey") if isinstance(sig, dict) else body.get("signer_pubkey")
    return ContactPrivacyPolicy(
        contact_id=contact_id,
        enabled=bool(body.get("enabled", False)),
        local_llm_ok=bool(body.get("local_llm_ok", False)),
        external_llm_ok=bool(body.get("external_llm_ok", False)),
        privacy_norms=norms if isinstance(norms, dict) else {},
        redaction_map_id=body.get("redaction_map_id"),
        contract_version=str(body.get("contract_version", POLICY_CONTRACT_VERSION)),
        signature=sig_val,
        signer_pubkey=pubkey,
        is_default=False,
    )


def fetch_policy(
    contact_id: str,
    *,
    base_url: Optional[str] = None,
    timeout: Optional[float] = None,
) -> ContactPrivacyPolicy:
    """Fetch a contact's signed policy over loopback; FAIL-CLOSED on any failure.

    Returns the fail-closed ``default_policy`` when IndrasNet is disabled, the
    endpoint is missing (today's reality), or anything goes wrong. The caller
    cannot tell "no policy" from "external denied" — both correctly forbid the
    frontier path.
    """
    if not contact_id:
        return default_policy(contact_id)
    try:
        base = (base_url or indrasnet_client.get_indrasnet_base_url()).rstrip("/")
    except indrasnet_client.IndrasNetError:
        logger.info("[synthesis] IndrasNet disabled — using fail-closed local policy")
        return default_policy(contact_id)
    url = f"{base}/api/contacts/{contact_id}/privacy-policy"
    try:
        with httpx.Client(timeout=timeout or _POLICY_TIMEOUT_S) as client:
            resp = client.get(url)
        if resp.status_code != 200:
            logger.info(
                "[synthesis] policy fetch %s -> HTTP %s; fail-closed local",
                contact_id, resp.status_code,
            )
            return default_policy(contact_id)
        return _parse_policy(contact_id, resp.json())
    except Exception as exc:  # network/parse/egress-block — fail closed
        logger.info("[synthesis] policy fetch failed (%s); fail-closed local", type(exc).__name__)
        return default_policy(contact_id)


def verify_signature(policy: ContactPrivacyPolicy, *, require: bool = False) -> bool:
    """Verify a policy's signature. ADVISORY by default; MANDATORY for federation.

    Real signature verification (ENS/keystore over the canonical-serialized policy
    body) lands in PR#2. Until then:
      * advisory (require=False): always returns True, but LOGS when a signature
        is missing or present-but-unverifiable, so we never silently treat
        unsigned data as trusted.
      * mandatory (require=True): returns True only when a signature is present
        AND verified — which is never yet, so it fails CLOSED. This is correct
        for federation: don't accept a remote policy we can't authenticate.
    """
    has_sig = bool(policy.signature)
    if require:
        if not has_sig:
            logger.warning("[synthesis] policy %s has no signature; mandatory mode REJECTS", policy.contact_id)
            return False
        # TODO(PR#2): real ENS/keystore verification of the canonical policy body.
        logger.warning("[synthesis] policy %s signature verification not implemented; mandatory mode REJECTS (fail-closed)", policy.contact_id)
        return False
    if not has_sig:
        logger.info("[synthesis] policy %s unsigned (advisory mode — allowed)", policy.contact_id)
    else:
        logger.info("[synthesis] policy %s signature present but unverified (advisory mode — allowed)", policy.contact_id)
    return True


def resolve_engine(
    policies: List[ContactPrivacyPolicy],
    requested: str,
    *,
    require_signature: bool = False,
) -> EngineDecision:
    """Decide the engine that may ACTUALLY run, most-restrictive across participants.

    This is LCT's OWN re-check; it deliberately does NOT trust IndrasNet's
    ``check_gates`` (which has fail-OPEN paths — empty subjects allow by default).
    The frontier path additionally refuses whenever ``LCT_LOCAL_ONLY`` is on,
    independent of the in-process egress chokepoint (which cannot see the
    frontier subprocess anyway).
    """
    requested = (requested or "local").lower()
    if requested == "local":
        return EngineDecision("local", downgraded=False, reason="local engine requested")

    if local_only_enabled():
        return EngineDecision("local", downgraded=True, reason="LCT_LOCAL_ONLY is on — frontier refused")

    if not policies:
        return EngineDecision("local", downgraded=True, reason="no policies — fail-closed to local")

    for p in policies:
        if not p.enabled:
            return EngineDecision("local", downgraded=True, reason=f"contact {p.contact_id} not enabled")
        if not p.external_llm_ok:
            return EngineDecision("local", downgraded=True, reason=f"contact {p.contact_id} external_llm_ok=0")
        if require_signature and not verify_signature(p, require=True):
            return EngineDecision("local", downgraded=True, reason=f"contact {p.contact_id} signature unverified")

    return EngineDecision(requested, downgraded=False, reason="all participants consent to external")
