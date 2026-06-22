"""Subject-side privacy review surface — HTTP/DB/relay shell (ADR-039 P2a).

Three endpoints (the pure logic lives in ``subject_review_core``):

  POST /api/subject-review/import              (AUTH_TOKEN-gated; IndrasNet -> LCT)
  GET  /api/subject-review/{token}             (Google-gated; subject's browser)
  POST /api/subject-review/{token}/decisions   (Google-gated + Origin-checked)

Auth model (ADR-039 §3): the AUTH_TOKEN middleware exempts ONLY the GET and the
decisions POST (see middleware `_is_subject_review_public`); ``import`` stays
AUTH_TOKEN-gated. The two exempted handlers therefore enforce their OWN gate in
the handler: a Google ID token whose verified email == the bundle's
``subject_email`` (both lowercased). There is NO public/NULL branch — this reuses
only LCT's ``_verify_google_id_token`` primitive, never the share ``allowed_emails``
semantics (which default NULL->public and would fail open here).

Privacy invariants enforced here (ADR-039 "Privacy invariants"):
  - the callback token never reaches a browser (own column, dedicated GET response
    model, NULLed after relay, never logged);
  - the relay target is derived SERVER-SIDE from ``prayer_id`` + INDRASNET_BASE_URL
    (no producer ``callback_url`` -> no SSRF);
  - decisions persist BEFORE the relay and bind to the FIRST set (immutable
    ``decision_hash``); a different-hash resubmit is 409 in ALL states; an
    IndrasNet 409 is idempotent success only for the stored hash;
  - the relay stores/returns only an allowlisted-scalar summary, never a raw
    upstream body; ``last_error`` is sanitized (no body, no token);
  - ``original_text`` (the subject's own words) is scrubbed (NULLed) after a
    successful relay.
"""
from __future__ import annotations

import functools
import logging
import os
import re
import secrets
from datetime import datetime
from typing import Optional, Tuple
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.db_session import get_async_session
from lct_python_backend.services.indrasnet_client import (
    IndrasNetDisabled,
    get_indrasnet_base_url,
    indrasnet_enabled,
)
from lct_python_backend.share_api import GOOGLE_OAUTH_CLIENT_ID, _verify_google_id_token
from lct_python_backend.subject_review_core import (
    DecisionValidationError,
    SubjectDecisionsPayloadV1,
    SubjectReviewBundleV1,
    SubjectReviewItemView,
    SubjectReviewView,
    build_safe_items,
    compute_decision_hash,
    decisions_for_relay,
    parse_relay_result,
    validate_decisions_against_items,
)

logger = logging.getLogger("lct_backend")

router = APIRouter()

# Relay timeout — the decisions POST blocks on this; keep it bounded but generous
# enough for IndrasNet's merge + re-leak-verify.
RELAY_TIMEOUT_SECONDS = float(os.getenv("SUBJECT_REVIEW_RELAY_TIMEOUT_SECONDS", "20"))


# ---------------------------------------------------------------------------
# Public-origin helpers (review_url + the POST Origin defense-in-depth check)
# ---------------------------------------------------------------------------


def _public_origin() -> str:
    """The absolute public origin the subject's review URL is built on. Reuses
    FRONTEND_URL (already the CORS public origin); PUBLIC_BASE_URL overrides."""
    return (os.getenv("PUBLIC_BASE_URL") or os.getenv("FRONTEND_URL") or "").strip().rstrip("/")


def _allowed_public_origins() -> set:
    """Origins accepted on the decisions POST. Same sources the app trusts for
    CORS, so the Origin check can't drift from the actual deploy config."""
    origins = set()
    for src in (os.getenv("PUBLIC_BASE_URL"), os.getenv("FRONTEND_URL")):
        if src and src.strip():
            origins.add(src.strip().rstrip("/"))
    for o in (os.getenv("CORS_ALLOW_ORIGINS", "") or "").split(","):
        o = o.strip().rstrip("/")
        if o:
            origins.add(o)
    return origins


