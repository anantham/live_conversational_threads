"""
IndrasNet HTTP client — async wrapper around the sibling orchestrator's
prayer-matching endpoint.

Used by LCT's live STT pipeline (consumption_trigger.py) to surface prior
held intentions when the listening AI detects the speaker is reaching for
one. See ADR-NNN (consumption prayer matching) and ADR-013 (intent signals
schema, shared between LCT and IndrasNet).

Configuration:
    INDRASNET_BASE_URL — defaults to http://100.81.65.74:7777 (the live
        Tailscale instance where the real prayer corpus lives). Mirrors
        the convention in stt_config.py for the Whisper orchestrator URL.
    INDRASNET_MATCH_TIMEOUT_SECONDS — defaults to 5. Match calls happen
        per-segment in the live path; we cannot afford to block long.

Error policy (per AGENTS.md §Error Logging — no silent failures):
    - Network unreachable, connect refused, DNS failure → raises
      IndrasNetUnavailable with the underlying cause. Callers decide
      whether to surface this to the user or degrade gracefully.
    - HTTP 4xx → raises IndrasNetClientError (LCT sent a malformed query).
    - HTTP 5xx → raises IndrasNetServerError.
    - Malformed JSON → raises IndrasNetProtocolError.
    Never silently returns an empty match list to hide a real failure.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger("lct_backend")


DEFAULT_INDRASNET_BASE_URL = "http://100.81.65.74:7777"
DEFAULT_MATCH_TIMEOUT_SECONDS = 5.0
# Contacts endpoint is a bulk read and observably slower than match/pending —
# probes regularly show 1-15s round-trips at limit=50, with occasional
# timeouts. Keep this separate from MATCH so the live STT path (match) does
# NOT get a slower budget when we accommodate contacts.
DEFAULT_CONTACTS_TIMEOUT_SECONDS = 15.0
DEFAULT_MAX_RESULTS = 3
DEFAULT_MIN_SCORE = 0.05


# ---------------------------------------------------------------------------
# Exception hierarchy
# ---------------------------------------------------------------------------

class IndrasNetError(Exception):
    """Base for all IndrasNet client failures."""


class IndrasNetUnavailable(IndrasNetError):
    """Endpoint unreachable — connect refused, DNS failure, timeout."""


class IndrasNetClientError(IndrasNetError):
    """4xx — request was malformed. Indicates an LCT bug."""


class IndrasNetServerError(IndrasNetError):
    """5xx — IndrasNet had an internal error."""


class IndrasNetProtocolError(IndrasNetError):
    """Response wasn't well-formed JSON or didn't match expected shape."""


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def get_indrasnet_base_url() -> str:
    """Returns the IndrasNet base URL, stripped of trailing slash."""
    url = os.getenv("INDRASNET_BASE_URL", DEFAULT_INDRASNET_BASE_URL).strip()
    return url.rstrip("/") or DEFAULT_INDRASNET_BASE_URL


def get_match_timeout_seconds() -> float:
    try:
        return float(os.getenv("INDRASNET_MATCH_TIMEOUT_SECONDS", str(DEFAULT_MATCH_TIMEOUT_SECONDS)))
    except (TypeError, ValueError):
        return DEFAULT_MATCH_TIMEOUT_SECONDS


def get_contacts_timeout_seconds() -> float:
    """Timeout for the bulk /api/contacts call from the participant picker.
    Deliberately decoupled from match_timeout — see DEFAULT_CONTACTS_TIMEOUT_SECONDS."""
    try:
        return float(os.getenv("INDRASNET_CONTACTS_TIMEOUT_SECONDS", str(DEFAULT_CONTACTS_TIMEOUT_SECONDS)))
    except (TypeError, ValueError):
        return DEFAULT_CONTACTS_TIMEOUT_SECONDS


# ---------------------------------------------------------------------------
# Match call
# ---------------------------------------------------------------------------

async def match_prayers(
    *,
    context_text: str,
    topic_hints: Optional[List[str]] = None,
    max_results: int = DEFAULT_MAX_RESULTS,
    min_score: float = DEFAULT_MIN_SCORE,
    base_url: Optional[str] = None,
    timeout_seconds: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Call IndrasNet's POST /api/prayers/match.

    Args:
        context_text: Recent conversation segment text — what the speaker is
            currently talking about.
        topic_hints: Optional list of extracted topics from the local-LLM
            trigger pass (e.g. ["money", "parents", "money_and_parents"]).
            Weighted 2x in scoring on the IndrasNet side.
        max_results: Cap on returned matches. Clamped server-side to [1, 10].
        min_score: Cutoff below which matches are filtered out. Server clamps
            to [0.0, 1.0].
        base_url: Override INDRASNET_BASE_URL for this call (test injection).
        timeout_seconds: Override INDRASNET_MATCH_TIMEOUT_SECONDS for this call.

    Returns:
        The full response body — {"matches": [...], "query": {...}}. Callers
        typically only need response["matches"], but the query block is useful
        for debugging "why nothing surfaced" scenarios.

    Raises:
        IndrasNetUnavailable: connection failure or timeout.
        IndrasNetClientError: 4xx from IndrasNet (LCT bug — bad payload).
        IndrasNetServerError: 5xx from IndrasNet (their bug).
        IndrasNetProtocolError: JSON parse failure or missing expected keys.
    """
    base = (base_url or get_indrasnet_base_url()).rstrip("/")
    timeout = timeout_seconds if timeout_seconds is not None else get_match_timeout_seconds()
    url = f"{base}/api/prayers/match"

    payload = {
        "context_text": context_text or "",
        "topic_hints": list(topic_hints or []),
        "max_results": int(max_results),
        "min_score": float(min_score),
    }

    logger.debug(
        "[indrasnet_client] match → %s (ctx_len=%d hints=%d max=%d)",
        url, len(payload["context_text"]), len(payload["topic_hints"]),
        payload["max_results"],
    )

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, json=payload)
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        msg = f"IndrasNet match endpoint unreachable at {url}: {exc}"
        logger.warning("[indrasnet_client] %s", msg)
        raise IndrasNetUnavailable(msg) from exc
    except httpx.ReadTimeout as exc:
        msg = f"IndrasNet match call timed out after {timeout}s at {url}"
        logger.warning("[indrasnet_client] %s", msg)
        raise IndrasNetUnavailable(msg) from exc
    except httpx.HTTPError as exc:
        msg = f"IndrasNet match HTTP transport error at {url}: {exc}"
        logger.warning("[indrasnet_client] %s", msg)
        raise IndrasNetUnavailable(msg) from exc

    status = response.status_code
    if 400 <= status < 500:
        msg = (
            f"IndrasNet match returned {status} — payload rejected. "
            f"Body: {response.text[:300]}"
        )
        logger.error("[indrasnet_client] %s", msg)
        raise IndrasNetClientError(msg)
    if status >= 500:
        msg = (
            f"IndrasNet match returned {status} — server error. "
            f"Body: {response.text[:300]}"
        )
        logger.error("[indrasnet_client] %s", msg)
        raise IndrasNetServerError(msg)

    try:
        body = response.json()
    except ValueError as exc:
        msg = f"IndrasNet match returned non-JSON body: {response.text[:200]}"
        logger.error("[indrasnet_client] %s", msg)
        raise IndrasNetProtocolError(msg) from exc

    if not isinstance(body, dict) or "matches" not in body:
        msg = f"IndrasNet match response missing 'matches' key: {body!r}"
        logger.error("[indrasnet_client] %s", msg)
        raise IndrasNetProtocolError(msg)

    matches = body.get("matches", [])
    query_info = body.get("query", {})
    logger.info(
        "[indrasnet_client] match ← %d/%d candidates returned "
        "(threshold=%s, topic_hints=%s)",
        len(matches),
        query_info.get("candidate_count", "?"),
        query_info.get("threshold"),
        query_info.get("topic_hints"),
    )
    return body


