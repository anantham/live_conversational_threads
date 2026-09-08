"""Prevent legacy replacement from invalidating source-backed recovery history."""
from sqlalchemy import select
from lct_python_backend.models import PipelineArtifact
from .passage_journal import STAGE, JournalConflict


async def reject_journal_replacement(db, conversation_id):
    """Caller must hold the conversation row lock until its write completes.

    Use presence, not successful journal decoding: corrupt history also needs
    preservation. No repair, migration, or deletion is implicitly authorized.
    """
    checkpoint = (await db.execute(select(PipelineArtifact.id).where(
        PipelineArtifact.conversation_id == conversation_id,
        PipelineArtifact.stage == STAGE,
    ).limit(1))).scalar_one_or_none()
    if checkpoint is not None:
        raise JournalConflict(
            'Cannot replace journal-backed conversation; use source-preserving '
            'processing or an explicit separate re-extraction')
