"""
Level 5: Atomic Theme Generator

Generates 60-120 micro-themes from raw utterances.
Each theme covers 3-5 consecutive utterances on a single specific point.

This is the finest-grained level and the foundation of the hierarchy.
"""

import json
import httpx
import os
from typing import List, Dict, Any
import uuid

from lct_python_backend.models import Node, Utterance
from .base_clusterer import BaseClusterer


class Level5AtomicGenerator(BaseClusterer):
    """
    Generate atomic (micro) themes from conversation utterances.

    Creates 60-120 very fine-grained themes, each covering 3-5 utterances.
    """

    def __init__(self, db, model: str = "anthropic/claude-3.5-sonnet", utterances_per_theme: int = 5):
        super().__init__(db, model, level=5)
        self.utterances_per_theme = utterances_per_theme
        self.api_key = os.getenv("OPENROUTER_API_KEY")
        if not self.api_key:
            raise ValueError("OPENROUTER_API_KEY not found in environment variables")

    async def generate_level(
        self,
        conversation_id: str,
        parent_nodes: List[Node] = None,
        utterances: List[Utterance] = None
    ) -> List[Node]:
        """
        Generate Level 5 atomic themes from utterances.

        Args:
            conversation_id: UUID of conversation
            parent_nodes: Not used for L5 (works from utterances)
            utterances: Raw conversation utterances

        Returns:
            List of atomic theme nodes (60-120 nodes)
        """
        if not utterances:
            raise ValueError("Level 5 requires utterances to generate from")

        # Call LLM to generate atomic themes + optional relationships between them
        llm_result = await self._call_llm_for_atomic_themes(utterances)
        atomic_themes = llm_result.get("atomic_themes", [])
        relationships_data = llm_result.get("relationships", [])

        # Create utterance lookup
        utterance_by_seq = {utt.sequence_number: utt for utt in utterances}

        # Create nodes from LLM response
        nodes = []
        for theme in atomic_themes:
            # Map sequence numbers to UUIDs
            seq_numbers = theme.get("utterance_sequence_numbers", [])
            utterance_uuids = []
            for seq in seq_numbers:
                if seq in utterance_by_seq:
                    utterance_uuids.append(utterance_by_seq[seq].id)

            if not utterance_uuids:
                print(f"[WARNING] Atomic theme '{theme.get('label')}' has no valid utterances, skipping")
                continue

            node = self._create_node(
                conversation_id=conversation_id,
                node_name=theme.get("label", "Untitled Atomic Theme"),
                summary=theme.get("summary", ""),
                node_type=theme.get("node_type", "discussion"),
                utterance_ids=utterance_uuids,
                parent_node_id=None,  # L5 has no parents
                timestamp_start=theme.get("timestamp_start"),
                timestamp_end=theme.get("timestamp_end")
            )
            nodes.append(node)

        # Save to database
        await self._save_nodes(nodes)

        # Persist optional relationships between atomic themes (if returned)
        await self._persist_relationships(conversation_id, nodes, relationships_data)

        return nodes

    async def _call_llm_for_atomic_themes(self, utterances: List[Utterance]) -> Dict[str, Any]:
        """
        Call OpenRouter API to generate atomic themes.

        Returns:
            Dict with atomic_themes and optional relationships
        """
        # Prepare utterance data
        utterance_data = []
        for utt in utterances:
            utterance_data.append({
                "sequence": utt.sequence_number,
                "speaker": utt.speaker_name or utt.speaker_id,
                "text": utt.text,
                "timestamp_start": utt.timestamp_start,
                "timestamp_end": utt.timestamp_end
            })

        # Build prompt
        prompt = self._build_atomic_themes_prompt(utterance_data)

        # Make API request
        request_body = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": "You are an expert conversation analyst. You analyze conversations and identify atomic thematic units - the smallest coherent topics. You must respond with valid JSON only."
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "temperature": 0.3,
            "response_format": {"type": "json_object"}
        }

        async with httpx.AsyncClient(timeout=180.0) as client:
            response = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://live-conversational-threads.app",
                    "X-Title": "Live Conversational Threads"
                },
                json=request_body
            )

        if response.status_code != 200:
            raise Exception(f"OpenRouter API error: {response.status_code} - {response.text}")

        result = response.json()
        content = result["choices"][0]["message"]["content"]

        # Parse JSON
        try:
            parsed = json.loads(content)
            return {
                "atomic_themes": parsed.get("atomic_themes", []),
                "relationships": parsed.get("relationships", []),
            }
        except json.JSONDecodeError as e:
            raise Exception(f"Failed to parse LLM JSON response: {e}\nContent: {content}")

    def _build_atomic_themes_prompt(self, utterances: List[Dict]) -> str:
        """Build prompt for atomic theme generation."""
        utterances_text = "\n".join([
            f"[{u['sequence']}] {u['speaker']}: {u['text']} (timestamp: {u['timestamp_start']:.1f}s)"
            for u in utterances
        ])

        # Calculate target based on configurable utterances_per_theme
        target_count = max(5, len(utterances) // self.utterances_per_theme)
        range_low = max(3, target_count - 10)
        range_high = target_count + 15

        prompt = f"""Analyze this conversation and identify ATOMIC thematic units - the smallest coherent topics.

CONVERSATION ({len(utterances)} utterances):
{utterances_text}

TASK:
Create approximately {target_count} atomic themes (range: {range_low} to {range_high}).

Each atomic theme should:
1. Cover approximately {self.utterances_per_theme} utterances that discuss ONE specific micro-topic
2. Have a concise label (3-5 words maximum)
3. Have a brief summary (1 sentence)
4. Include the sequence numbers of utterances it encompasses
5. Have a node_type (e.g., "discussion", "claim", "question", "tangent")
6. Include timestamp_start and timestamp_end

GUIDELINES:
- Be granular - create MANY small themes, not a few large ones
- Each theme should be atomic - can't be meaningfully subdivided further
- Themes should cover consecutive utterances (no gaps)
- Every utterance should belong to exactly one theme
- Use descriptive node_types that capture the conversational function

Example atomic themes (for illustration):
- "Timeline concerns" (3 utterances about scheduling)
- "Budget constraints" (4 utterances about costs)
- "Alice's question" (2 utterances where Alice asks clarification)

CRITICAL: You MUST analyze the ENTIRE conversation and create themes for ALL utterances (0 to {len(utterances)-1}).
Do NOT stop partway through. Do NOT add notes or commentary after the JSON.

Return ONLY valid JSON in this EXACT format (no text before or after):
{{
  "atomic_themes": [
    {{
      "label": "Project Timeline Discussion",
      "summary": "Team discusses Q1 deadlines and resource allocation constraints",
      "utterance_sequence_numbers": [0, 1, 2, 3],
      "node_type": "discussion",
      "timestamp_start": 0.0,
      "timestamp_end": 45.2
    }}
  ],
  "relationships": [
    {{
      "source_label": "Project Timeline Discussion",
      "target_label": "Budget and Resource Planning",
      "relationship_type": "leads_to",
      "description": "Explain why these micro-themes connect",
      "confidence": 0.8
    }}
  ]
}}

OUTPUT ONLY THE JSON OBJECT. NO OTHER TEXT."""

        return prompt
