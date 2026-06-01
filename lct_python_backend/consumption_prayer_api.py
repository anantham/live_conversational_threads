"""
Consumption-prayer API — manual-trigger endpoints for the live conversation UI.

The auto-detect path (agenda_query_detector → live STT pipeline) will publish
matches on the existing /ws/transcripts websocket once it lands (task #17).
The manual-trigger path here returns matches directly in the HTTP response —
no WS event needed, simpler implementation, fits the request/response shape
of a user clicking a button.

Endpoints:
  POST /api/conversations/{conversation_id}/recommend-consumption-query
      Body: {selected_text, contact_ref}
      Returns: IndrasNet's pending-discussions response + source/timestamp
                metadata so the frontend can render with provenance.

Routing:
  Talks to IndrasNet via lct_python_backend.services.indrasnet_client.
  Error mapping (IndrasNet client exceptions → HTTP):
    IndrasNetUnavailable  → 502  (sibling service down)
    IndrasNetClientError  → 4xx  (passes through 404 for unknown contact)
    IndrasNetServerError  → 502  (sibling internal error)
    IndrasNetProtocolError → 502 (sibling sent garbage)
"""

from __future__ import annotations

import datetime
import logging
from typing import Any, List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.db_session import get_async_session, get_async_session_context
from lct_python_backend.services.contacts_cache import (
    is_cache_stale,
    read_contacts_cache,
    schedule_refresh,
)
from lct_python_backend.services.indrasnet_client import (
    IndrasNetClientError,
    IndrasNetProtocolError,
    IndrasNetServerError,
    IndrasNetUnavailable,
    get_contacts_timeout_seconds,
    get_indrasnet_base_url,
    get_match_timeout_seconds,
    get_pending_discussions,
)

logger = logging.getLogger("lct_backend")

router = APIRouter(tags=["consumption-prayer"])


class ConsumptionQueryRequest(BaseModel):
    """Body for the manual-trigger endpoint.

    `selected_text` is optional — only used for telemetry/audit so we can
    reconstruct which sentence in the transcript prompted the query. The
    actual lookup uses only `contact_ref`.
    """
    selected_text: str = Field(default="", max_length=4000)
    contact_ref: str = Field(..., min_length=1, max_length=200)


@router.post("/api/conversations/{conversation_id}/recommend-consumption-query")
async def manual_recommend_consumption_query(
    conversation_id: str,
    request: ConsumptionQueryRequest,
):
    """
    Manually trigger a Recommend-consumption prayer lookup for the named contact.

    User flow: the speaker selects a sentence in the live transcript pane,
    a toolbar appears, they click "Show agenda with [Sahil]". The frontend
    POSTs here with the selected text + contact ref. We return whatever
    items IndrasNet has under that contact's "## Pending discussions"
    section so the chip + drawer can render them.

    The conversation_id is captured for future telemetry (which conversations
    trigger manual queries most often, which contacts get queried, etc.).
    Currently unused by the lookup logic itself.

    Per AGENTS.md §Error Logging — never silently returns empty. Every
    IndrasNet failure mode maps to a distinct HTTP status with descriptive
    detail so the frontend can show the right error UX.
    """
    contact_ref = request.contact_ref.strip()
    if not contact_ref:
        raise HTTPException(status_code=400, detail="contact_ref is required")

    logger.info(
        "[manual-consumption-query] conv=%s contact=%r selected_text=%r",
        conversation_id, contact_ref, request.selected_text[:120],
    )

    try:
        body = await get_pending_discussions(contact_ref)
    except IndrasNetUnavailable as exc:
        msg = f"IndrasNet unreachable: {exc}"
        logger.error("[manual-consumption-query] %s", msg)
        raise HTTPException(status_code=502, detail=msg) from exc
    except IndrasNetClientError as exc:
        # Pass through the underlying status. The message includes the body
        # IndrasNet returned, so the user sees a real explanation (e.g.
        # "Contact not found by id or name: 'Vinay'").
        msg = str(exc)
        # If IndrasNet returned 404, surface that specifically
        status_code = 404 if " 404 " in msg else 400
        logger.warning("[manual-consumption-query] client error: %s", msg)
        raise HTTPException(status_code=status_code, detail=msg) from exc
    except IndrasNetServerError as exc:
        msg = f"IndrasNet server error: {exc}"
        logger.error("[manual-consumption-query] %s", msg)
        raise HTTPException(status_code=502, detail=msg) from exc
    except IndrasNetProtocolError as exc:
        msg = f"IndrasNet protocol error: {exc}"
        logger.error("[manual-consumption-query] %s", msg)
        raise HTTPException(status_code=502, detail=msg) from exc

    # Decorate with provenance so the frontend can show
    # "manually triggered from selection at HH:MM"
    return {
        "source": "manual",
        "conversation_id": conversation_id,
        "selected_text": request.selected_text,
        "triggered_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **body,  # contact, note_path, status, items, item_count
    }


