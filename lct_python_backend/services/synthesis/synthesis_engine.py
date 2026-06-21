"""Per-stage engine dispatcher with a baked-in, fail-closed privacy gate.

Each synthesis stage picks an engine:
  - "local"  : on-box / Tailscale LLM (M5 gemma) — $0, stays on the owner's
               own infrastructure → allowed for any participant, sent verbatim.
  - "codex"  : GPT-5.5 (xhigh) — best argument/edge reasoning → CONSENTED only.
  - "claude" : Opus (1M ctx) — whole-corpus synthesis → CONSENTED only.

PR#1 ships LOCAL-ONLY in practice: ``LCT_LOCAL_ONLY`` defaults ON, and the
frontier path refuses while it is on. The frontier code is present (gated) so PR#2
only has to add the policy fetch — no rewrite.

PRIVACY GATE for any external engine (non-negotiable, in order):
  1. Refuse if ``LCT_LOCAL_ONLY`` is on — refuse to even SPAWN the subprocess.
     (codex precondition: the egress chokepoint wraps in-process httpx/websockets/
     urllib, but ``codex``/``claude`` are child processes it cannot see, so the
     in-process guard is NOT sufficient here.)
  2. Resolve consent via ``contact_policy.resolve_engine`` (most-restrictive
     across participants) — or the ``consented`` flag for callers without policies.
  3. Redact the outbound text (pseudonyms) and ``assert_clean`` — hard stop if any
     real friend name would leave the box.
  4. Run the frontier CLI through ``privacy_boundary.spawn_external_cli`` — the
     sanctioned door that independently leak-verifies the exact stdin+argv and
     sandboxes the child (empty cwd, scrubbed env, no inherited fds), ADR-038.
  5. Restore real names ONLY in the local result.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from lct_python_backend.services.egress_guard import local_only_enabled
from lct_python_backend.services.env_helpers import env_float, env_str
from lct_python_backend.services.synthesis import contact_policy, redaction
from lct_python_backend.services.synthesis.contact_policy import ContactPrivacyPolicy

logger = logging.getLogger(__name__)

EXTERNAL = {"codex", "claude"}

# Local engine config. Env-overridable; default points at the shared M5 Tailscale
# Ollama (see memory: local box's GPU is embedding-pinned). Ideally probed from
# the SHARED_AI_SERVICES registry — a PR#2+ refinement, not hardcoded forever.
_LOCAL_BASE_URL = env_str("SYNTHESIS_LOCAL_BASE_URL", "http://100.83.228.35:11434")
_LOCAL_MODEL = env_str("SYNTHESIS_LOCAL_MODEL", "gemma4:latest")
_LOCAL_TIMEOUT_S = env_float("SYNTHESIS_LOCAL_TIMEOUT_SECONDS", 300.0)


class FrontierRefused(PermissionError):
    """Raised when an external engine is requested but the privacy gate forbids it."""


def default_local_providers() -> List[Dict[str, Any]]:
    """One provider dict for ``local_llm_client`` pointing at the local/M5 LLM."""
    return [{
        "id": "synthesis-local",
        "name": f"synthesis local ({_LOCAL_MODEL})",
        "type": "openai_compatible",
        "base_url": _LOCAL_BASE_URL,
        "model": _LOCAL_MODEL,
        "api_key": None,
        "enabled": True,
        "timeout_seconds": _LOCAL_TIMEOUT_S,
    }]


def _stringify(data: Any) -> str:
    return data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)


def _local(prompt: str, *, providers: Optional[List[Dict[str, Any]]], want_json: bool) -> str:
    """Run on the local/M5 LLM via the LCT client. Stays on the owner's infra."""
    from lct_python_backend.services.local_llm_client import chat_with_provider_fallback_sync

    result = chat_with_provider_fallback_sync(
        [{"role": "user", "content": prompt}],
        providers=providers or default_local_providers(),
        require_json=want_json,
    )
    return _stringify(result.data)


