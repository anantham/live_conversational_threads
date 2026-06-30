import logging
from typing import List, Dict, Any, Optional

from lct_python_backend.models.core import Utterance
from .transcript_revision_service import propose_revision

logger = logging.getLogger("lct_backend")


async def reconcile_and_patch_utterances(
    conversation_id: str,
    utterances: List[Utterance],
    asr_segments: List[Dict[str, Any]],
    db=None,
) -> None:
    """Decision-B: propose a transcript revision instead of patching directly.

    The slow-pass (Attendee MP3 re-transcription) must NOT overwrite the live
    transcript in place (audit A4).  This function saves the ASR output as a
    pending TranscriptRevision for operator review.  The operator approves or
    rejects it via the /api/conversations/{id}/revisions/{rid}/{approve,reject}
    endpoints.

    If `db` is None (legacy callers) or segments are empty, this is a no-op with
    a warning — same safe baseline as before, but now explicit about why.
    """
    if not asr_segments:
        logger.warning(
            "[reconciliation] no ASR segments to propose for conversation %s — skipping",
            conversation_id,
        )
        return

    if db is None:
        logger.warning(
            "[reconciliation] db session not provided for conversation %s — "
            "cannot persist revision; pass db= to callers of reconcile_and_patch_utterances",
            conversation_id,
        )
        return

    try:
        revision_id = await propose_revision(
            db,
            conversation_id=conversation_id,
            proposed_segments=asr_segments,
            source="slow_pass",
            current_utterance_count=len(utterances),
        )
        await db.commit()
        logger.info(
            "[reconciliation] proposed revision %s for conversation %s "
            "(%d ASR segment(s); review at /api/conversations/%s/revisions)",
            revision_id, conversation_id, len(asr_segments), conversation_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[reconciliation] failed to propose revision for conversation %s — %s",
            conversation_id, exc,
        )
