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
from urllib.parse import urlsplit

import httpx

from lct_python_backend.services import indrasnet_client
from lct_python_backend.services.egress_guard import is_local_host, local_only_enabled
from lct_python_backend.services.env_helpers import env_float

logger = logging.getLogger(__name__)

POLICY_CONTRACT_VERSION = "1.0.0"
_POLICY_TIMEOUT_S = env_float("SYNTHESIS_POLICY_TIMEOUT_SECONDS", 5.0)

_TRUE_TOKENS = {"1", "true", "yes", "on", "y", "t"}


def _as_bool(v: Any) -> bool:
    """Strict, FAIL-CLOSED boolean parse. A malformed/odd value (incl. the string
    "false" or "0") becomes False — never accidental consent (codex finding #7)."""
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v == 1
    if isinstance(v, str):
        return v.strip().lower() in _TRUE_TOKENS
    return False


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
    # True when the policy was fetched from a loopback/local source. A remote
    # (non-loopback) source auto-requires a valid signature (codex finding #4).
    source_is_local: bool = True


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


def _parse_policy(contact_id: str, body: Dict[str, Any], *, source_is_local: bool = True) -> ContactPrivacyPolicy:
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
        enabled=_as_bool(body.get("enabled", False)),
        local_llm_ok=_as_bool(body.get("local_llm_ok", False)),
        external_llm_ok=_as_bool(body.get("external_llm_ok", False)),
        privacy_norms=norms if isinstance(norms, dict) else {},
        redaction_map_id=body.get("redaction_map_id"),
        contract_version=str(body.get("contract_version", POLICY_CONTRACT_VERSION)),
        signature=sig_val,
        signer_pubkey=pubkey,
        is_default=False,
        source_is_local=source_is_local,
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
    src_local = is_local_host(urlsplit(base).hostname or "")
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
        return _parse_policy(contact_id, resp.json(), source_is_local=src_local)
    except Exception as exc:  # network/parse/egress-block — fail closed
        logger.info("[synthesis] policy fetch failed (%s); fail-closed local", type(exc).__name__)
        return default_policy(contact_id)


def _canonical_policy_body(policy: ContactPrivacyPolicy) -> str:
    """Rebuild the EXACT canonical body IndrasNet signed. MUST stay byte-identical to
    IndrasNet's ``canonical_policy_body`` (docs/contracts/contact-privacy-policy.md)."""
    body = {
        "contact_id": policy.contact_id,
        "enabled": policy.enabled,
        "local_llm_ok": policy.local_llm_ok,
        "external_llm_ok": policy.external_llm_ok,
        "privacy_norms": policy.privacy_norms,
        "redaction_map_id": policy.redaction_map_id,
        "contract_version": policy.contract_version,
    }
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _check_signature(policy: ContactPrivacyPolicy) -> str:
    """Recover the EIP-191 signer and compare to the declared pubkey.
    Returns 'valid' | 'invalid' | 'unavailable' (eth_account not installed)."""
    if not policy.signature or not policy.signer_pubkey:
        return "invalid"
    try:
        from eth_account import Account
        from eth_account.messages import encode_defunct
    except ImportError:
        return "unavailable"
    try:
        recovered = Account.recover_message(
            encode_defunct(text=_canonical_policy_body(policy)),
            signature=policy.signature,
        )
        return "valid" if recovered.lower() == policy.signer_pubkey.lower() else "invalid"
    except Exception:  # noqa: BLE001 — any recovery error == cannot trust
        return "invalid"


def verify_signature(policy: ContactPrivacyPolicy, *, require: bool = False) -> bool:
    """Verify a policy's signature. ADVISORY by default; MANDATORY for federation.

    - unsigned:               advisory allows (loopback trust); mandatory REJECTS.
    - present + VALID:         allowed in both modes.
    - present + INVALID:       REJECTED in both modes (tamper — worse than unsigned).
    - present, eth_account missing (cannot verify): advisory allows with a loud
      warning (loopback); mandatory REJECTS (fail-closed).
    """
    if not policy.signature:
        if require:
            logger.warning("[synthesis] policy %s unsigned; mandatory mode REJECTS", policy.contact_id)
            return False
        logger.info("[synthesis] policy %s unsigned (advisory — allowed)", policy.contact_id)
        return True
    status = _check_signature(policy)
    if status == "valid":
        logger.info("[synthesis] policy %s signature VALID", policy.contact_id)
        return True
    if status == "unavailable":
        logger.warning(
            "[synthesis] policy %s is signed but eth_account is not installed — cannot "
            "verify (%s). Install eth-account to enable signature verification.",
            policy.contact_id, "REJECTING" if require else "advisory allow",
        )
        return not require
    logger.warning("[synthesis] policy %s signature INVALID (possible tamper) — REJECTING", policy.contact_id)
    return False


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

    # Enforce enabled + local_llm_ok across ALL participants for ANY engine
    # (codex finding #1): a disabled or local-denied contact must not be processed
    # even locally. "none" => caller must refuse entirely.
    for p in policies:
        if not p.enabled:
            return EngineDecision("none", downgraded=True, reason=f"contact {p.contact_id} not enabled — refusing all processing")
        if not p.local_llm_ok:
            return EngineDecision("none", downgraded=True, reason=f"contact {p.contact_id} local_llm_ok=0 — refusing local processing")

    if requested == "local":
        return EngineDecision("local", downgraded=False, reason="local engine requested")

    if local_only_enabled():
        return EngineDecision("local", downgraded=True, reason="LCT_LOCAL_ONLY is on — frontier refused")

    if not policies:
        return EngineDecision("local", downgraded=True, reason="no policies — fail-closed to local")

    for p in policies:
        if not p.external_llm_ok:
            return EngineDecision("local", downgraded=True, reason=f"contact {p.contact_id} external_llm_ok=0")
        # A non-loopback (remote/federated) policy source MUST carry a valid
        # signature (codex finding #4) — advisory mode is only safe on loopback.
        eff_require = require_signature or not p.source_is_local
        if eff_require and not verify_signature(p, require=True):
            src = "remote source" if not p.source_is_local else "signature required"
            return EngineDecision("local", downgraded=True, reason=f"contact {p.contact_id} signature unverified ({src})")

    return EngineDecision(requested, downgraded=False, reason="all participants consent to external")
