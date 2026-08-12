"""Content-addressed cache for LLM completions (extract re-runs stop re-paying).

WHY (measured, 2026-08-12): a Phase-2 extract of a 1,125-turn conversation
made ~1,090 LLM calls and took **126 minutes**. Re-running it — after a prompt
tweak, a crash, or just to regenerate a bundle — repeats every single call,
including the ~1,080 three-second "keep accumulating" micro-decisions whose
inputs did not change at all. LCT's stated design is "Eternal
Reprocessability"; paying two hours to reprocess unchanged turns is the tax
that makes people avoid re-running, which is exactly backwards.

WHAT IS IN THE KEY — this is the whole correctness argument:
  * the messages (so different text is a different entry),
  * temperature / max_tokens / require_json (different sampling contract),
  * prompt_name + prompt_version (a PROMPT EDIT must invalidate; this is why
    the consolidation prompts carry version stamps),
  * the candidate models (swapping gemma4 -> muse must invalidate).
Anything that can change the answer is in the key, so a hit is a genuine
"same question, same conditions" — never a stale answer to a new question.

SEMANTIC CHANGE, stated plainly: with the cache on, a re-run REPLAYS the
first run instead of resampling at temperature. For this pipeline that is a
feature (a bundle regenerated twice should not silently differ), but it does
mean the cache must be cleared to get fresh sampling. `LCT_LLM_CACHE=0`
disables it entirely; deleting the file resets it.

Failure posture: every operation is best-effort. A corrupt or unwritable
cache logs once and degrades to "no cache" — it must never fail a run it
exists to speed up.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_LOCK = threading.Lock()
_DISABLED_LOGGED = False


def enabled() -> bool:
    return os.getenv("LCT_LLM_CACHE", "1") == "1"


def _db_path() -> Path:
    override = os.getenv("LCT_LLM_CACHE_PATH")
    if override:
        return Path(override)
    root = Path(__file__).resolve().parents[2]
    return root / "data" / "llm_cache.sqlite3"


def cache_key(
    messages: List[Dict[str, Any]],
    *,
    temperature: float,
    max_tokens: int,
    require_json: bool,
    prompt_name: Optional[str],
    prompt_version: Optional[str],
    models: List[str],
) -> str:
    """Stable sha256 over everything that can change the answer."""
    payload = json.dumps(
        {
            "messages": messages,
            "temperature": round(float(temperature), 4),
            "max_tokens": int(max_tokens),
            "require_json": bool(require_json),
            "prompt_name": prompt_name or "",
            "prompt_version": str(prompt_version or ""),
            # sorted: provider ORDER must not fragment the cache, but the SET
            # of candidate models must still invalidate it.
            "models": sorted(str(m) for m in models if m),
        },
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _connect() -> Optional[sqlite3.Connection]:
    global _DISABLED_LOGGED
    try:
        path = _db_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(str(path), timeout=10.0)
        con.execute(
            "CREATE TABLE IF NOT EXISTS llm_cache ("
            " key TEXT PRIMARY KEY, response TEXT NOT NULL, model TEXT,"
            " prompt_name TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)"
        )
        return con
    except Exception as exc:  # noqa: BLE001 — a broken cache must not break a run
        if not _DISABLED_LOGGED:
            logger.warning("[llm_cache] unavailable, running uncached: %r", exc)
            _DISABLED_LOGGED = True
        return None


def get(key: str) -> Optional[Dict[str, Any]]:
    """The cached {data, model} for this key, or None."""
    if not enabled():
        return None
    con = _connect()
    if con is None:
        return None
    try:
        with _LOCK:
            row = con.execute(
                "SELECT response, model FROM llm_cache WHERE key = ?", (key,)
            ).fetchone()
        if not row:
            return None
        return {"data": json.loads(row[0]), "model": row[1]}
    except Exception as exc:  # noqa: BLE001
        logger.warning("[llm_cache] read failed for %s: %r", key[:12], exc)
        return None
    finally:
        con.close()


def put(key: str, data: Any, model: Optional[str],
        prompt_name: Optional[str] = None) -> None:
    """Record a SUCCESSFUL completion. Errors are swallowed by design."""
    if not enabled():
        return
    con = _connect()
    if con is None:
        return
    try:
        blob = json.dumps(data, ensure_ascii=False)
        with _LOCK:
            con.execute(
                "INSERT OR REPLACE INTO llm_cache (key, response, model, prompt_name) "
                "VALUES (?,?,?,?)", (key, blob, model or "", prompt_name or ""))
            con.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("[llm_cache] write failed for %s: %r", key[:12], exc)
    finally:
        con.close()


def stats() -> Dict[str, Any]:
    """{entries, path, enabled} — for an operator to see the cache is real."""
    con = _connect()
    if con is None:
        return {"entries": 0, "path": str(_db_path()), "enabled": enabled()}
    try:
        with _LOCK:
            n = con.execute("SELECT COUNT(*) FROM llm_cache").fetchone()[0]
        return {"entries": int(n), "path": str(_db_path()), "enabled": enabled()}
    except Exception:  # noqa: BLE001
        return {"entries": 0, "path": str(_db_path()), "enabled": enabled()}
    finally:
        con.close()
