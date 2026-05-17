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
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from lct_python_backend.services.indrasnet_client import (
    IndrasNetClientError,
    IndrasNetProtocolError,
    IndrasNetServerError,
    IndrasNetUnavailable,
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
