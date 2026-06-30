"""Run LCT's real graph extraction on a synthetic conversation.

This calls the SAME function the production import/STT pipeline calls —
``services.transcript_llm_callers.generate_lct_json`` — so the harness measures
the real extractor, not a reimplementation. The only thing that varies is which
provider backend it points at (see ``providers.py``).

``generate-mode`` (the default and only mode in Tier 1) feeds the whole
conversation to the generator in a single call and reads back the normalized
node list. That isolates the dimension-extraction prompt as the variable under
test. (The streaming accumulate -> chunk -> generate pipeline that the live STT
path uses is a noisier, 2-LLM-call-per-batch superset; wiring it as an alternate
mode is a deliberate Tier-1.5 follow-up.)
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from lct_python_backend.synthetic_eval.providers import ProviderSpec
from lct_python_backend.synthetic_eval.schema import SyntheticConversation


@dataclass
class ExtractionResult:
    nodes: List[Dict[str, Any]] = field(default_factory=list)
    backend_label: str = ""
    ok: bool = False
    error: str = ""
    elapsed_ms: float = 0.0
    status_messages: List[str] = field(default_factory=list)


# Optional prompt augmentation for the "is the ceiling prompt-bound?" experiment.
# The base generate prompt under-asks for dimension flags + typed edges; this spells
# them out. Appended to the system prompt (claude_cli / anthropic) or prepended to the
# user input (fallback/gemini) when --elicit-dimensions is passed.
DIMENSION_ELICITATION = """ADDITIONAL DIMENSION REQUIREMENTS — set these honestly on every node; they are graded:
- is_crux=true on a pivotal claim, thesis, turning point, or key realization the discussion hinges on.
- is_tangent=true on a digression, aside, personal anecdote, or side-story that branches off the main thread.
- is_surprise=true on a genuinely surprising admission, reversal, or counter-intuitive fact.
- is_action_item=true on a concrete commitment with an owner (and ideally a deadline).
Most nodes are NONE of these — flag only the genuine ones; do not leave them all false by default.

