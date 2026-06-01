"""Current-owner resolution seam (ADR-034 Step 1).

This is the single chokepoint for "who owns this request's data". Today LCT
is single-user, so it resolves to one configured owner id. When Google OAuth
lands (ADR-034 Step 1 public push), only the *source* changes — every call
site (`get_current_owner_id()` / `resolve_owner_id(...)`) stays the same.

Why an opaque id (`usr_...`) rather than the email: the owner decision was
"opaque user id + email map" — a `users` row maps the stable id to the
mutable Google email/sub, so the email can change without rewriting every
`conversations.owner_id`.

Phasing:
  - NOW (single-user): `get_current_owner_id()` returns ``LCT_OWNER_ID``
    (default ``usr_aditya``). There is no per-request identity yet.
  - LATER (OAuth): the auth middleware sets ``request.state.owner_id`` from
    the verified Google token (mapped via the users table); a request-aware
    resolver reads it. The fallback below remains for background jobs /
    single-user deployments.

IMPORTANT (ADR-034 §F hazard #2): owner_id must NEVER be taken from
client-supplied request/WS payload. Live WS today reads owner_id from client
metadata; the public push must derive it from the authenticated session via
this seam instead. Until then, `resolve_owner_id` treats any client-supplied
value as a no-op and returns the configured owner.
"""

from __future__ import annotations

import os
from typing import Optional

# Default single-owner id. Matches the backfill target in the
# users-table migration (existing default_user/aditya rows -> usr_aditya).
DEFAULT_OWNER_ID = "usr_aditya"


def get_current_owner_id() -> str:
    """The owner id for the current (single-user) deployment.

    Resolution order:
      1. ``LCT_OWNER_ID`` env var (lets a self-hoster pick their own id).
      2. ``DEFAULT_OWNER_ID`` (``usr_aditya``).

    When OAuth lands this gains a request-aware path; the signature and all
    call sites are unchanged.
    """
    value = os.getenv("LCT_OWNER_ID", "").strip()
    return value or DEFAULT_OWNER_ID


def resolve_owner_id(client_supplied: Optional[str] = None) -> str:
    """Resolve the owner for a write path that *used* to trust client input.

    Deliberately ignores ``client_supplied`` (e.g. WS ``metadata.owner_id``,
    import form fields) and returns the authenticated single owner. This is
    the fix for the "client-controlled owner" privilege-escalation hazard:
    today it neutralizes the spoofable field; post-OAuth it will return the
    session owner. ``client_supplied`` is accepted only so existing call
    sites can pass their current value without branching.
    """
    return get_current_owner_id()
