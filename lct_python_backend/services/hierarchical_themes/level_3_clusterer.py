"""
Level 3: Medium Clusterer

Clusters Level 4 fine themes (40-60 nodes) into medium-grained themes (20-30 nodes).
Merges 2-3 closely related fine themes.
"""

import json
import httpx
import os
from typing import List, Dict, Any
import uuid

from lct_python_backend.models import Node, Utterance
from lct_python_backend.services.llm_config import load_llm_config
from lct_python_backend.services.local_llm_client import local_chat_json
from .base_clusterer import BaseClusterer


class Level3Clusterer(BaseClusterer):
    """
    Cluster fine themes (L4) into medium-grained themes (L3).

    Takes 40-60 fine themes and creates 20-30 medium themes.
    """

    def __init__(self, db, model: str = "anthropic/claude-3.5-sonnet", clustering_ratio: float = 2.5):
        super().__init__(db, model, level=3)
        self.clustering_ratio = clustering_ratio
        self.api_key = os.getenv("OPENROUTER_API_KEY")

    async def generate_level(
        self,
        conversation_id: str,
        parent_nodes: List[Node] = None,
        utterances: List[Utterance] = None
    ) -> List[Node]:
        """
        Generate Level 3 by clustering Level 4 nodes.

        Args:
            conversation_id: UUID of conversation
            parent_nodes: Level 4 fine theme nodes
            utterances: Not used for clustering levels

        Returns:
            List of medium theme nodes (20-30 nodes)
        """
        if not parent_nodes:
            raise ValueError("Level 3 requires Level 4 parent nodes to cluster")

        # Call LLM to cluster fine themes (pass transcript for extra context if available)
        llm_result = await self._call_llm_for_clustering(parent_nodes, utterances)
        clusters = llm_result.get("clusters", [])
        relationships_data = llm_result.get("relationships", [])

        # Create nodes from clusters
        nodes = []
        parent_by_label = {node.node_name: node for node in parent_nodes}

        for cluster in clusters:
            # Get parent nodes for this cluster
            parent_labels = cluster.get("parent_labels", [])
            parent_node_objects = [parent_by_label.get(label) for label in parent_labels if label in parent_by_label]

            if not parent_node_objects:
                print(f"[WARNING] Cluster '{cluster.get('label')}' has no valid parents, skipping")
                continue

            # Collect all utterance IDs from parents
            all_utterance_ids = []
            for parent in parent_node_objects:
                all_utterance_ids.extend(parent.utterance_ids or [])

            # Remove duplicates, preserve order
            seen = set()
            unique_utterance_ids = []
            for uid in all_utterance_ids:
                if uid not in seen:
                    seen.add(uid)
                    unique_utterance_ids.append(uid)

            # Calculate timestamp range
            timestamps_start = [p.timestamp_start for p in parent_node_objects if p.timestamp_start is not None]
            timestamps_end = [p.timestamp_end for p in parent_node_objects if p.timestamp_end is not None]

            timestamp_start = min(timestamps_start) if timestamps_start else None
            timestamp_end = max(timestamps_end) if timestamps_end else None

            # Create node
            node = self._create_node(
                conversation_id=conversation_id,
                node_name=cluster.get("label", "Untitled Medium Theme"),
                summary=cluster.get("summary", ""),
                node_type=cluster.get("node_type", "discussion"),
                utterance_ids=unique_utterance_ids,
                parent_node_id=None,  # Will set later during save
                timestamp_start=timestamp_start,
                timestamp_end=timestamp_end
            )

            # Link to parents (store parent IDs for later updating)
            node._parent_labels = parent_labels  # Temporary attribute
            nodes.append(node)

        # Save to database
        await self._save_nodes(nodes)

        # Update parent-child links
        await self._update_parent_child_links(nodes, parent_by_label)

        # Persist optional relationships between new medium themes
        await self._persist_relationships(conversation_id, nodes, relationships_data)

        return nodes

    async def _update_parent_child_links(self, nodes: List[Node], parent_by_label: Dict[str, Node]):
        """Update parent nodes' children_ids after creation."""
        for node in nodes:
            parent_labels = getattr(node, '_parent_labels', [])
            for label in parent_labels:
                parent = parent_by_label.get(label)
                if parent:
                    if parent.children_ids is None:
                        parent.children_ids = []
                    if node.id not in parent.children_ids:
                        parent.children_ids.append(node.id)

        await self.db.commit()

    async def _call_llm_for_clustering(self, parent_nodes: List[Node], utterances: List[Utterance] = None) -> Dict[str, Any]:
        """Call OpenRouter API to cluster fine themes."""
        # Prepare parent theme data
        themes_data = []
        for node in parent_nodes:
            themes_data.append({
                "label": node.node_name,
                "summary": node.summary,
                "node_type": node.node_type,
                "utterance_count": len(node.utterance_ids or [])
            })

        # Build prompt (include transcript context if provided)
        transcript_text = None
        if utterances:
            transcript_text = "\n".join([
                f"[{utt.sequence_number}] {utt.speaker_name or utt.speaker_id}: {utt.text}"
                for utt in utterances
            ])

        # Build prompt
        prompt = self._build_clustering_prompt(themes_data, transcript_text)

        config = await load_llm_config(self.db)
        if config.get("mode") == "local":
            messages = [
                {
                    "role": "system",
                    "content": "You identify patterns and return valid JSON only.",
                },
                {"role": "user", "content": prompt},
            ]
            parsed = await local_chat_json(
                config,
                messages,
                temperature=0.3,
                max_tokens=2400,
            )
            return parsed if isinstance(parsed, dict) else {"clusters": [], "relationships": []}

        if not self.api_key:
            raise ValueError("OPENROUTER_API_KEY not found in environment variables")

        # Make API request
        request_body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": "You are an expert at identifying patterns and clustering related topics. You must respond with valid JSON only."},
                {"role": "user", "content": prompt}
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

        try:
            parsed = json.loads(content)
            # Return the full parsed dict containing "clusters" and "relationships"
            return parsed
        except json.JSONDecodeError as e:
            raise Exception(f"Failed to parse LLM JSON response: {e}\nContent: {content}")

    def _build_clustering_prompt(self, themes: List[Dict], transcript_text: str = None) -> str:
        """Build prompt for clustering fine themes."""
        themes_text = "\n".join([
            f"{i+1}. {t['label']} ({t['utterance_count']} utterances): {t['summary']}"
            for i, t in enumerate(themes)
        ])

        target_count = len(themes) // 2  # Aim to merge 2 themes into 1
        transcript_section = f"\nRAW TRANSCRIPT:\n{transcript_text}\n" if transcript_text else ""

        prompt = f"""Given these {len(themes)} fine-grained themes, cluster related ones into medium-grained categories.

FINE THEMES:
{themes_text}
{transcript_section}

TASK:
Create approximately {target_count} medium-grained theme clusters (range: {max(10, target_count - 5)} to {min(30, target_count + 5)}).

GUIDELINES:
- Merge 2-3 fine themes that discuss related topics
- Look for thematic coherence across the fine themes
- Create meaningful groupings that tell a story
- Each cluster should represent a distinct aspect of the conversation
- Use clear, descriptive labels that capture the essence of the cluster

Return JSON in this EXACT format:
{{
  "clusters": [
    {{
      "label": "Technical Implementation Discussion",
      "summary": "Discussion of implementation approaches, technical constraints, and architecture decisions",
      "node_type": "discussion",
      "parent_labels": ["Budget and Resource Planning", "Timeline Constraints", "Technical Feasibility"]
    }},
    ...
  ],
  "relationships": [
    {{
      "source_label": "Governance and Accountability",
      "target_label": "Execution Risks",
      "relationship_type": "informs",
      "description": "Explain how these medium themes connect",
      "confidence": 0.8
    }}
  ]
}}

IMPORTANT: parent_labels must EXACTLY match the labels from the fine themes list above."""

        return prompt