PICKER_DEFAULT_LIMIT = 50
PICKER_MAX_LIMIT = 200
PICKER_DEFAULT_SEARCH_LIMIT = 30


def _normalize_indrasnet_contact(c: Any) -> Optional[dict]:
    """Reduce an IndrasNet contact record to the picker's wire shape.
    Returns None if required fields are missing."""
    if not isinstance(c, dict):
        return None
    cid = c.get("contact_id")
    name = (c.get("display_name") or "").strip()
    if not (cid and name):
        return None
    # external_llm_ok comes back as 0/1 — normalize to bool. Order is
    # preserved from IndrasNet's recent_activity sort.
    return {
        "contact_id": cid,
        "display_name": name,
        "last_activity": c.get("last_activity"),
        "item_count": c.get("item_count"),
        "external_llm_ok": bool(c.get("external_llm_ok", 0)),
        "privacy_tier": c.get("privacy_tier"),
    }


async def _fetch_indrasnet_contacts(
    *,
    limit: int,
    search: str = "",
    timeout: Optional[float] = None,
) -> tuple[list, Optional[str]]:
    """Fetch contacts from IndrasNet with the given limit/search and shape
    them for the picker. Returns (contacts, error_str_or_None). Errors are
    NEVER propagated as HTTP failures — picker degrades to empty list.

    `timeout` overrides the default CONTACTS timeout — the background cache
    refresher passes a generous value (nobody waits on it), while the live
    /search path uses the shorter default. The CONTACTS timeout is separate
    from match_timeout so IndrasNet's slow bulk reads don't make the live
    STT match path more patient than it should be.
    """
    try:
        base = get_indrasnet_base_url()
    except IndrasNetUnavailable as exc:
        # IndrasNet disabled/unconfigured for this profile (ADR-034 §D2) —
        # IndrasNetDisabled subclasses IndrasNetUnavailable. Mirror the
        # network-failure contract: empty list + reason, never a 500.
        logger.info(
            "[known-contacts] IndrasNet unavailable (%s); returning empty list.",
            exc,
        )
        return [], str(exc)[:200]
    params = {"limit": str(limit)}
    if search:
        params["search"] = search
    url = f"{base}/api/contacts"
    effective_timeout = timeout if timeout is not None else get_contacts_timeout_seconds()

    try:
        async with httpx.AsyncClient(timeout=effective_timeout) as client:
            r = await client.get(url, params=params)
            r.raise_for_status()
            body = r.json()
    except httpx.HTTPError as exc:
        msg = str(exc) or type(exc).__name__  # ReadTimeout has empty str()
        logger.warning(
            "[known-contacts] IndrasNet fetch failed (limit=%d search=%r): %s; "
            "returning empty list so the picker still renders.",
            limit, search, msg,
        )
        return [], msg[:200]
    except ValueError as exc:
        logger.warning("[known-contacts] IndrasNet returned non-JSON: %s", exc)
        return [], "non-JSON response"

    raw = body if isinstance(body, list) else body.get("contacts", body.get("items", []))
    contacts = [c for c in (_normalize_indrasnet_contact(item) for item in raw) if c]
    return contacts, None


