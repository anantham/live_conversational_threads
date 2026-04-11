"""
Lightweight Fact-Check Service for Real-Time Transcript Analysis

Scans transcript windows for claims and flags:
- Factual (verifiable), Normative (should/ought), Assumption/Worldview
- Contradiction, Fallacy, Uncertainty

Uses OpenAI Flash models via local_chat_json.
"""

import json
import logging
from typing import Any, Dict, List, Optional

from services.local_llm_client import local_chat_json
from services.llm_config import load_llm_config

logger = logging.getLogger(__name__)

FACT_CHECK_PROMPT = """You are a conversational analysis assistant. Analyze the transcript window below for claims and potential issues.

Return ONLY valid JSON (no markdown formatting):
{
  "claims": [
    {
      "type": "factual|normative|worldview",
      "text": "the claim or statement",
      "speaker": "speaker_id or speaker name",
      "flags": ["contradiction|fallacy|uncertainty"] or []
    }
  ],
  "summary": "brief 1-2 sentence summary of what's being discussed",
  "urgency": "none|caution|review"
}

Categories:
- FACTUAL: verifiable claims (e.g., "GDP grew 3%", "The Earth is round")
- NORMATIVE: value judgments (e.g., "We should prioritize X", "Y is wrong")
- WORLDVIEW: implicit beliefs/frames (e.g., "Markets naturally optimize", hidden premises)

Flags:
- CONTRADICTION: contradicts earlier claim in this window
- FALLACY: reasoning error, false dichotomy, strawman, etc.
- UNCERTAINTY: hedge language, speculation, unverified claim

Urgency:
- NONE: normal discussion
- CAUTION: contradiction detected (node should flash orange)
- REVIEW: fallacy or uncertainty (node should flash yellow)

Transcript window:
{transcript}

Respond with ONLY JSON."""


async def analyze_transcript_window(
    transcript_window: str,
    db_session: Any = None,
) -> Dict[str, Any]:
    """
    Analyze a transcript window for claims and issues.

    Args:
        transcript_window: Formatted transcript text (e.g., "Speaker A: ...\nSpeaker B: ...")
        db_session: Optional database session for LLM config

    Returns:
        {
            "claims": [...],
            "summary": "...",
            "urgency": "none|caution|review"
        }
    """
    if not transcript_window or len(transcript_window.strip()) < 50:
        logger.debug("[FACTCHECK] Transcript window too short, skipping")
        return {"claims": [], "summary": "", "urgency": "none"}

    try:
        config = await load_llm_config(db_session) if db_session else {"chat_model": "gpt-4o-mini"}

        messages = [
            {"role": "system", "content": FACT_CHECK_PROMPT.replace("{transcript}", transcript_window)}
        ]

        result = await local_chat_json(config, messages, temperature=0.2, max_tokens=1000)

        if isinstance(result, dict):
            return {
                "claims": result.get("claims", []),
                "summary": result.get("summary", ""),
                "urgency": result.get("urgency", "none"),
            }

        logger.warning("[FACTCHECK] Unexpected result type: %s", type(result))
        return {"claims": [], "summary": "", "urgency": "none"}

    except Exception as exc:
        logger.error("[FACTCHECK] Analysis failed: %s", exc)
        return {"claims": [], "summary": "", "urgency": "none"}


def format_transcript_window(
    utterances: List[Dict[str, Any]],
    max_turns: int = 10,
) -> str:
    """
    Format utterances into a transcript window string.

    Args:
        utterances: List of {speaker_id, speaker_name, text, timestamp} dicts
        max_turns: Maximum number of turns to include

    Returns:
        Formatted transcript string
    """
    if not utterances:
        return ""

    recent = utterances[-max_turns:] if len(utterances) > max_turns else utterances

    lines = []
    for u in recent:
        speaker = u.get("speaker_name") or u.get("speaker_id", "Unknown")
        text = u.get("text", "").strip()
        if text:
            lines.append(f"{speaker}: {text}")

    return "\n".join(lines)


async def check_conversation_facts(
    conversation_id: str,
    db_session: Any,
    window_turns: int = 10,
) -> Dict[str, Any]:
    """
    Check facts for a conversation's recent transcript window.

    Args:
        conversation_id: UUID of conversation
        db_session: Database session
        window_turns: Number of recent turns to analyze

    Returns:
        Fact-check results with claims and urgency
    """
    from sqlalchemy import select
    from models import Utterance

    try:
        stmt = (
            select(Utterance)
            .where(Utterance.conversation_id == conversation_id)
            .order_by(Utterance.sequence_number.desc())
            .limit(window_turns)
        )
        result = await db_session.execute(stmt)
        utterances = list(result.scalars().all())

        if not utterances:
            return {"claims": [], "summary": "", "urgency": "none"}

        utterances = list(reversed(utterances))
        transcript = format_transcript_window(
            [
                {
                    "speaker_id": u.speaker_id or "",
                    "speaker_name": u.speaker_name or "",
                    "text": u.transcript_text or "",
                    "timestamp": u.timestamp_start,
                }
                for u in utterances
            ],
            max_turns=window_turns,
        )

        return await analyze_transcript_window(transcript, db_session)

    except Exception as exc:
        logger.error("[FACTCHECK] Conversation fact-check failed: %s", exc)
        return {"claims": [], "summary": "", "urgency": "none"}