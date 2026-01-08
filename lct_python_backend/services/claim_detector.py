"""
ClaimDetector Service - Three-Layer Claim Taxonomy

Detects and classifies claims in conversations into three categories:
1. Factual Claims: Verifiable statements about reality
2. Normative Claims: Value judgments, prescriptions, "ought" statements
3. Worldview Claims: Implicit ideological frames and hidden premises

Uses Claude 3.5 Sonnet for claim detection and OpenAI for embeddings.
"""

import json
import uuid
from typing import List, Dict, Any, Optional
from datetime import datetime
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import anthropic
import os

from models import Claim, Node, Utterance
from services.prompt_manager import get_prompt_manager
from services.embedding_service import get_embedding_service


class ClaimDetector:
    """
    Service for detecting and classifying claims in conversations.

    Implements three-layer taxonomy:
    - Factual: "GDP grew 3.2%"
    - Normative: "We should prioritize equality"
    - Worldview: "Markets naturally optimize outcomes" (hidden: markets are efficient)
    """

    def __init__(self, db_session: AsyncSession):
        """
        Initialize claim detector.

        Args:
            db_session: Async database session
        """
        self.db = db_session
        self.prompt_manager = get_prompt_manager()
        self.embedding_service = get_embedding_service()

        # Initialize Anthropic client
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY not found in environment")

        self.client = anthropic.Anthropic(api_key=api_key)

    async def analyze_conversation(
        self,
        conversation_id: str,
        force_reanalysis: bool = False
    ) -> Dict[str, Any]:
        """
        Analyze all nodes in conversation for claims.

        Args:
            conversation_id: UUID of conversation
            force_reanalysis: If True, re-analyze even if claims exist

        Returns:
            {
                "conversation_id": str,
                "total_claims": int,
                "by_type": {"factual": int, "normative": int, "worldview": int},
                "by_speaker": {...},
                "claims": [...]
            }
        """
        # Get all nodes in conversation
        nodes = await self._get_conversation_nodes(conversation_id)

        all_claims = []

        for node in nodes:
            # Check if already analyzed
            if not force_reanalysis:
                existing_claims = await self._get_node_claims(node.id)
                if existing_claims:
                    all_claims.extend(existing_claims)
                    continue

            # Analyze node for claims
            node_claims = await self._analyze_node(conversation_id, node)
            all_claims.extend(node_claims)

        # Aggregate results
        return {
            "conversation_id": conversation_id,
            "total_claims": len(all_claims),
            "by_type": self._aggregate_by_type(all_claims),
            "by_speaker": self._aggregate_by_speaker(all_claims),
            "claims": all_claims
        }

    async def _analyze_node(
        self,
        conversation_id: str,
        node: Node
    ) -> List[Dict[str, Any]]:
        """
        Analyze a single node for claims.

        Args:
            conversation_id: Conversation UUID
            node: Node object

        Returns:
            List of claim dicts
        """
        # Get utterances for this node
        utterances = await self._get_node_utterances(node)

        if not utterances:
            return []

        # Extract claims using LLM
        claims_data = await self._extract_claims_from_utterances(utterances)

        # Generate embeddings for claims
        if claims_data:
            embeddings = await self.embedding_service.embed_claims_batch(claims_data)

            for i, claim_data in enumerate(claims_data):
                claim_data["embedding"] = embeddings[i]

        # Save claims to database
        saved_claims = []
        for claim_data in claims_data:
            saved_claim = await self._save_claim(
                conversation_id,
                str(node.id),
                claim_data,
                utterances
            )
            saved_claims.append(saved_claim)

        return saved_claims

    async def _extract_claims_from_utterances(
        self,
        utterances: List[Any]
    ) -> List[Dict[str, Any]]:
        """
        Use LLM to extract claims from utterances.

        Args:
            utterances: List of Utterance objects or dicts

        Returns:
            List of claim dicts with classification
        """
        # Format utterances for LLM
        utterances_text = self._format_utterances_for_llm(utterances)

        # Render prompt
        prompt_text = self.prompt_manager.render_prompt(
            "detect_claims_three_layer",
            {
                "utterances": utterances_text,
            }
        )

        # Call LLM
        response_data = await self._call_llm_for_claims(utterances_text)

        return response_data.get("claims", [])

    async def _call_llm_for_claims(
        self,
        utterances_text: str
    ) -> Dict[str, Any]:
        """
        Call Claude API to detect claims.

        Args:
            utterances_text: Formatted utterances

        Returns:
            Parsed JSON response with claims
        """
        prompt_text = self.prompt_manager.render_prompt(
            "detect_claims_three_layer",
            {"utterances": utterances_text}
        )

        try:
            response = self.client.messages.create(
                model="claude-3-5-sonnet-20241022",
                max_tokens=4000,
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
            print(f"Response: {content[:500]}")
            return {"claims": []}
        except Exception as e:
            print(f"Error calling LLM: {e}")
            return {"claims": []}

    def _format_utterances_for_llm(
        self,
        utterances: List[Any]
    ) -> str:
        """
        Format utterances for LLM prompt.

        Args:
            utterances: List of Utterance objects or dicts

        Returns:
            Formatted string
        """
        lines = []
        for i, utt in enumerate(utterances):
            if isinstance(utt, dict):
                speaker = utt.get("speaker_name", "Unknown")
                text = utt.get("text", "")
            else:
                speaker = utt.speaker_name
                text = utt.text

            lines.append(f"[{i}] {speaker}: {text}")

        return "\n".join(lines)

    async def _save_claim(
        self,
        conversation_id: str,
        node_id: str,
        claim_data: Dict[str, Any],
        utterances: List[Any]
    ) -> Dict[str, Any]:
        """
        Save claim to database.

        Args:
            conversation_id: Conversation UUID
            node_id: Node UUID
            claim_data: Claim data from LLM
            utterances: Source utterances

        Returns:
            Saved claim as dict
        """
        # Map utterance indices to IDs
        utterance_indices = claim_data.get("utterance_indices", [])
        utterance_ids = []

        for idx in utterance_indices:
            if idx < len(utterances):
                if isinstance(utterances[idx], dict):
                    utt_id = utterances[idx].get("id")
                else:
                    utt_id = utterances[idx].id

                if utt_id:
                    utterance_ids.append(uuid.UUID(str(utt_id)))

        # Create Claim object
        claim = Claim(
            id=uuid.uuid4(),
            conversation_id=uuid.UUID(conversation_id),
            node_id=uuid.UUID(node_id),
            claim_text=claim_data["claim_text"],
            claim_type=claim_data["claim_type"],
            embedding=claim_data.get("embedding"),
            utterance_ids=utterance_ids,
            speaker_name=claim_data.get("speaker"),
            strength=claim_data.get("strength", 0.7),
            confidence=claim_data.get("confidence", 0.7),
            # Factual claim fields
            is_verifiable=claim_data.get("is_verifiable"),
            verification_status=None,  # Will be set by fact-checker later
            # Normative claim fields
            normative_type=claim_data.get("normative_type"),
            implicit_values=claim_data.get("implicit_values"),
            # Worldview claim fields
            worldview_category=claim_data.get("worldview_category"),
            hidden_premises=claim_data.get("hidden_premises"),
            ideological_markers=claim_data.get("ideological_markers"),
        )

        self.db.add(claim)
        await self.db.commit()
        await self.db.refresh(claim)

        return self._claim_to_dict(claim)

    def _claim_to_dict(self, claim: Claim) -> Dict[str, Any]:
        """Convert Claim model to dict."""
        return {
            "id": str(claim.id),
            "conversation_id": str(claim.conversation_id),
            "node_id": str(claim.node_id),
            "claim_text": claim.claim_text,
            "claim_type": claim.claim_type,
            "speaker_name": claim.speaker_name,
            "strength": claim.strength,
            "confidence": claim.confidence,
            "is_verifiable": claim.is_verifiable,
            "verification_status": claim.verification_status,
            "normative_type": claim.normative_type,
            "implicit_values": claim.implicit_values,
            "worldview_category": claim.worldview_category,
            "hidden_premises": claim.hidden_premises,
            "ideological_markers": claim.ideological_markers,
            "analyzed_at": claim.analyzed_at.isoformat() if claim.analyzed_at else None,
        }

    async def _get_conversation_nodes(self, conversation_id: str) -> List[Node]:
        """Get all nodes for conversation."""
        query = select(Node).where(
            Node.conversation_id == uuid.UUID(conversation_id)
        ).order_by(Node.sequence_number)

        result = await self.db.execute(query)
        return result.scalars().all()

    async def _get_node_utterances(self, node: Node) -> List[Utterance]:
        """Get utterances for a node."""
        if not node.utterance_ids:
            return []

        query = select(Utterance).where(
            Utterance.id.in_([uuid.UUID(str(uid)) for uid in node.utterance_ids])
        ).order_by(Utterance.sequence_number)

        result = await self.db.execute(query)
        return result.scalars().all()

    async def _get_node_claims(self, node_id: uuid.UUID) -> List[Dict[str, Any]]:
        """Get existing claims for a node."""
        query = select(Claim).where(Claim.node_id == node_id)
        result = await self.db.execute(query)
        claims = result.scalars().all()

        return [self._claim_to_dict(claim) for claim in claims]

    def _aggregate_by_type(self, claims: List[Dict[str, Any]]) -> Dict[str, int]:
        """Aggregate claims by type."""
        aggregation = {
            "factual": 0,
            "normative": 0,
            "worldview": 0,
            "total": len(claims)
        }

        for claim in claims:
            claim_type = claim.get("claim_type")
            if claim_type in aggregation:
                aggregation[claim_type] += 1

        return aggregation

    def _aggregate_by_speaker(self, claims: List[Dict[str, Any]]) -> Dict[str, Dict]:
        """Aggregate claims by speaker."""
        aggregation = {}

        for claim in claims:
            speaker = claim.get("speaker_name", "Unknown")

            if speaker not in aggregation:
                aggregation[speaker] = {
                    "total": 0,
                    "factual": 0,
                    "normative": 0,
                    "worldview": 0
                }

            aggregation[speaker]["total"] += 1

            claim_type = claim.get("claim_type")
            if claim_type in ["factual", "normative", "worldview"]:
                aggregation[speaker][claim_type] += 1

        return aggregation