def _codex(prompt: str, timeout: float) -> str:
    """GPT-5.5 (xhigh), read-only, via the sanctioned ``spawn_external_cli`` door
    (ADR-038): it leak-verifies the EXACT stdin+argv and sandboxes the child
    (empty cwd, scrubbed env, no inherited fds) — an INDEPENDENT backstop on top of
    Gate 3's redact/assert_clean. Prompt via stdin so large transcripts don't hit
    the Windows command-line arg limit."""
    from lct_python_backend.services.privacy_boundary import spawn_external_cli

    p = spawn_external_cli(
        ["codex", "exec", "-c", "model_reasoning_effort=xhigh", "-s", "read-only", "-"],
        redacted_input=prompt, engine_tier="E4", timeout=timeout,
    )
    if p.returncode != 0:
        err = (p.stderr or b"").decode("utf-8", "replace")[:400]
        raise RuntimeError(f"codex exec failed (rc={p.returncode}): {err}")
    return (p.stdout or b"").decode("utf-8", "replace").strip()


def _claude_opus(prompt: str, timeout: float) -> str:
    """Opus (1M ctx) via headless ``claude -p`` through the sanctioned
    ``spawn_external_cli`` door (ADR-038 — leak-verify stdin+argv + sandbox)."""
    from lct_python_backend.services.privacy_boundary import spawn_external_cli

    p = spawn_external_cli(
        ["claude", "-p", "--model", "opus"],
        redacted_input=prompt, engine_tier="E4", timeout=timeout,
    )
    if p.returncode != 0:
        err = (p.stderr or b"").decode("utf-8", "replace")[:400]
        raise RuntimeError(f"claude -p failed (rc={p.returncode}): {err}")
    return (p.stdout or b"").decode("utf-8", "replace").strip()


def run_stage(
    engine: str,
    prompt: str,
    *,
    policies: Optional[List[ContactPrivacyPolicy]] = None,
    consented: bool = False,
    want_json: bool = False,
    timeout: float = 2400.0,
    providers: Optional[List[Dict[str, Any]]] = None,
    redaction_map: Optional[redaction.RedactionMap] = None,
    require_signature: bool = False,
) -> str:
    """Run one stage on ``engine``. External => gated + redact/verify/restore.

    Consent is resolved from ``policies`` when given (most-restrictive); otherwise
    the boolean ``consented`` flag is used (for simple callers/tests). Either way,
    an external engine is refused outright while ``LCT_LOCAL_ONLY`` is on.
    """
    engine = (engine or "local").lower()

    if engine == "local":
        return _local(prompt, providers=providers, want_json=want_json)

    if engine not in EXTERNAL:
        raise ValueError(f"unknown engine: {engine!r} (use local|codex|claude)")

    # ── Gate 1: refuse to spawn a frontier subprocess under LCT_LOCAL_ONLY ──
    if local_only_enabled():
        raise FrontierRefused(
            f"Refusing external engine {engine!r}: LCT_LOCAL_ONLY is on. The egress "
            "chokepoint cannot see a frontier subprocess, so the only safe behavior "
            "is to not spawn it."
        )

    # ── Gate 2: consent ──
    if policies is not None:
        decision = contact_policy.resolve_engine(policies, engine, require_signature=require_signature)
        if decision.downgraded or decision.engine != engine:
            raise FrontierRefused(
                f"Refusing external engine {engine!r}: {decision.reason}."
            )
    elif not consented:
        raise FrontierRefused(
            f"Refusing external engine {engine!r}: no participant consent supplied."
        )

    # ── Gate 3: redact + leak-verify the outbound payload ──
    # FAIL-CLOSED first (ADR-038 round-2 finding 9): the built-in default map
    # (map_id is None) is a denylist of only KNOWN names — an un-enrolled real name
    # would pass both redact() and the leak scan, so an external send on it could
    # leak. Refuse rather than warn-and-proceed (the prior behavior). A caller that
    # genuinely wants an external send MUST supply the canonical IndrasNet map (one
    # carrying a map_id). That fetch is PR#2 (no endpoint yet), so external sends
    # stay closed until it lands — consistent with the frontier-gated-dark posture.
    rmap = redaction_map or redaction.default_redaction_map()
    if rmap.map_id is None:
        raise FrontierRefused(
            f"Refusing external engine {engine!r}: no canonical redaction map "
            "supplied (the built-in default is a denylist only and cannot catch "
            "un-enrolled names). Provide the canonical IndrasNet map (with a map_id) "
            "before any external send."
        )
    redacted = redaction.redact(prompt, rmap)
    redaction.assert_clean(redacted, rmap)  # hard stop on any surviving real name

    # ── Gate 4: run the frontier CLI ──
    out = _codex(redacted, timeout) if engine == "codex" else _claude_opus(redacted, timeout)

    # ── Gate 5: restore real names into the local-only result ──
    return redaction.restore(out, rmap)