def _check_origin(request: Request) -> None:
    """Defense-in-depth CSRF guard. The custom Authorization header already forces
    a CORS preflight (which the CORS middleware enforces); this is belt-and-
    suspenders. If an Origin/Referer is present AND we have a configured allow-set,
    it must match; a missing Origin (same-origin / non-browser) is allowed because
    the Google ID-token gate is the real authority."""
    allowed = _allowed_public_origins()
    if not allowed:
        return  # nothing configured (dev) — rely on the Google gate + CORS
    origin = (request.headers.get("origin") or "").strip().rstrip("/")
    if not origin:
        referer = (request.headers.get("referer") or "").strip()
        if referer:
            p = urlparse(referer)
            if p.scheme and p.netloc:
                origin = f"{p.scheme}://{p.netloc}".rstrip("/")
    if origin and origin not in allowed:
        raise HTTPException(status_code=403, detail="Cross-origin request rejected.")


# ---------------------------------------------------------------------------
# Google gate (no public branch) — shared by GET + decisions POST
# ---------------------------------------------------------------------------


def _extract_bearer(request: Request) -> Optional[str]:
    auth = request.headers.get("authorization") or ""
    if not auth.lower().startswith("bearer "):
        return None
    token = auth.split(" ", 1)[1].strip()
    return token or None


def _google_auth_required_response() -> JSONResponse:
    """Mirror the share-fetch 401 shape so the frontend's GSI flow triggers. If
    Google verification isn't configured, fail CLOSED (503) — never fall back to
    'trust the client', since this surface has no public branch."""
    if not GOOGLE_OAUTH_CLIENT_ID:
        return JSONResponse(
            status_code=503,
            content={
                "detail": (
                    "Subject review requires Google sign-in, but the server is not "
                    "configured for Google identity verification."
                )
            },
        )
    return JSONResponse(
        status_code=401,
        content={
            "detail": "Sign in with Google to review your words.",
            "auth_required": "google",
            "google_client_id": GOOGLE_OAUTH_CLIENT_ID,
        },
    )


async def _authenticate_subject(request: Request) -> Tuple[Optional[str], Optional[JSONResponse]]:
    """Resolve the caller's verified Google email — runs BEFORE the DB lookup so a
    present-but-invalid bearer cannot probe review-token existence (no 404/401
    oracle). Returns ``(verified_email, None)`` on a valid token, or
    ``(None, challenge)`` when NO bearer is present (the GSI 401/503 challenge). A
    present-but-invalid/unverified token raises HTTPException (401/403/503) here,
    identically for every token. The email == subject_email comparison happens
    AFTER the row is loaded (see ``_email_matches_subject``)."""
    bearer = _extract_bearer(request)
    if bearer is None:
        return None, _google_auth_required_response()
    verified_email = await _verify_google_id_token(bearer)  # lowercased, strict; raises on bad token
    return verified_email, None


def _email_matches_subject(verified_email: str, subject_email: str) -> None:
    if verified_email != (subject_email or "").strip().lower():
        raise HTTPException(
            status_code=403,
            detail="This Google account is not the reviewer for this bundle.",
        )


# Field-path segments that are safe to echo in a sanitized import 422. Any other
# string segment (e.g. an attacker-supplied EXTRA key smuggling a secret) is
# replaced — Pydantic's extra_forbidden error puts the offending key in ``loc``.
_ALLOWED_LOC_SEGMENTS = frozenset({
    "contract_version", "prayer_id", "run_id", "callback_token",
    "subject_email", "subject_name", "items",
    "position_in_doc", "original_text", "proposed_redaction",
})