CACHE_REFRESH_LIMIT = PICKER_DEFAULT_LIMIT  # 50 — covers the realistic picker
CACHE_REFRESH_TIMEOUT_SECONDS = 60.0  # background task, nobody waits on it


async def _fetch_contacts_for_cache():
    """Adapter passed to the cache refresher. Runs in the background, so it
    gets a generous timeout — IndrasNet's /api/contacts is observably slow
    (10s+ even at small limits) and a tight timeout means the cache never
    populates. Fetches the top-50 (the picker only ever shows the top-N by
    recency; the long tail is served by /search)."""
    return await _fetch_indrasnet_contacts(
        limit=CACHE_REFRESH_LIMIT,
        timeout=CACHE_REFRESH_TIMEOUT_SECONDS,
    )


def warm_contacts_cache():
    """Fire-and-forget background refresh of the contacts cache.
    Called on backend startup (lifespan) and on stale/cold picker reads."""
    schedule_refresh(_fetch_contacts_for_cache, get_async_session_context)


@router.get("/api/consumption-prayer/known-contacts")
async def known_contacts_for_picker(
    limit: int = PICKER_DEFAULT_LIMIT,
    db: AsyncSession = Depends(get_async_session),
):
    """Top-N most-recently-active contacts for the participant picker.

    Served from a last-known-good cache (app_settings row, refreshed in
    the background) — IndrasNet's /api/contacts is too slow (15s+,
    frequent timeouts) to call inline. The picker gets an instant answer;
    a stale cache triggers a background revalidate but still returns
    immediately. See services/contacts_cache.py.

    `limit` is clamped to [1, PICKER_MAX_LIMIT]; the cache always holds
    the full window so any limit slices from the same entry.
    """
    effective_limit = max(1, min(int(limit or PICKER_DEFAULT_LIMIT), PICKER_MAX_LIMIT))
    cache = await read_contacts_cache(db)

    if cache and cache.get("contacts"):
        stale = is_cache_stale(cache)
        if stale:
            warm_contacts_cache()  # revalidate, but serve what we have now
        contacts = cache["contacts"][:effective_limit]
        logger.info(
            "[known-contacts] served %d/%d cached contacts (stale=%s)",
            len(contacts), len(cache["contacts"]), stale,
        )
        return {"contacts": contacts, "cached": True, "stale": stale}

    # Cold cache (first call after a fresh DB, or never populated). Kick a
    # refresh and return empty now rather than blocking the picker for 15s.
    # Backend startup also warms the cache, so this path is rare.
    warm_contacts_cache()
    logger.info("[known-contacts] cache cold — returning empty, refresh scheduled")
    return {"contacts": [], "cached": False, "indrasnet_error": "cache warming"}


@router.get("/api/consumption-prayer/known-contacts/search")
async def search_known_contacts(q: str = "", limit: int = PICKER_DEFAULT_SEARCH_LIMIT):
    """Server-side search across IndrasNet contacts — for the long tail
    that the top-N default doesn't cover.

    Empty `q` returns empty list (clients use the top-N endpoint above
    for the initial render). `limit` is clamped to [1, PICKER_MAX_LIMIT].
    """
    query = (q or "").strip()
    if not query:
        return {"contacts": [], "query": ""}
    effective_limit = max(1, min(int(limit or PICKER_DEFAULT_SEARCH_LIMIT), PICKER_MAX_LIMIT))
    contacts, err = await _fetch_indrasnet_contacts(limit=effective_limit, search=query)
    logger.info(
        "[known-contacts/search] q=%r returned %d (limit=%d)",
        query, len(contacts), effective_limit,
    )
    if err is not None:
        return {"contacts": contacts, "query": query, "indrasnet_error": err}
    return {"contacts": contacts, "query": query}
