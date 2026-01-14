"""
Level 1: Mega-Theme Clusterer

Clusters Level 2 themes (10-15 nodes) into mega-themes (3-5 nodes).
Merges 3-4 themes into high-level conversation topics.
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


class Level1Clusterer(BaseClusterer):
    """
    Cluster Level 2 themes into mega-themes (L1).

    Takes 10-15 themes and creates 3-5 mega-themes.
    """

    def __init__(self, db, model: str = "anthropic/claude-3.5-sonnet", clustering_ratio: float = 2.5):
        super().__init__(db, model, level=1)
        self.clustering_ratio = clustering_ratio
        self.api_key = os.getenv("OPENROUTER_API_KEY")

    async def generate_level(
        self,
        conversation_id: str,
        parent_nodes: List[Node] = None,
        utterances: List[Utterance] = None
    ) -> List[Node]:
        """
        Generate Level 1 by clustering Level 2 nodes.

        Args:
            conversation_id: UUID of conversation
            parent_nodes: Level 2 theme nodes
            utterances: Not used for clustering levels

        Returns:
            List of mega-theme nodes (3-5 nodes)
        """
        if not parent_nodes:
            raise ValueError("Level 1 requires Level 2 parent nodes to cluster")

        # Call LLM to cluster themes into mega-themes (include transcript for extra context if available)
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
                node_name=cluster.get("label", "Untitled Mega-Theme"),
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

        # Persist optional relationships between mega themes
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
        """Call OpenRouter API to cluster themes into mega-themes."""
        # Prepare parent theme data
        themes_data = []
        for node in parent_nodes:
            themes_data.append({
                "label": node.node_name,
                "summary": node.summary,
                "node_type": node.node_type,
                "utterance_count": len(node.utterance_ids or [])
            })

        # Build prompt (include transcript if provided for more context)
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
                    "content": "You identify high-level patterns and return valid JSON only.",
                },
                {"role": "user", "content": prompt},
            ]
            parsed = await local_chat_json(
                config,
                messages,
                temperature=0.3,
                max_tokens=2400,
            )
            return {
                "clusters": parsed.get("clusters", []) if isinstance(parsed, dict) else [],
                "relationships": parsed.get("relationships", []) if isinstance(parsed, dict) else [],
            }

        if not self.api_key:
            raise ValueError("OPENROUTER_API_KEY not found in environment variables")

        # Make API request
        request_body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": "You are an expert at identifying high-level patterns and creating meaningful thematic groupings. You must respond with valid JSON only."},
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
            return {
                "clusters": parsed.get("clusters", []),
                "relationships": parsed.get("relationships", []),
            }
        except json.JSONDecodeError as e:
            raise Exception(f"Failed to parse LLM JSON response: {e}\nContent: {content}")

    def _build_clustering_prompt(self, themes: List[Dict], transcript_text: str = None) -> str:
        """Build prompt for clustering themes into mega-themes."""
        themes_text = "\n".join([
            f"{i+1}. {t['label']} ({t['utterance_count']} utterances): {t['summary']}"
            for i, t in enumerate(themes)
        ])

        transcript_section = f"\nRAW TRANSCRIPT:\n{transcript_text}\n" if transcript_text else ""

        prompt = f"""Given these {len(themes)} conversation themes, identify 3-5 mega-themes that capture the highest-level topics.

THEMES:
{themes_text}
{transcript_section}

TASK:
Create 3-5 mega-theme clusters that represent the main areas of discussion.

GUIDELINES:
- Each mega-theme should merge 3-4 related themes
- Focus on the BIG PICTURE - what are the major topics of this conversation?
- Look for overarching themes that connect multiple sub-discussions
- Use high-level, descriptive labels that immediately convey the topic
- Each mega-theme should be clearly distinct from the others
- Think: "If I had to describe this conversation in 3-5 bullet points, what would they be?"

Return JSON in this EXACT format:
{{
  "clusters": [
    {{
      "label": "Project Planning and Execution",
      "summary": "High-level discussion of project goals, timelines, resource allocation, and execution strategy",
      "node_type": "discussion",
      "parent_labels": ["Timeline Planning", "Budget Discussion", "Resource Allocation", "Risk Management"]
    }},
    ...
  ],
  "relationships": [
    {{
      "source_label": "Project Planning and Execution",
      "target_label": "Governance and Accountability",
      "relationship_type": "supports",
      "description": "Explain how these mega-themes relate",
      "confidence": 0.8
    }}
  ]
}}

IMPORTANT: parent_labels must EXACTLY match the labels from the themes list above."""

        return prompt