EDGE TYPING — when two nodes are in a genuine rhetorical relationship, set the edge_relations
relation_type to one of: rebuts (disagreement / counter-argument), supports (agreement /
evidence), clarifies (restatement / narrowing), asks (a question). Use "contextual" ONLY when
none of those fit. Draw the edges between the actual claims that rebut or support each other."""


def _run_in_bigstack(fn):
    """Run ``fn()`` in a fresh thread with a 64MB native stack + bounded recursion
    limit (20000, set/restored inside the thread only).

    Frontier models emit large / deeply-nested JSON; the C json scanner + normalizer
    (and Python 3.9's recursive ``re``) recurse, and from a small worker-thread stack
    (e.g. the streaming engine's ``asyncio.to_thread``) a deep recurse overflowed the
    native stack → 0xC0000005 access violation instead of a catchable RecursionError.
    Giving the parse a big stack + bounded limit makes it robust WITHOUT permanently
    mutating the process-global recursion limit. Returns ``(result_or_None, error_or_None)``.
    """
    box: Dict[str, Any] = {}

    def _work() -> None:
        prev_limit = sys.getrecursionlimit()
        try:
            sys.setrecursionlimit(20000)
            box["result"] = fn()
        except BaseException as exc:  # noqa: BLE001 — incl. RecursionError
            box["error"] = exc
        finally:
            sys.setrecursionlimit(prev_limit)

    prev_stack = threading.stack_size()
    spawned = False
    for size in (64 * 1024 * 1024, 32 * 1024 * 1024, 16 * 1024 * 1024):
        try:
            threading.stack_size(size)
        except (ValueError, RuntimeError):
            continue
        t = threading.Thread(target=_work, name="lct-parse", daemon=True)
        t.start()
        t.join()
        spawned = True
        break
    try:
        threading.stack_size(prev_stack)
    except (ValueError, RuntimeError):
        pass
    if not spawned:  # stack_size unsupported here — inline fallback (rare)
        _work()
    return box.get("result"), box.get("error")


def _parse_nodes_bigstack(text: str):
    """``extract_json_from_text`` + ``_normalize_generated_output`` in a large-stack
    thread (graph-node output). Returns ``(nodes_or_None, error_or_None)``."""
    from lct_python_backend.services.local_llm_client import extract_json_from_text
    from lct_python_backend.services.transcript.transcript_normalizer import _normalize_generated_output

    return _run_in_bigstack(lambda: _normalize_generated_output(extract_json_from_text(text)))


def _parse_json_bigstack(text: str):
    """``extract_json_from_text`` in a large-stack thread, returning the RAW parsed
    object (no node normalization — for consolidation payloads, which are dicts).
    Returns ``(parsed_or_None, error_or_None)``."""
    from lct_python_backend.services.local_llm_client import extract_json_from_text

    return _run_in_bigstack(lambda: extract_json_from_text(text))


def build_generator_input(convo: SyntheticConversation, transcript_override: Optional[str] = None) -> str:
    """Mirror TranscriptProcessor's ``mod_input`` with an empty existing-graph.

    ``transcript_override`` (Tier 2) feeds a noisy STT transcript instead of the
    clean authored turns, to measure end-to-end extraction degradation.
    """
    transcript = transcript_override if transcript_override is not None else convo.render_transcript(bracketed_speakers=True)
    return (
        "Existing JSON (0 prior nodes):\n[]\n\n"
        f"Transcript Input:\n{transcript}"
    )


def extract_graph(
    convo: SyntheticConversation,
    spec: ProviderSpec,
    transcript_override: Optional[str] = None,
    extra_system: Optional[str] = None,
) -> ExtractionResult:
    if spec.kind == "mock":
        return _mock_extract(convo)
    if spec.kind == "anthropic":
        return _anthropic_extract(convo, spec, transcript_override, extra_system)
    if spec.kind == "claude_cli":
        return _claude_cli_extract(convo, spec, transcript_override, extra_system)

    mod_input = build_generator_input(convo, transcript_override)
    if extra_system:  # fallback/gemini build their own system prompt internally
        mod_input = extra_system + "\n\n" + mod_input
    # Lazy import: pulls in google-genai + the LLM stack only when actually
    # calling a real provider, so `--list` and mock runs work in a bare env.
    from lct_python_backend.services.transcript.transcript_llm_callers import generate_lct_json

    status_messages: List[str] = []
    t0 = time.perf_counter()
    try:
        nodes, backend = generate_lct_json(
            mod_input,
            llm_config=spec.llm_config or None,
            providers=spec.providers,
            status_messages=status_messages,
        )
    except Exception as exc:  # noqa: BLE001 — surface any provider/egress error to the report
        return ExtractionResult(
            nodes=[],
            backend_label="",
            ok=False,
            error=f"{type(exc).__name__}: {exc}",
            elapsed_ms=(time.perf_counter() - t0) * 1000.0,
            status_messages=status_messages,
        )

    elapsed = (time.perf_counter() - t0) * 1000.0
    ok = bool(nodes)
    return ExtractionResult(
        nodes=nodes or [],
        backend_label=backend or "",
        ok=ok,
        error="" if ok else "extractor returned no nodes",
        elapsed_ms=elapsed,
        status_messages=status_messages,
    )


# ── Subscription extractor (headless `claude -p`, no API key) ────────────────

def _resolve_claude_bin() -> Optional[str]:
    explicit = os.getenv("SYNTH_EVAL_CLAUDE_BIN")
    if explicit and os.path.exists(explicit):
        return explicit
    found = shutil.which("claude")
    if found:
        return found
    fallback = os.path.expanduser("~/.local/bin/claude.exe")
    return fallback if os.path.exists(fallback) else None


def _claude_cli_extract(convo: SyntheticConversation, spec: ProviderSpec, transcript_override: Optional[str] = None, extra_system: Optional[str] = None) -> ExtractionResult:
    """Extract via the logged-in `claude` CLI in headless mode — no API key.

    Drives ``claude -p`` with LCT's GENERATE prompt as the (replaced) system prompt
    and the transcript on stdin, with tools + MCP stripped so it behaves as a pure
    completion. Authenticates with the Claude Code subscription login and draws
    from the Agent SDK monthly credit. Reuses LCT's ``_normalize_generated_output``,
    so the only variable under test is the model. Runs in a throwaway temp cwd so
    this repo's CLAUDE.md / settings / MCP don't leak into the prompt.
    """
    mod_input = build_generator_input(convo, transcript_override)
    t0 = time.perf_counter()
    claude_bin = _resolve_claude_bin()
    if not claude_bin:
        return ExtractionResult(
            ok=False,
            error="`claude` CLI not found — set SYNTH_EVAL_CLAUDE_BIN to its path",
            elapsed_ms=(time.perf_counter() - t0) * 1000.0,
            status_messages=["needs the Claude Code CLI (claude.exe) on PATH"],
        )

    from lct_python_backend.services.transcript.transcript_prompts import (
        PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY,
        get_transcript_prompt_text,
    )

    system_prompt = get_transcript_prompt_text(PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY)
    if extra_system:
        system_prompt = system_prompt + "\n\n" + extra_system
    model = str(spec.llm_config.get("model", "claude-opus-4-8"))
    timeout_s = int(os.getenv("SYNTH_EVAL_CLAUDE_TIMEOUT", "300"))
    backend = f"claude_cli_{model}"

    cmd = [
        claude_bin, "-p",
        "--model", model,
        "--system-prompt", system_prompt,   # REPLACES Claude Code's default prompt
        "--allowed-tools",                   # variadic w/ no values -> zero tools
        "--strict-mcp-config",               # use ONLY --mcp-config below...
        "--mcp-config", '{"mcpServers": {}}',  # ...which is empty -> no MCP startup
        "--output-format", "json",
    ]
    try:
        with tempfile.TemporaryDirectory(prefix="synth_eval_claude_") as td:
            proc = subprocess.run(
                cmd, input=mod_input, capture_output=True, text=True,
                encoding="utf-8", cwd=td, timeout=timeout_s,
            )
    except subprocess.TimeoutExpired:
        return ExtractionResult(
            ok=False, backend_label=backend,
            error=f"`claude -p` timed out after {timeout_s}s (raise SYNTH_EVAL_CLAUDE_TIMEOUT)",
            elapsed_ms=(time.perf_counter() - t0) * 1000.0,
        )
    except Exception as exc:  # noqa: BLE001
        return ExtractionResult(
            ok=False, backend_label=backend,
            error=f"{type(exc).__name__}: {exc}",
            elapsed_ms=(time.perf_counter() - t0) * 1000.0,
        )

    elapsed = (time.perf_counter() - t0) * 1000.0
    if proc.returncode != 0:
        return ExtractionResult(
            ok=False, backend_label=backend,
            error=f"`claude -p` exit {proc.returncode}: {(proc.stderr or '')[:300]}",
            elapsed_ms=elapsed,
        )

    try:
        data = json.loads(proc.stdout)
    except Exception as exc:  # noqa: BLE001
        return ExtractionResult(
            ok=False, backend_label=backend,
            error=f"could not parse `claude -p` json envelope: {exc}",
            elapsed_ms=elapsed, status_messages=[(proc.stdout or "")[:200]],
        )

    # --output-format json emits a list of messages; the result object is last.
    result_obj = data[-1] if isinstance(data, list) and data else data
    if not isinstance(result_obj, dict):
        return ExtractionResult(ok=False, backend_label=backend, error="unexpected `claude -p` output shape", elapsed_ms=elapsed)
    if result_obj.get("is_error") or result_obj.get("subtype") not in (None, "success"):
        return ExtractionResult(
            ok=False, backend_label=backend,
            error=f"claude error: {str(result_obj.get('result'))[:300]}",
            elapsed_ms=elapsed,
        )

    text = str(result_obj.get("result", ""))
    # Frontier models at high effort emit large / deeply-nested JSON; parse in a
    # large-stack thread (see _parse_nodes_bigstack) so a deep recurse can't overflow
    # the native stack — and without permanently raising the process recursion limit.
    nodes, parse_err = _parse_nodes_bigstack(text)
    if parse_err is not None or nodes is None:
        # Persist the raw model text so the failure is inspectable without re-paying.
        dump = os.path.join(tempfile.gettempdir(), f"synth_eval_claude_{convo.slug}.raw.txt")
        try:
            with open(dump, "w", encoding="utf-8") as fh:
                fh.write(text)
        except Exception:
            dump = "(dump failed)"
        return ExtractionResult(
            ok=False, backend_label=backend,
            error=f"{type(parse_err).__name__} parsing Claude output: {parse_err}",
            elapsed_ms=elapsed, status_messages=[f"raw saved to {dump}", text[:160]],
        )

    return ExtractionResult(
        nodes=nodes, backend_label=backend, ok=bool(nodes),
        error="" if nodes else "normalizer produced no nodes",
        elapsed_ms=elapsed,
    )


# ── Native Anthropic extractor (official SDK, not the OpenAI-compat shim) ─────

def _anthropic_extract(convo: SyntheticConversation, spec: ProviderSpec, transcript_override: Optional[str] = None, extra_system: Optional[str] = None) -> ExtractionResult:
    """Extract via the first-party Anthropic Messages API.

    LCT's ``generate_lct_json`` has no Anthropic dispatch path, so we call the SDK
    directly — but we reuse the SAME system prompt LCT feeds Gemini
    (``generate_conversation_hierarchy``) and the SAME ``_normalize_generated_output``
    normalizer, so the only variable under test is the model. Uses adaptive thinking
    + the effort parameter, per the Anthropic API guidance for non-trivial tasks.
    """
    mod_input = build_generator_input(convo, transcript_override)
    t0 = time.perf_counter()
    status: List[str] = []
    try:
        import anthropic  # lazy: harness works for other presets without this SDK
    except ImportError:
        return ExtractionResult(
            ok=False,
            error="anthropic SDK not installed — run `pip install anthropic`",
            elapsed_ms=(time.perf_counter() - t0) * 1000.0,
            status_messages=["install the official SDK; the OpenAI-compat shim is deliberately not used"],
        )

    from lct_python_backend.services.transcript.transcript_prompts import (
        PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY,
        get_transcript_prompt_text,
    )
    from lct_python_backend.services.transcript.transcript_normalizer import _normalize_generated_output
    from lct_python_backend.services.local_llm_client import extract_json_from_text

    system_prompt = get_transcript_prompt_text(PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY)
    if extra_system:
        system_prompt = system_prompt + "\n\n" + extra_system
    model = str(spec.llm_config.get("model", "claude-opus-4-8"))
    effort = str(spec.llm_config.get("effort", "high"))
    max_tokens = int(spec.llm_config.get("max_tokens", 12000))

    try:
        # OAuth / session tokens (ant auth login, Claude Code) authenticate via
        # Authorization: Bearer and require the oauth beta header; a plain env API
        # key does not. Only add the header when bridging an auth_token.
        client_kwargs: Dict[str, Any] = {}
        if os.getenv("ANTHROPIC_AUTH_TOKEN") and not os.getenv("ANTHROPIC_API_KEY"):
            client_kwargs["default_headers"] = {"anthropic-beta": "oauth-2025-04-20"}
        client = anthropic.Anthropic(**client_kwargs)  # resolves token/key from env
        resp = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system_prompt,
            thinking={"type": "adaptive"},
            output_config={"effort": effort},
            messages=[{"role": "user", "content": mod_input}],
        )
    except Exception as exc:  # noqa: BLE001
        return ExtractionResult(
            ok=False,
            error=f"{type(exc).__name__}: {exc}",
            elapsed_ms=(time.perf_counter() - t0) * 1000.0,
            status_messages=status,
        )

    elapsed = (time.perf_counter() - t0) * 1000.0
    backend = f"anthropic_{model}"

    # Per the Anthropic API: check stop_reason BEFORE reading content.
    if getattr(resp, "stop_reason", None) == "refusal":
        cat = getattr(getattr(resp, "stop_details", None), "category", None)
        return ExtractionResult(
            ok=False, backend_label=backend,
            error=f"Claude refused (category={cat})",
            elapsed_ms=elapsed, status_messages=status,
        )
    if getattr(resp, "stop_reason", None) == "max_tokens":
        status.append(f"hit max_tokens={max_tokens}; JSON may be truncated (raise SYNTH_EVAL_ANTHROPIC_MAX_TOKENS)")

    text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", None) == "text")
    try:
        parsed = extract_json_from_text(text)
    except Exception as exc:  # noqa: BLE001
        return ExtractionResult(
            ok=False, backend_label=backend,
            error=f"could not parse JSON from Claude output: {exc}",
            elapsed_ms=elapsed, status_messages=status,
        )

    nodes = _normalize_generated_output(parsed)
    return ExtractionResult(
        nodes=nodes,
        backend_label=backend,
        ok=bool(nodes),
        error="" if nodes else "normalizer produced no nodes",
        elapsed_ms=elapsed,
        status_messages=status,
    )


# ── Mock extractor ───────────────────────────────────────────────────────────

def _mock_extract(convo: SyntheticConversation) -> ExtractionResult:
    """Deterministic, intentionally-imperfect extraction for plumbing/scorer tests.

    Produces one node per turn with the turn text as a verbatim ``source_excerpt``
    (so alignment is exact), then seeds flags/edges/claims from ground truth with
    deliberate errors injected: it drops the LAST item of each dimension (a miss)
    and adds one spurious crux + one spurious edge (false positives). The result
    is non-degenerate metrics (neither 1.0 nor 0.0) that are easy to eyeball.
    """
    gt = convo.ground_truth
    name_for = {t.id: f"{t.speaker}-{t.id}" for t in convo.turns}

    nodes: List[Dict[str, Any]] = []
    by_turn: Dict[str, Dict[str, Any]] = {}
    for turn in convo.turns:
        node = {
            "id": turn.id,
            "node_name": name_for[turn.id],
            "summary": turn.text,
            "source_excerpt": turn.text,
            "semantic_level": 1,
            "semantic_type": "chunk",
            "speaker_id": turn.speaker,
            "is_crux": False,
            "is_tangent": False,
            "is_surprise": False,
            "is_action_item": False,
            "claims": [],
            "edge_relations": [],
            "contextual_relation": {},
        }
        nodes.append(node)
        by_turn[turn.id] = node

    def _apply_flag(flag: str, turn_ids: List[str], *, drop_last: bool) -> None:
        ids = list(turn_ids)
        if drop_last and ids:
            ids = ids[:-1]  # deliberate miss
        for tid in ids:
            by_turn[tid][flag] = True

    _apply_flag("is_crux", gt.cruxes, drop_last=True)
    _apply_flag("is_tangent", gt.tangents, drop_last=False)
    _apply_flag("is_surprise", gt.surprises, drop_last=False)
    _apply_flag("is_action_item", gt.action_items, drop_last=True)

    # One spurious crux (false positive) on a turn that is not a ground-truth crux.
    for turn in convo.turns:
        if turn.id not in gt.cruxes:
            by_turn[turn.id]["is_crux"] = True
            break

    # Edges: replicate all but the last GT edge; add one spurious edge.
    for edge in gt.edges[:-1] if gt.edges else []:
        src = by_turn[edge.from_turn]
        src["edge_relations"].append({
            "related_node": name_for[edge.to_turn],
            "relation_type": edge.type,
            "relation_text": edge.note or f"{edge.from_turn}->{edge.to_turn}",
        })
    if len(convo.turns) >= 2:
        # Spurious "supports" edge between the first two turns (almost certainly
        # not a ground-truth edge of that pair/type) -> a precision miss.
        by_turn[convo.turns[0].id]["edge_relations"].append({
            "related_node": name_for[convo.turns[1].id],
            "relation_type": "supports",
            "relation_text": "spurious mock edge",
        })

    # Factual claims: attach all but the last to their turn node.
    factual = [c for c in gt.claims if c.type == "factual"]
    for claim in factual[:-1] if factual else []:
        by_turn[claim.turn]["claims"].append(claim.text)

    return ExtractionResult(
        nodes=nodes,
        backend_label="mock",
        ok=True,
        error="",
        elapsed_ms=0.0,
        status_messages=["mock extractor: deterministic, no network"],
    )
