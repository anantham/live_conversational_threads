"""
IsOughtDetector Service - Naturalistic Fallacy Detection

Detects when speakers jump from descriptive claims (is) to normative claims (ought)
without proper justification. This implements David Hume's is-ought problem:
- IS: Descriptive statements about how things are
- OUGHT: Prescriptive statements about how things should be

Common fallacy types detected:
- Naturalistic Fallacy: "X is natural, therefore X is good"
- Appeal to Nature: "Humans evolved to do X, so X is morally right"
- Appeal to Tradition: "We've always done X, so we should continue X"
- Is-Ought Jump: General conflation of descriptive and normative claims

Uses Claude 3.5 Sonnet for fallacy detection.
"""

import json
import uuid
from typing import List, Dict, Any, Optional
from datetime import datetime
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import anthropic
import os

from models import IsOughtConflation, Claim, Node
from services.prompt_manager import get_prompt_manager


class IsOughtDetector:
    """
    Service for detecting is-ought conflations (naturalistic fallacies).

    Identifies when speakers improperly derive normative conclusions from
    purely descriptive premises without normative justification.
    """

    def __init__(self, db_session: AsyncSession):
        """
        Initialize is-ought detector.

        Args:
            db_session: Async database session
        """
        self.db = db_session
        self.prompt_manager = get_prompt_manager()

        # Initialize Anthropic client
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY not found in environment")

        self.client = anthropic.Anthropic(api_key=api_key)

    async def analyze_conversation(
        self,
        conversation_id: str,
        confidence_threshold: float = 0.7
    ) -> Dict[str, Any]:
        """
        Analyze entire conversation for is-ought conflations.

        Args:
            conversation_id: UUID of conversation
            confidence_threshold: Minimum confidence to include (0-1)

        Returns:
            {
                "conversation_id": str,
                "total_conflations": int,
                "conflations": [
                    {
                        "descriptive_claim": {...},
                        "normative_claim": {...},
                        "fallacy_type": str,
                        "explanation": str,
                        "strength": float,
                        "confidence": float
                    }
                ]
            }
        """
        # Get all claims from conversation
        claims = await self._get_conversation_claims(conversation_id)

        # Separate factual/worldview (descriptive) from normative claims
        descriptive_claims = [
            c for c in claims
            if c.get("claim_type") in ["factual", "worldview"]
        ]
        normative_claims = [
            c for c in claims
            if c.get("claim_type") == "normative"
        ]

        conflations = []

        # Check each descriptive-normative pair
        for descriptive in descriptive_claims:
            for normative in normative_claims:
                # Only check claims that are temporally close
                proximity = self._calculate_temporal_proximity(descriptive, normative)

                if proximity > 0.3:  # Threshold for considering claims related
                    result = await self.check_conflation(descriptive, normative)

                    if result.get("is_conflation") and result.get("confidence", 0) >= confidence_threshold:
                        conflations.append({
                            "descriptive_claim": descriptive,
                            "normative_claim": normative,
                            **result
                        })

        return {
            "conversation_id": conversation_id,
            "total_conflations": len(conflations),
            "conflations": conflations
        }

    async def check_conflation(
        self,
        descriptive_claim: Dict[str, Any],
        normative_claim: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Check if a specific descriptive-normative pair is a conflation.

        Args:
            descriptive_claim: Factual or worldview claim (dict)
            normative_claim: Normative claim (dict)

        Returns:
            {
                "is_conflation": bool,
                "fallacy_type": str (if conflation),
                "explanation": str,
                "strength": float (0-1),
                "confidence": float (0-1),
                "conflation_text": str (optional)
            }
        """
        # Call LLM to analyze potential conflation
        result = await self._call_llm_for_conflation_check(
            descriptive_claim,
            normative_claim
        )

        return result

    async def _call_llm_for_conflation_check(
        self,
        descriptive_claim: Dict[str, Any],
        normative_claim: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Call Claude API to check for is-ought conflation.

        Args:
            descriptive_claim: Factual or worldview claim
            normative_claim: Normative claim

        Returns:
            Parsed JSON response with conflation analysis
        """
        # Format claims for LLM
        claims_text = f"""Descriptive Claim:
Type: {descriptive_claim.get('claim_type')}
Text: {descriptive_claim.get('claim_text')}
Speaker: {descriptive_claim.get('speaker_name', 'Unknown')}

Normative Claim:
Type: {normative_claim.get('claim_type')}
Text: {normative_claim.get('claim_text')}
Speaker: {normative_claim.get('speaker_name', 'Unknown')}
"""

        # Render prompt
        prompt_text = self.prompt_manager.render_prompt(
            "detect_is_ought_conflation",
            {"claims": claims_text}
        )

        try:
            response = self.client.messages.create(
                model="claude-3-5-sonnet-20241022",
                max_tokens=2000,
                temperature=0.3,
                messages=[{"role": "user", "content": prompt_text}]
            )

            # Parse response
            content = response.content[0].text

            # Extract JSON from markdown if present
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0].strip()
            elif "```" in content:
                content = content.split("```")[1].split("```")[0].strip()

            data = json.loads(content)
            return data

        except json.JSONDecodeError as e:
            print(f"Failed to parse LLM response: {e}")
            return {"is_conflation": False, "reason": "Failed to parse response"}
        except Exception as e:
            print(f"Error calling LLM: {e}")
            return {"is_conflation": False, "reason": str(e)}

    def _calculate_temporal_proximity(
        self,
        claim1: Dict[str, Any],
        claim2: Dict[str, Any]
    ) -> float:
        """
        Calculate temporal proximity between two claims.

        Claims closer together in the conversation are more likely to be related.

        Args:
            claim1: First claim
            claim2: Second claim

        Returns:
            Proximity score 0-1 (1 = adjacent, 0 = far apart)
        """
        seq1 = claim1.get("sequence", 0)
        seq2 = claim2.get("sequence", 0)

        # Calculate distance
        distance = abs(seq2 - seq1)

        # Convert to proximity score (exponential decay)
        # Adjacent claims = 1.0, 5 claims apart ≈ 0.6, 10 apart ≈ 0.4, 50 apart ≈ 0.1
        proximity = 1.0 / (1.0 + distance * 0.1)

        return proximity

    async def _save_conflation(
        self,
        conversation_id: str,
        node_id: str,
        descriptive_claim_id: str,
        normative_claim_id: str,
        conflation_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Save is-ought conflation to database.

        Args:
            conversation_id: Conversation UUID
            node_id: Node UUID
            descriptive_claim_id: UUID of descriptive claim
            normative_claim_id: UUID of normative claim
            conflation_data: Conflation details from LLM

        Returns:
            Saved conflation as dict
        """
        conflation = IsOughtConflation(
            id=uuid.uuid4(),
            conversation_id=uuid.UUID(conversation_id),
            node_id=uuid.UUID(node_id),
            descriptive_claim_id=uuid.UUID(descriptive_claim_id),
            normative_claim_id=uuid.UUID(normative_claim_id),
            fallacy_type=conflation_data.get("fallacy_type"),
            explanation=conflation_data.get("explanation", ""),
            strength=conflation_data.get("strength", 0.7),
            confidence=conflation_data.get("confidence", 0.7),
            conflation_text=conflation_data.get("conflation_text"),
            utterance_ids=[
                uuid.UUID(str(uid)) for uid in conflation_data.get("utterance_ids", [])
            ],
            speaker_name=conflation_data.get("speaker_name")
        )

        self.db.add(conflation)
        await self.db.commit()
        await self.db.refresh(conflation)

        return self._conflation_to_dict(conflation)

    def _conflation_to_dict(self, conflation: IsOughtConflation) -> Dict[str, Any]:
        """Convert IsOughtConflation model to dict."""
        return {
            "id": str(conflation.id),
            "conversation_id": str(conflation.conversation_id),
            "node_id": str(conflation.node_id),
            "descriptive_claim_id": str(conflation.descriptive_claim_id),
            "normative_claim_id": str(conflation.normative_claim_id),
            "fallacy_type": conflation.fallacy_type,
            "explanation": conflation.explanation,
            "strength": conflation.strength,
            "confidence": conflation.confidence,
            "conflation_text": conflation.conflation_text,
            "utterance_ids": [str(uid) for uid in (conflation.utterance_ids or [])],
            "speaker_name": conflation.speaker_name,
            "detected_at": conflation.detected_at.isoformat() if conflation.detected_at else None
        }

    async def _get_conversation_claims(self, conversation_id: str) -> List[Dict[str, Any]]:
        """
        Get all claims for a conversation.

        Args:
            conversation_id: Conversation UUID

        Returns:
            List of claim dicts
        """
        query = select(Claim).where(
            Claim.conversation_id == uuid.UUID(conversation_id)
        ).order_by(Claim.id)

        result = await self.db.execute(query)
        claims = result.scalars().all()

        # Add sequence numbers based on order
        claim_dicts = []
        for i, claim in enumerate(claims):
            claim_dict = self._claim_to_dict(claim)
            claim_dict["sequence"] = i
            claim_dicts.append(claim_dict)

        return claim_dicts

    def _claim_to_dict(self, claim: Claim) -> Dict[str, Any]:
        """Convert Claim to dict."""
        return {
            "id": str(claim.id),
            "claim_text": claim.claim_text,
            "claim_type": claim.claim_type,
            "speaker_name": claim.speaker_name,
            "strength": claim.strength,
            "confidence": claim.confidence,
            "utterance_ids": [str(uid) for uid in (claim.utterance_ids or [])]
        }

    async def _get_node(self, node_id: uuid.UUID) -> Optional[Node]:
        """Get node by ID."""
        query = select(Node).where(Node.id == node_id)
        result = await self.db.execute(query)
        return result.scalar_one_or_none()
