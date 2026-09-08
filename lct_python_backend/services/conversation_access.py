"""Conversation availability at owner and already-authorized capability boundaries."""
import uuid

from fastapi import HTTPException
from sqlalchemy import select

from lct_python_backend.models import Conversation


async def require_live_conversation(db, conversation_id, *, owner_id):
    """Reject unavailable rows before reading content or minting a capability.

    Owner endpoints must supply their trusted configured owner. ``None`` is
    reserved for callers that have already validated a public share capability;
    capability recipients need not be the current deployment owner.
    """
    try:
        cid = uuid.UUID(str(conversation_id))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail='Invalid conversation_id.') from exc
    statement = select(Conversation.id).where(
        Conversation.id == cid, Conversation.deleted_at.is_(None))
    if owner_id is not None:
        statement = statement.where(Conversation.owner_id == owner_id)
    if (await db.execute(statement)).first() is None:
        raise HTTPException(status_code=404, detail='Conversation not found.')
