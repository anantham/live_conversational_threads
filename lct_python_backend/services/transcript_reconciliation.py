import logging
from typing import List, Dict, Any

from lct_python_backend.models.core import Utterance

logger = logging.getLogger("lct_backend")


async def reconcile_and_patch_utterances(
    conversation_id: str,
    utterances: List[Utterance],
    asr_segments: List[Dict[str, Any]],
) -> None:
    """DISABLED (audit A4 / decision B) — intentionally a no-op.

    The slow-pass must NOT destructively overwrite the live transcript. The prior
    prototype rewrote ``Utterance.text``/``text_cleaned`` in place (irreversible,
    no review) and emitted an unhandled ``transcript_patched`` event. Decision B
    replaces that with a review-gated *transcript-revision* flow that is not yet
    built. This stub stays non-destructive so that, even if the slow-pass is
    re-wired, it cannot corrupt live data.

    To implement decision B, write the slow-pass output to REVISION records
    (proposed text + ``status="pending"``) and surface them for operator approval;
    only on approval apply the text and trigger a graph rebuild against a real
    endpoint. Do NOT mutate live utterances here.
    """
    logger.warning(
        "[reconciliation] slow-pass reconcile is DISABLED pending the decision-B "
        "revision flow; ignoring %d ASR segment(s) for conversation %s",
        len(asr_segments or []),
        conversation_id,
    )
    return