def _sanitize_loc(loc) -> list:
    out = []
    for seg in loc or ():
        if isinstance(seg, bool):  # bool is an int subclass — guard explicitly
            out.append("<extra>")
        elif isinstance(seg, int):
            out.append(seg)  # array index — not attacker-named
        elif isinstance(seg, str) and seg in _ALLOWED_LOC_SEGMENTS:
            out.append(seg)
        else:
            out.append("<extra>")  # unknown key (could carry a smuggled secret)
    return out


# ---------------------------------------------------------------------------
# Lifecycle helpers
# ---------------------------------------------------------------------------


def _is_expired(row) -> bool:
    return row.expires_at is not None and row.expires_at < datetime.utcnow()


def _guard_lifecycle(row) -> None:
    if row.revoked_at is not None:
        raise HTTPException(status_code=410, detail="This review link has been revoked.")
    if _is_expired(row):
        raise HTTPException(status_code=410, detail="This review link has expired.")


def _sanitize_db_errors(func):
    """Convert any SQLAlchemyError raised in a handler into a sanitized 503 —
    SQLAlchemy's error string embeds the bound parameters (the review token,
    ``decisions_json``, item text), so a raw DB error must never reach a logger or
    the 500 handler. Covers every db.execute/commit in the wrapped endpoint (the
    SELECTs + the CAS/relay UPDATEs); HTTPException and the relay's own errors pass
    through untouched. (The import INSERT keeps its own narrower handler.)"""

    @functools.wraps(func)
    async def wrapper(*args, **kwargs):
        try:
            return await func(*args, **kwargs)
        except SQLAlchemyError:
            logger.error("[subject-review] database error in %s", func.__name__)  # no exc/params
            raise HTTPException(
                status_code=503, detail="A database error occurred. Please retry."
            ) from None

    return wrapper


# ---------------------------------------------------------------------------
# Server-side relay to IndrasNet
# ---------------------------------------------------------------------------


class RelayFailed(Exception):
    """Network/5xx/other-4xx failure contacting IndrasNet. Carries a SANITIZED
    message only (never an upstream body, never the callback token)."""


async def _relay_to_indrasnet(prayer_id: int, callback_token: str, decisions) -> Tuple[str, dict]:
    """POST the subject's decisions to the SERVER-DERIVED callback URL
    ``{INDRASNET_BASE_URL}/api/prayers/{prayer_id}/subject-review``.

    Returns:
        ("relayed", allowlisted_result)  on 2xx
        ("conflict", {})                 on IndrasNet 409 (token already consumed
                                          -> idempotent success for the stored hash)
    Raises:
        RelayFailed  on network error / 5xx / any other non-2xx (sanitized msg).

    NEVER logs or returns the raw upstream body, and never logs the callback token.
    """
    if not indrasnet_enabled():
        raise RelayFailed("review service is not enabled on this server")
    try:
        base = get_indrasnet_base_url()
    except IndrasNetDisabled:
        raise RelayFailed("review service is not configured on this server")

    url = f"{base}/api/prayers/{int(prayer_id)}/subject-review"
    body = {"token": callback_token, "decisions": decisions_for_relay(decisions)}
    headers = {}
    # Optional belt-and-suspenders bearer for IndrasNet, if the deploy sets one.
    # The single-use callback_token in the body is the primary auth (P1 validates it).
    indras_auth = os.getenv("INDRASNET_AUTH_TOKEN")
    if indras_auth:
        headers["Authorization"] = f"Bearer {indras_auth}"

    try:
        async with httpx.AsyncClient(timeout=RELAY_TIMEOUT_SECONDS) as client:
            resp = await client.post(url, json=body, headers=headers)
    except httpx.HTTPError:
        # Sanitized: no URL with token, no body. (chokepoint may also raise here.)
        logger.warning("[subject-review] relay transport error for prayer_id=%s", prayer_id)
        raise RelayFailed("could not reach the review service")

    sc = resp.status_code
    if sc == 409:
        logger.info("[subject-review] relay idempotent 409 for prayer_id=%s", prayer_id)
        return ("conflict", {})
    if 200 <= sc < 300:
        try:
            parsed = resp.json()
        except ValueError:
            parsed = {}
        logger.info("[subject-review] relay ok (%s) for prayer_id=%s", sc, prayer_id)
        return ("relayed", parse_relay_result(parsed))
    # Any other status — sanitized, NEVER the body.
    logger.warning("[subject-review] relay non-2xx (%s) for prayer_id=%s", sc, prayer_id)
    raise RelayFailed(f"review service returned status {sc}")


