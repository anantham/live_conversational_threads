"""LLM live telemetry: record per-call speed, aggregate per provider.

The STT side persists turnaround telemetry in TranscriptEvent rows. LLM generation
has no such table, so this service records each chat call as one line in an
append-only JSONL log under ``data/llm_telemetry.jsonl`` (gitignored). That keeps
the "we keep collecting data as we use the app" property across restarts without a
DB migration, and LLM calls are infrequent (graph generation) so per-call file IO
is negligible.

What we can measure honestly without streaming: total request ms, completion
tokens, and tokens/sec. Time-to-first-token needs token streaming (not wired today)
so it's left null here; the LLM benchmark harness measures TTFT separately. Quality
(valid-JSON rate, graph shape) is the benchmark's job — see tmp/llm_bench.

Recording is strictly best-effort: a telemetry failure must NEVER break generation.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

logger = logging.getLogger("lct_backend")

_MAX_KEEP_LINES = 5000  # rotate the log past this so it can't grow unbounded


def _telemetry_path() -> str:
    return os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "llm_telemetry.jsonl")


def catalog_provider_key(base_url: Any, provider_type: Any) -> str:
    """Map a live provider (base_url + type) to a backend-catalog LLM provider_key."""
    url = str(base_url or "").lower()
    ptype = str(provider_type or "").lower()
    if ptype == "openrouter" or "openrouter" in url:
        return "cloud_openrouter"
    if "anthropic" in url:
        return "cloud_anthropic"
    if "gemini" in url or "googleapis" in url or "generativelanguage" in url:
        return "cloud_gemini"
    if ptype == "openai" or "api.openai.com" in url:
        return "cloud_openai"
    if "11434" in url:
        return "local_ollama"
    if "100.81.65.74" in url or "tailscale" in url or url.startswith("http://100.81."):
        return "tailscale_rtx"
    if "1234" in url:
        return "local_lmstudio"
    host = urlparse(url).netloc
    if any(tok in host for tok in ("localhost", "127.0.0.1")):
        return "local_lmstudio"
    return "remote"


def record_llm_call(
    *,
    provider_key: str,
    model: str,
    base_url: str,
    total_ms: float,
    prompt_tokens: Optional[int] = None,
    completion_tokens: Optional[int] = None,
    first_token_ms: Optional[float] = None,
    ok: bool = True,
    valid_json: Optional[bool] = None,
    capability: str = "chat",
) -> None:
    """Append one LLM call's telemetry. Best-effort — swallows all errors."""
    try:
        total_s = (total_ms or 0) / 1000.0
        tokens_per_sec = None
        if completion_tokens and total_s > 0:
            tokens_per_sec = round(completion_tokens / total_s, 2)
        row = {
            "ts": datetime.utcnow().isoformat() + "Z",
            "provider_key": provider_key,
            "model": model,
            "base_url": base_url,
            "total_ms": round(float(total_ms), 2) if total_ms is not None else None,
            "first_token_ms": round(float(first_token_ms), 2) if first_token_ms is not None else None,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "tokens_per_sec": tokens_per_sec,
            "ok": bool(ok),
            "valid_json": valid_json,
            "capability": capability,
        }
        path = _telemetry_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row) + "\n")
        _maybe_rotate(path)
    except Exception:  # noqa: BLE001 - telemetry must never break generation
        logger.debug("[LLM TELEMETRY] record failed", exc_info=True)


def _maybe_rotate(path: str) -> None:
    try:
        if os.path.getsize(path) < 2_000_000:
            return
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
        if len(lines) <= _MAX_KEEP_LINES:
            return
        with open(path, "w", encoding="utf-8") as fh:
            fh.writelines(lines[-_MAX_KEEP_LINES:])
    except Exception:  # noqa: BLE001
        pass


def _read_rows(limit: int) -> List[Dict[str, Any]]:
    path = _telemetry_path()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return []
    rows: List[Dict[str, Any]] = []
    for line in lines[-limit:]:
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def _p95(values: List[float]) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    import math
    rank = max(1, int(math.ceil(0.95 * len(ordered))))
    return round(float(ordered[min(len(ordered) - 1, rank - 1)]), 2)


def _avg(values: List[float]) -> Optional[float]:
    return round(sum(values) / len(values), 2) if values else None


async def aggregate_llm_telemetry(session, limit: int = 400) -> Dict[str, Any]:  # noqa: ARG001 - session unused (JSONL-backed); kept for signature symmetry
    """Aggregate recent LLM calls per provider_key (mirrors STT telemetry shape)."""
    rows = _read_rows(limit)
    providers: Dict[str, Dict[str, Any]] = {}

    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        key = str(row.get("provider_key") or "unknown")
        grouped.setdefault(key, []).append(row)

    for key, items in grouped.items():
        tps = [r["tokens_per_sec"] for r in items if isinstance(r.get("tokens_per_sec"), (int, float))]
        totals = [r["total_ms"] for r in items if isinstance(r.get("total_ms"), (int, float))]
        ttft = [r["first_token_ms"] for r in items if isinstance(r.get("first_token_ms"), (int, float))]
        json_flags = [r["valid_json"] for r in items if isinstance(r.get("valid_json"), bool)]
        last = items[-1]
        providers[key] = {
            "samples": len(items),
            "avg_tokens_per_sec": _avg(tps),
            "last_tokens_per_sec": tps[-1] if tps else None,
            "avg_first_token_ms": _avg(ttft),
            "avg_total_ms": _avg(totals),
            "p95_total_ms": _p95(totals),
            "valid_json_rate": (round(sum(1 for f in json_flags if f) / len(json_flags), 3) if json_flags else None),
            "last_model": last.get("model"),
            "last_seen": last.get("ts"),
        }

    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "window_size": len(rows),
        "providers": providers,
    }
