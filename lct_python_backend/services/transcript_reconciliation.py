import logging
from typing import List, Dict, Any
from lct_python_backend.database import SessionLocal
from lct_python_backend.models.core import Utterance

logger = logging.getLogger("lct_backend")

def compute_overlap(start1: float, end1: float, start2: float, end2: float) -> float:
    """Returns the overlap duration in seconds between two time ranges."""
    return max(0.0, min(end1, end2) - max(start1, start2))

async def reconcile_and_patch_utterances(conversation_id: str, utterances: List[Utterance], asr_segments: List[Dict[str, Any]]):
    """
    Patch existing fast-pass utterances with high-fidelity slow-pass STT text.
    Uses time-based overlap matching.
    """
    if not utterances or not asr_segments:
        return
        
    # Group ASR segments by the utterance they overlap with the most
    utterance_text_map = {u.id: [] for u in utterances}
    
    for seg in asr_segments:
        seg_start = float(seg.get("start", 0.0))
        seg_end = float(seg.get("end", seg_start + 1.0))
        
        best_utterance = None
        max_overlap = -1.0
        
        for u in utterances:
            u_start = u.timestamp_start or 0.0
            u_end = u.timestamp_end or (u_start + 1.0)
            
            overlap = compute_overlap(seg_start, seg_end, u_start, u_end)
            if overlap > max_overlap:
                max_overlap = overlap
                best_utterance = u
                
        if best_utterance and max_overlap > 0:
            utterance_text_map[best_utterance.id].append(seg.get("text", "").strip())
        elif best_utterance:
            # If no strict overlap, assign to closest in time (midpoint distance)
            seg_mid = (seg_start + seg_end) / 2.0
            closest_u = min(utterances, key=lambda u: abs((u.timestamp_start or 0.0) + (u.timestamp_end or 0.0)/2.0 - seg_mid))
            utterance_text_map[closest_u.id].append(seg.get("text", "").strip())
            
    # Now execute bulk update and emit WebSocket event
    updated_ids = []
    with SessionLocal() as db:
        for u in utterances:
            new_texts = utterance_text_map[u.id]
            if new_texts:
                combined_text = " ".join(new_texts).strip()
                if combined_text and combined_text != u.text:
                    # Fetch from DB to update
                    db_u = db.query(Utterance).filter(Utterance.id == u.id).first()
                    if db_u:
                        db_u.text = combined_text
                        db_u.text_cleaned = combined_text
                        db_u.speaker_revision += 1
                        updated_ids.append(str(u.id))
                        
        if updated_ids:
            db.commit()
            logger.info(f"[reconciliation] Patched {len(updated_ids)} utterances with STT text.")
        else:
            logger.info("[reconciliation] No utterances needed patching.")
            
    # Step 6: Emit websocket event to UI
    if updated_ids:
        from lct_python_backend.services.attendee_bridge import get_by_conversation
        session = get_by_conversation(str(conversation_id))
        if session:
            # Emit a bulk refresh event to tell the UI to refetch the nodes/utterances
            # because the text was patched.
            session._relay({
                "type": "transcript_patched",
                "data": {
                    "conversation_id": str(conversation_id),
                    "updated_utterance_ids": updated_ids
                }
            })
            logger.info(f"[reconciliation] Emitted transcript_patched event to UI for {conversation_id}")