# ---------------------------------------------------------------------------
# Endpoint 1: import (AUTH_TOKEN-gated; IndrasNet -> LCT)
# ---------------------------------------------------------------------------


@router.post("/api/subject-review/import")
async def import_subject_review(
    request: Request,
    db: AsyncSession = Depends(get_async_session),
):
    """IndrasNet posts a ``SubjectReviewBundleV1``. Stores the row with a fresh
    ``token`` and returns ``{review_url}``. The body is validated MANUALLY (not via
    FastAPI's request-model binding) so a malformed import returns a SANITIZED 422
    — location/type only, never the rejected input. FastAPI's default validation
    error body echoes the failing ``input``, which for this endpoint would leak the
    ``callback_token`` (and item text) back to the caller and into IndrasNet's
    response-logging client. The strict model still rejects (422) a missing/empty
    subject_email, non-unique positions, wrong contract_version, or any unknown
    field (reason/callback_url/conversation_label/redacted_context). The callback
    token is stored in its own column and NEVER returned."""
    raw = await request.body()
    try:
        bundle = SubjectReviewBundleV1.model_validate_json(raw)
    except ValidationError as exc:
        # Strip everything except a SANITIZED field path + error type. Never echo
        # `input`/`ctx`/`msg` (which can carry the callback_token or item content),
        # and sanitize `loc` too — an extra_forbidden error puts the offending KEY
        # in loc, so a secret smuggled as a JSON key would otherwise leak.
        safe_errors = [
            {"loc": _sanitize_loc(e.get("loc")), "type": e.get("type", "value_error")}
            for e in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={"detail": "Invalid subject-review bundle.", "errors": safe_errors},
        )

    token = secrets.token_urlsafe(32)
    safe_items = build_safe_items(bundle)
    import json as _json

    try:
        await db.execute(
            text(
                """
                INSERT INTO subject_review_bundles
                    (token, prayer_id, run_id, callback_token, subject_email,
                     subject_name, items_json, status)
                VALUES
                    (:token, :prayer_id, :run_id, :callback_token, :subject_email,
                     :subject_name, :items_json, 'pending')
                """
            ),
            {
                "token": token,
                "prayer_id": bundle.prayer_id,
                "run_id": bundle.run_id,
                "callback_token": bundle.callback_token,
                "subject_email": bundle.subject_email,  # already normalized lowercase
                "subject_name": bundle.subject_name,
                "items_json": _json.dumps(safe_items, ensure_ascii=True),
            },
        )
        await db.commit()
    except Exception:
        # Never log the exception object — SQLAlchemy's error string embeds the
        # bound params (callback_token + item text). Log only non-sensitive ids,
        # and detach the cause (`from None`) so no downstream traceback re-attaches
        # the parameterized DB error. The rollback is itself guarded so that if it
        # raises, the original parameterized error can't propagate via __context__.
        try:
            await db.rollback()
        except Exception:
            pass
        logger.error(
            "[subject-review] import DB write failed for prayer_id=%s subject=%s",
            bundle.prayer_id, bundle.subject_email,
        )
        raise HTTPException(status_code=503, detail="Could not store the review bundle.") from None

    # Audit log: prayer_id + subject_email ONLY — never content or token.
    logger.info(
        "[subject-review] imported bundle prayer_id=%s run_id=%s subject=%s items=%d",
        bundle.prayer_id, bundle.run_id, bundle.subject_email, len(safe_items),
    )

    origin = _public_origin()
    review_path = f"/subject-review/{token}"
    review_url = f"{origin}{review_path}" if origin else review_path
    return {"review_url": review_url}