# ---------------------------------------------------------------------------
# Pending discussions per contact — the MVP read path
# ---------------------------------------------------------------------------

async def get_pending_discussions(
    contact_ref: str,
    *,
    base_url: Optional[str] = None,
    timeout_seconds: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Call IndrasNet's GET /api/contacts/{contact_ref}/pending-discussions.

    Returns the contact's "## Pending discussions" section parsed into
    structured items — what LCT surfaces when the user says "what's on
    our agenda with this person?".

    Args:
        contact_ref: Either a contact_id ("c_abc123") or a display_name /
            alias ("Sahil"). The IndrasNet route falls back to
            resolve_contact_text for name lookups.
        base_url: Override INDRASNET_BASE_URL for this call (test injection).
        timeout_seconds: Override INDRASNET_MATCH_TIMEOUT_SECONDS for this call.

    Returns:
        Response body: {
          "contact": {"contact_id": "...", "display_name": "..."},
          "note_path": "/path/to/Sahil.md" | null,
          "status": "ok" | "note_missing" | "no_note_path" | "<read err>",
          "items": [{"text": "...", "prayer_id": 412, "added_at": "...",
                     "source": "..."}, ...],
          "item_count": 3,
        }

    Raises:
        IndrasNetUnavailable: connection failure or timeout.
        IndrasNetClientError: 4xx — 404 when contact not found, 400 if our
            request is malformed.
        IndrasNetServerError: 5xx — IndrasNet internal error.
        IndrasNetProtocolError: malformed JSON or missing 'items' key.
    """
    import urllib.parse

    if not contact_ref or not str(contact_ref).strip():
        raise IndrasNetClientError("contact_ref is required and must be non-empty")

    base = (base_url or get_indrasnet_base_url()).rstrip("/")
    timeout = timeout_seconds if timeout_seconds is not None else get_match_timeout_seconds()
    encoded = urllib.parse.quote(str(contact_ref).strip(), safe="")
    url = f"{base}/api/contacts/{encoded}/pending-discussions"

    logger.debug("[indrasnet_client] pending-discussions GET %s", url)

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url)
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        msg = f"IndrasNet pending-discussions unreachable at {url}: {exc}"
        logger.warning("[indrasnet_client] %s", msg)
        raise IndrasNetUnavailable(msg) from exc
    except httpx.ReadTimeout as exc:
        msg = f"IndrasNet pending-discussions timed out after {timeout}s at {url}"
        logger.warning("[indrasnet_client] %s", msg)
        raise IndrasNetUnavailable(msg) from exc
    except httpx.HTTPError as exc:
        msg = f"IndrasNet pending-discussions HTTP transport error at {url}: {exc}"
        logger.warning("[indrasnet_client] %s", msg)
        raise IndrasNetUnavailable(msg) from exc

    status = response.status_code
    if 400 <= status < 500:
        msg = (
            f"IndrasNet pending-discussions returned {status} for contact "
            f"{contact_ref!r}. Body: {response.text[:300]}"
        )
        logger.error("[indrasnet_client] %s", msg)
        raise IndrasNetClientError(msg)
    if status >= 500:
        msg = (
            f"IndrasNet pending-discussions returned {status} for contact "
            f"{contact_ref!r}. Body: {response.text[:300]}"
        )
        logger.error("[indrasnet_client] %s", msg)
        raise IndrasNetServerError(msg)

    try:
        body = response.json()
    except ValueError as exc:
        msg = f"IndrasNet pending-discussions returned non-JSON: {response.text[:200]}"
        logger.error("[indrasnet_client] %s", msg)
        raise IndrasNetProtocolError(msg) from exc

    if not isinstance(body, dict) or "items" not in body:
        msg = f"IndrasNet pending-discussions response missing 'items': {body!r}"
        logger.error("[indrasnet_client] %s", msg)
        raise IndrasNetProtocolError(msg)

    logger.info(
        "[indrasnet_client] pending-discussions ← %d items for contact %r "
        "(status=%s, note_path=%s)",
        body.get("item_count", len(body.get("items", []))),
        contact_ref,
        body.get("status"),
        body.get("note_path"),
    )
    return body


# ---------------------------------------------------------------------------
# Unified retrieval — used by LCT enrichment passes (ADR-032 Part E)
# ---------------------------------------------------------------------------

DEFAULT_RETRIEVAL_TIMEOUT_SECONDS = 10.0
DEFAULT_RETRIEVAL_TOP_K = 10
DEFAULT_RETRIEVAL_CANDIDATE_K = 50


def get_retrieval_timeout_seconds() -> float:
    try:
        return float(
            os.getenv(
                "INDRASNET_RETRIEVAL_TIMEOUT_SECONDS",
                str(DEFAULT_RETRIEVAL_TIMEOUT_SECONDS),
            )
        )
    except (TypeError, ValueError):
        return DEFAULT_RETRIEVAL_TIMEOUT_SECONDS


async def retrieval_search(
    *,
    query: str,
    top_k: int = DEFAULT_RETRIEVAL_TOP_K,
    candidate_k: int = DEFAULT_RETRIEVAL_CANDIDATE_K,
    rerank: bool = True,
    base_url: Optional[str] = None,
    timeout_seconds: Optional[float] = None,
) -> Dict[str, Any]:
    """ADR-032 Part E: unified BM25 + HNSW + RRF + reranker retrieval over
    IndrasNet's full knowledge graph (notes, prior conversations, messages,
    media items).

    LCT calls this during enrichment passes to fetch contextually salient
    items that ground the LLM in shared user context. Without it, the
    consolidation + edge-enrichment LLMs see only the transcript and can't
    interpret in-group references / jargon / prior arguments.

    PRIVACY GATE: IndrasNet does NOT enforce ``external_llm_ok`` on this
    endpoint. Callers MUST filter results by participant privacy flag
    before passing retrieved items into any prompt that ships to a remote
    LLM. See ``edge_enrichment.py`` for the filter implementation.

    Failure mode: callers should catch ``IndrasNetUnavailable`` and proceed
    with empty context (enrichment runs without the boost). A banner is
    surfaced to the user, the failure is logged, the session continues.

    Args:
        query: Free-text query — typically the recent transcript chunk +
            a one-line thread summary. ~200-1000 chars works well.
        top_k: Final number of results returned after reranking. Server
            clamps to [1, 100].
        candidate_k: How many candidates to retrieve before reranking.
            Server clamps. Larger = slower but better recall.
        rerank: Whether to apply the cross-encoder + LLM context-pack step.
            Set False for low-latency probes.

    Returns:
        Response body with ranked items and `why_relevant` annotations.
        Shape per IndrasNet ADR-017.

    Raises:
        Same exception hierarchy as ``match_prayers``.
    """
    base = (base_url or get_indrasnet_base_url()).rstrip("/")
    timeout = timeout_seconds if timeout_seconds is not None else get_retrieval_timeout_seconds()
    url = f"{base}/api/retrieval/search"

    payload = {
        "query": query or "",
        "top_k": int(top_k),
        "candidate_k": int(candidate_k),
        "rerank": bool(rerank),
    }

    logger.debug(
        "[indrasnet_client] retrieval → %s (query_len=%d top_k=%d rerank=%s)",
        url, len(payload["query"]), payload["top_k"], payload["rerank"],
    )

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, json=payload)
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        msg = f"IndrasNet retrieval endpoint unreachable at {url}: {exc}"
        logger.warning("[indrasnet_client] %s", msg)
        raise IndrasNetUnavailable(msg) from exc
    except httpx.ReadTimeout as exc:
        msg = f"IndrasNet retrieval call timed out after {timeout}s at {url}"
        logger.warning("[indrasnet_client] %s", msg)
        raise IndrasNetUnavailable(msg) from exc
    except httpx.HTTPError as exc:
        msg = f"IndrasNet retrieval HTTP transport error at {url}: {exc}"
        logger.warning("[indrasnet_client] %s", msg)
        raise IndrasNetUnavailable(msg) from exc

    status = response.status_code
    if 400 <= status < 500:
        msg = (
            f"IndrasNet retrieval returned {status} — payload rejected. "
            f"Body: {response.text[:300]}"
        )
        logger.error("[indrasnet_client] %s", msg)
        raise IndrasNetClientError(msg)
    if status >= 500:
        msg = (
            f"IndrasNet retrieval returned {status} — server error. "
            f"Body: {response.text[:300]}"
        )
        logger.error("[indrasnet_client] %s", msg)
        raise IndrasNetServerError(msg)

    try:
        body = response.json()
    except ValueError as exc:
        msg = f"IndrasNet retrieval returned non-JSON body: {response.text[:200]}"
        logger.error("[indrasnet_client] %s", msg)
        raise IndrasNetProtocolError(msg) from exc

    if not isinstance(body, dict):
        msg = f"IndrasNet retrieval response is not a JSON object: {body!r}"
        logger.error("[indrasnet_client] %s", msg)
        raise IndrasNetProtocolError(msg)

    items = body.get("items") or body.get("results") or []
    logger.info(
        "[indrasnet_client] retrieval ← %d items (rerank=%s top_k=%d)",
        len(items),
        rerank,
        top_k,
    )
    return body


# ---------------------------------------------------------------------------
# Health probe — exposed for the live pipeline to check at startup
# ---------------------------------------------------------------------------

async def ping(*, base_url: Optional[str] = None, timeout_seconds: float = 2.0) -> bool:
    """
    Lightweight reachability check. Returns True if IndrasNet's prayers route
    responds at all (even with an error — we just want to know the host is up).
    Used by the live pipeline at startup to log a clear status line.
    """
    base = (base_url or get_indrasnet_base_url()).rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            r = await client.get(f"{base}/api/prayers/latest?limit=1")
        return r.status_code < 500
    except httpx.HTTPError:
        return False
