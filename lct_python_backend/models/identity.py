"""Identity models: User (ADR-034 Step 1 — per-user tenancy).

The owner decision was "opaque user id + email map": `users.id` is a stable
opaque string (`usr_...`) used as `conversations.owner_id`, while the mutable
Google identity (email, `sub`) lives in columns that can change without
rewriting tenant rows.

Scope note: this table is introduced for the single-user owner-isolation
phase. Google OAuth (the public push) will populate `google_sub` on first
login and look users up by it; until then the only row is the seeded owner
(see the users-table backfill migration).
"""

import uuid

from sqlalchemy import Column, String, DateTime
from sqlalchemy.sql import func

from .base import Base


class User(Base):
    """A person who owns conversations. `id` is the tenant key (`owner_id`)."""

    __tablename__ = "users"

    # Opaque, stable tenant id — this is what conversations.owner_id holds.
    # Not a UUID column: existing owner_id values are TEXT (e.g. 'usr_aditya'),
    # and we want human-greppable ids during the single-user phase.
    id = Column(String(255), primary_key=True)

    # Google identity (populated at OAuth time; nullable during single-user phase).
    email = Column(String(320), nullable=True, unique=True)
    google_sub = Column(String(255), nullable=True, unique=True)

    display_name = Column(String(255), nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return f"<User id={self.id!r} email={self.email!r}>"
