"""Provider presets for the synthetic-eval harness.

The harness drives the SAME extraction code LCT uses in production
(``generate_lct_json``), but lets you point it at different LLM backends so you
can compare extraction quality (local vs frontier) on identical authored
conversations.

Two routing shapes exist in the extractor (see
``services/transcript_llm_callers.generate_lct_json``):

  * ``kind="gemini"``  -> ``llm_config["mode"]=="online"`` -> Google genai SDK path.
                          Needs GOOGLEAI_API_KEY / GEMINI_API_KEY / GEMINI_KEY.
  * ``kind="fallback"`` -> the ``providers=[...]`` OpenAI/OpenRouter/local fallback
                          list (``chat_with_provider_fallback_sync``).
  * ``kind="mock"``    -> no network; a deterministic in-process stub (for
                          validating the harness + scorer without spending credits).

SAFETY: every non-local provider requires ``LCT_LOCAL_ONLY=0`` because the
extractor calls ``assert_local_egress`` before any cloud call (egress_guard.py,
default-ON / fail-closed). ``run.py`` flips that env var for its own process
*only* and prints a loud banner — safe because this process holds only synthetic
data and never touches the real DB. Never set LCT_LOCAL_ONLY=0 in the main app.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# Default frontier model ids (override via env). Kept conservative; you can point
# these at any model your key can serve.
DEFAULT_OPENAI_MODEL = os.getenv("SYNTH_EVAL_OPENAI_MODEL", "gpt-4o")
DEFAULT_OPENROUTER_MODEL = os.getenv("SYNTH_EVAL_OPENROUTER_MODEL", "google/gemini-3-flash-preview")
DEFAULT_GEMINI_MODEL = os.getenv("SYNTH_EVAL_GEMINI_MODEL", os.getenv("ONLINE_LLM_CHAT_MODEL", "gemini-2.5-flash"))
# Native Anthropic (official SDK, NOT the OpenAI-compatible shim). Opus 4.8 is the
# current most-capable Opus-tier model; adaptive thinking + effort are GA.
DEFAULT_ANTHROPIC_MODEL = os.getenv("SYNTH_EVAL_ANTHROPIC_MODEL", "claude-opus-4-8")
DEFAULT_ANTHROPIC_EFFORT = os.getenv("SYNTH_EVAL_ANTHROPIC_EFFORT", "high")
DEFAULT_ANTHROPIC_MAX_TOKENS = int(os.getenv("SYNTH_EVAL_ANTHROPIC_MAX_TOKENS", "12000"))
# Subscription path: drive the logged-in `claude` CLI (Agent SDK credit), no API key.
DEFAULT_CLAUDE_CLI_MODEL = os.getenv("SYNTH_EVAL_CLAUDE_MODEL", "claude-opus-4-8")

_OPENROUTER_BASE_URL = "https://openrouter.ai/api"
_OPENAI_BASE_URL = "https://api.openai.com"
# LM Studio over Tailscale — counts as "local" to the egress guard (100.64/10).
_LOCAL_LLM_BASE_URL = os.getenv("LOCAL_LLM_BASE_URL", os.getenv("LMSTUDIO_BASE_URL", "http://100.81.65.74:1234"))
_LOCAL_LLM_MODEL = os.getenv("LOCAL_LLM_CHAT_MODEL", "qwen3-32b")


@dataclass
class ProviderSpec:
    name: str
    kind: str  # "gemini" | "fallback" | "mock"
    llm_config: Dict[str, Any] = field(default_factory=dict)
    providers: Optional[List[Dict[str, Any]]] = None
    requires_cloud: bool = False
    # Name of the env var whose absence makes this preset unusable (None if ready).
    missing_key_env: Optional[str] = None
    label: str = ""

    @property
    def ready(self) -> bool:
        return self.missing_key_env is None


def _first_env(*names: str) -> Optional[str]:
    for name in names:
        val = os.getenv(name)
        if val and val.strip():
            return val.strip()
    return None


def build_provider(name: str) -> ProviderSpec:
    """Resolve a preset name into a ProviderSpec (reads API keys from env)."""
    key = name.strip().lower()

    if key == "mock":
        return ProviderSpec(
            name="mock",
            kind="mock",
            requires_cloud=False,
            label="mock (deterministic, no network)",
        )

    if key == "local":
        # Single local provider; no cloud egress needed.
        return ProviderSpec(
            name="local",
            kind="fallback",
            llm_config={"mode": "local"},
            providers=[{
                "id": "local_lmstudio",
                "name": "Local LM Studio",
                "type": "openai_compatible",
                "base_url": _LOCAL_LLM_BASE_URL,
                "model": _LOCAL_LLM_MODEL,
                "api_key": None,
                "enabled": True,
                "timeout_seconds": int(os.getenv("SYNTH_EVAL_LOCAL_TIMEOUT", "180")),
            }],
            requires_cloud=False,
            label=f"local LM Studio ({_LOCAL_LLM_MODEL} @ {_LOCAL_LLM_BASE_URL})",
        )

    if key == "openai":
        api_key = _first_env("OPENAI_API_KEY", "SYNTH_EVAL_OPENAI_API_KEY")
        return ProviderSpec(
            name="openai",
            kind="fallback",
            llm_config={"mode": "local"},  # NOT "online": that forces the Gemini SDK path.
            providers=[{
                "id": "openai_frontier",
                "name": f"OpenAI {DEFAULT_OPENAI_MODEL}",
                "type": "openai",
                "base_url": _OPENAI_BASE_URL,
                "model": DEFAULT_OPENAI_MODEL,
                "api_key": api_key,
                "enabled": bool(api_key),
                "timeout_seconds": 120,
            }],
            requires_cloud=True,
            missing_key_env=None if api_key else "OPENAI_API_KEY",
            label=f"OpenAI {DEFAULT_OPENAI_MODEL}",
        )

    if key == "openrouter":
        api_key = _first_env("OPENROUTER_API_KEY", "SYNTH_EVAL_OPENROUTER_API_KEY")
        return ProviderSpec(
            name="openrouter",
            kind="fallback",
            llm_config={"mode": "local"},
            providers=[{
                "id": "openrouter_frontier",
                "name": f"OpenRouter {DEFAULT_OPENROUTER_MODEL}",
                "type": "openrouter",
                "base_url": _OPENROUTER_BASE_URL,
                "model": DEFAULT_OPENROUTER_MODEL,
                "api_key": api_key,
                "enabled": bool(api_key),
                "timeout_seconds": 120,
            }],
            requires_cloud=True,
            missing_key_env=None if api_key else "OPENROUTER_API_KEY",
            label=f"OpenRouter {DEFAULT_OPENROUTER_MODEL}",
        )

    if key == "claude":
        # Subscription path (default): drive the logged-in `claude` CLI in headless
        # mode (`claude -p`). Uses the Claude Code / Agent-SDK login — NO API key —
        # and draws from the Agent SDK monthly credit. Reuses LCT's GENERATE prompt
        # + normalizer (see _claude_cli_extract); tools + MCP are stripped.
        return ProviderSpec(
            name="claude",
            kind="claude_cli",
            llm_config={"model": DEFAULT_CLAUDE_CLI_MODEL},
            providers=None,
            requires_cloud=False,
            missing_key_env=None,
            label=f"Claude {DEFAULT_CLAUDE_CLI_MODEL} (subscription via `claude -p`, no API key)",
        )

    if key == "claude-api":
        # Native first-party Anthropic Messages API via the official `anthropic`
        # SDK. LCT's extractor has no Anthropic path, so this preset calls the SDK
        # directly but reuses LCT's GENERATE prompt + normalizer (see extract.py),
        # so it faithfully measures Claude under the same extraction contract.
        # The anthropic SDK resolves credentials from ANTHROPIC_API_KEY,
        # ANTHROPIC_AUTH_TOKEN, OR a logged-in `ant auth login` / Claude Code
        # profile — so we do NOT gate on an env var (that would wrongly skip a
        # logged-in machine). If no credential resolves, the SDK raises a clear
        # auth error, surfaced by _anthropic_extract.
        return ProviderSpec(
            name="claude-api",
            kind="anthropic",
            llm_config={
                "model": DEFAULT_ANTHROPIC_MODEL,
                "effort": DEFAULT_ANTHROPIC_EFFORT,
                "max_tokens": DEFAULT_ANTHROPIC_MAX_TOKENS,
            },
            providers=None,
            requires_cloud=True,
            missing_key_env=None,
            label=f"Claude {DEFAULT_ANTHROPIC_MODEL} (native Anthropic SDK, effort={DEFAULT_ANTHROPIC_EFFORT})",
        )

    if key == "gemini":
        api_key = _first_env("GOOGLEAI_API_KEY", "GEMINI_API_KEY", "GEMINI_KEY")
        return ProviderSpec(
            name="gemini",
            kind="gemini",
            llm_config={"mode": "online", "chat_model": DEFAULT_GEMINI_MODEL},
            providers=None,  # ignored on the gemini path
            requires_cloud=True,
            missing_key_env=None if api_key else "GOOGLEAI_API_KEY",
            label=f"Gemini {DEFAULT_GEMINI_MODEL}",
        )

    raise ValueError(
        f"Unknown provider preset {name!r}. "
        "Choose from: mock, local, openai, openrouter, gemini."
    )


PRESET_NAMES = ("mock", "local", "openai", "openrouter", "gemini", "claude", "claude-api")


def enable_cloud_egress_for_synthetic() -> None:
    """Open cloud egress for THIS process only, with a loud banner.

    Safe because: (a) this process never starts the FastAPI app and never opens
    the real Postgres DB; (b) it only handles synthetic fixtures. The production
    app keeps ``LCT_LOCAL_ONLY=1``. We set it here so the extractor's
    ``assert_local_egress()`` permits frontier calls on fake data only.

    NEVER set ``LCT_LOCAL_ONLY=0`` in the main application process.
    """
    os.environ["LCT_LOCAL_ONLY"] = "0"
    banner = (
        "\n"
        "+" + "-" * 74 + "+\n"
        "| CLOUD EGRESS ENABLED FOR THIS PROCESS (LCT_LOCAL_ONLY=0)" + " " * 18 + "|\n"
        "| Safe: synthetic-only harness, no FastAPI app, no real DB connection.   |\n"
        "| Frontier provider calls will be made on FAKE conversation data only.   |\n"
        "+" + "-" * 74 + "+\n"
    )
    print(banner)
    sys.stdout.flush()