# ---------------------------------------------------------------------------
# Endpoint 2: GET the bundle (Google-gated)
# ---------------------------------------------------------------------------


@router.get("/api/subject-review/{token}", response_model=SubjectReviewView)
@_sanitize_db_errors
async def get_subject_review(
    token: str,
    request: Request,
    db: AsyncSession = Depends(get_async_session),
):
    """Return the subject's items for review. Google-gated: verified email must
    equal the bundle's ``subject_email``. The response model structurally cannot
    carry the callback token / prayer_id / run_id. Gate ordering (no metadata
    oracle): the Google token is verified BEFORE any DB lookup — a missing OR
    invalid bearer is rejected identically for every token — and revoked/expired
    (410) state is only revealed AFTER the email match, so a token-holder who is
    not the subject cannot probe existence/lifecycle."""
    verified_email, challenge = await _authenticate_subject(request)
    if challenge is not None:
        return challenge

    row = (
        await db.execute(
            text("SELECT * FROM subject_review_bundles WHERE token = :token"),
            {"token": token},
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Review link not found.")
    _email_matches_subject(verified_email, row.subject_email)
    _guard_lifecycle(row)

    import json as _json

    raw_items = _json.loads(row.items_json) if row.items_json else []
    items = [
        SubjectReviewItemView(
            position_in_doc=int(it["position_in_doc"]),
            original_text=str(it["original_text"]),
            proposed_redaction=str(it["proposed_redaction"]),
        )
        for it in raw_items
    ]
    return SubjectReviewView(
        subject_name=row.subject_name,
        items=items,
        status=row.status,
        viewer_email=verified_email,
    )


# ---------------------------------------------------------------------------
# Endpoint 3: submit decisions (Google-gated + Origin-checked + relay)
# ---------------------------------------------------------------------------


@router.post("/api/subject-review/{token}/decisions")
@_sanitize_db_errors
async def submit_subject_decisions(
    token: str,
    request: Request,
    payload: SubjectDecisionsPayloadV1,
    db: AsyncSession = Depends(get_async_session),
):
    """Validate + persist the subject's decisions (immutable, idempotent) then
    relay them server-side to IndrasNet. See the module docstring for the full
    state machine and privacy invariants."""
    _check_origin(request)

    # Gate ordering (no metadata oracle): verify the Google token BEFORE any DB
    # lookup (missing OR invalid bearer rejected identically for every token);
    # the email match precedes the revoked/expired (410) check.
    verified_email, challenge = await _authenticate_subject(request)
    if challenge is not None:
        return challenge

    row = (
        await db.execute(
            text("SELECT * FROM subject_review_bundles WHERE token = :token"),
            {"token": token},
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Review link not found.")
    _email_matches_subject(verified_email, row.subject_email)
    _guard_lifecycle(row)

    import json as _json

    # Stable across the (possible) row re-reads below — same token, same prayer.
    prayer_id = int(row.prayer_id)
    incoming_hash = compute_decision_hash(payload.decisions)
    stored_hash = row.decision_hash

    # Immutable binding: a DIFFERENT decision set is 409 in EVERY state (incl.
    # relayed/failed) — the token is single-use at IndrasNet, so LCT must never
    # acknowledge a set other than the first.
    if stored_hash and stored_hash != incoming_hash:
        raise HTTPException(
            status_code=409,
            detail="Decisions were already submitted for this review and cannot be changed.",
        )

    # Terminal: already relayed (same hash) -> return the stored result, no re-relay.
    if row.status == "relayed":
        return {
            "status": "relayed",
            "result": _json.loads(row.relay_result) if row.relay_result else {},
        }

    if stored_hash is None:
        # First submission: validate against the stored items (exact set equality
        # + redact_span substring), then CAS pending -> submitted (decision_hash
        # IS NULL guard makes concurrent first-submits race-safe).
        raw_items = _json.loads(row.items_json) if row.items_json else []
        try:
            validate_decisions_against_items(payload.decisions, raw_items)
        except DecisionValidationError as exc:
            raise HTTPException(status_code=422, detail=str(exc))

        now = datetime.utcnow()
        cas = await db.execute(
            text(
                """
                UPDATE subject_review_bundles
                SET decisions_json = :decisions_json,
                    decision_hash = :decision_hash,
                    status = CASE WHEN status = 'pending' THEN 'submitted' ELSE status END,
                    submitted_at = COALESCE(submitted_at, :now)
                WHERE token = :token AND decision_hash IS NULL
                """
            ),
            {
                "decisions_json": _json.dumps(decisions_for_relay(payload.decisions), ensure_ascii=True),
                "decision_hash": incoming_hash,
                "now": now,
                "token": token,
            },
        )
        await db.commit()
        if cas.rowcount == 0:
            # Lost the race — someone set a hash first. Re-read and reconcile.
            row = (
                await db.execute(
                    text("SELECT * FROM subject_review_bundles WHERE token = :token"),
                    {"token": token},
                )
            ).first()
            if row is None:
                raise HTTPException(status_code=404, detail="Review link not found.")
            if row.decision_hash and row.decision_hash != incoming_hash:
                raise HTTPException(
                    status_code=409,
                    detail="Decisions were already submitted for this review and cannot be changed.",
                )
            if row.status == "relayed":
                return {
                    "status": "relayed",
                    "result": _json.loads(row.relay_result) if row.relay_result else {},
                }
    # else: same-hash re-attempt of an already-persisted (submitted/failed) set —
    # skip re-validation; relay from the persisted decisions below.

    # --- Relay (decisions are persisted; the lock/txn is released) ---
    try:
        outcome, result = await _relay_to_indrasnet(
            prayer_id=prayer_id,
            callback_token=row.callback_token,
            decisions=payload.decisions,
        )
    except RelayFailed as exc:
        now = datetime.utcnow()
        # Guarded by status <> 'relayed' so a concurrent failing attempt can never
        # overwrite last_error / bump attempts on a row another request just relayed
        # (the relayed row is terminal + already scrubbed).
        await db.execute(
            text(
                """
                UPDATE subject_review_bundles
                SET status = 'failed',
                    last_error = :err,
                    relay_attempts = relay_attempts + 1,
                    submitted_at = COALESCE(submitted_at, :now)
                WHERE token = :token AND status <> 'relayed'
                """
            ),
            {"err": str(exc)[:300], "now": now, "token": token},
        )
        await db.commit()
        raise HTTPException(
            status_code=502,
            detail="Could not deliver your decisions to the review service. Please retry.",
        )

    # Success (2xx) or idempotent 409: mark relayed, scrub secrets + own-words.
    now = datetime.utcnow()
    upd = await db.execute(
        text(
            """
            UPDATE subject_review_bundles
            SET status = 'relayed',
                relayed_at = :now,
                relay_result = :result,
                relay_attempts = relay_attempts + 1,
                last_error = NULL,
                callback_token = NULL,
                items_json = NULL
            WHERE token = :token AND status IN ('submitted', 'failed')
            """
        ),
        {"now": now, "result": _json.dumps(result, ensure_ascii=True), "token": token},
    )
    await db.commit()

    if upd.rowcount == 0:
        # A concurrent relay already finalized this row — return its stored result.
        row = (
            await db.execute(
                text("SELECT relay_result FROM subject_review_bundles WHERE token = :token"),
                {"token": token},
            )
        ).first()
        stored = _json.loads(row.relay_result) if (row and row.relay_result) else result
        return {"status": "relayed", "result": stored}

    logger.info("[subject-review] relayed decisions for prayer_id=%s (%s)", prayer_id, outcome)
    return {"status": "relayed", "result": result}
