"""Current interpretation overlay; original checkpoint evidence stays immutable.

The existing node-edit API applies title, summary and keywords to canonical
Node rows. Read those applied values, not proposed entries in an edit log, and
do not label them fact-checked or speaker-verified. Structural/source revisions
need explicit reconciliation rather than this narrow presentation overlay.
"""
from __future__ import annotations

import copy
import hashlib
import json
import uuid

from .passage_journal import JournalConflict


def project_interpretations(state: dict, canonical: dict[str, dict]) -> dict:
    projected = copy.deepcopy(state)
    for node in projected["nodes"]:
        current = canonical.get(node["id"])
        if current is None:
            raise JournalConflict("Committed node is missing; structural reconciliation required")
        for field in ("node_name", "summary", "key_points"):
            node[field] = copy.deepcopy(current[field])
    interpreted = [(n["id"], n.get("node_name"), n.get("summary"), n.get("key_points"))
                   for n in projected["nodes"]]
    projected["interpretation_revision"] = hashlib.sha256(
        json.dumps(interpreted, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return projected


async def load_interpretation_projection(db, *, state: dict, conversation_id: str, owner_id: str, source_records=None) -> dict:
    from sqlalchemy import select
    from lct_python_backend.models import Conversation, Node
    # Standalone defense: this reader must never rely only on a prior writer's
    # authorization. Filter before loading any interpretation text.
    owned = (await db.execute(select(Conversation.id).where(
        Conversation.id == uuid.UUID(conversation_id), Conversation.owner_id == owner_id,
        Conversation.deleted_at.is_(None),
    ))).scalar_one_or_none()
    if owned is None:
        raise PermissionError("Conversation unavailable to this owner")
    identities = [uuid.UUID(node["id"]) for node in state["nodes"]]
    canonical = {}
    if identities:
        rows = (await db.execute(select(Node.id, Node.node_name, Node.summary, Node.key_points).where(
            Node.conversation_id == owned, Node.id.in_(identities)
        ))).all()
        canonical = {str(identity): {"node_name": name, "summary": summary, "key_points": points}
                     for identity, name, summary, points in rows}
    projected = project_interpretations(state, canonical)
    if source_records is not None:
        from .attribution_projection import inspect_source_attributions, apply_attribution_projection
        changes = await inspect_source_attributions(db, records=source_records,
            conversation_id=conversation_id, owner_id=owner_id)
        projected = apply_attribution_projection(projected, changes)
    return projected
