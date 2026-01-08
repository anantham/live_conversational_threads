"""
Level 4: Fine Clusterer

Clusters Level 5 atomic themes (60-120 nodes) into fine-grained themes (40-60 nodes).
Merges 2-3 closely related atomic themes.
"""

import json
import httpx
import os
from typing import List, Dict, Any
import uuid

from lct_python_backend.models import Node, Utterance
from .base_clusterer import BaseClusterer


class Level4Clusterer(BaseClusterer):
    """
    Cluster atomic themes (L5) into fine-grained themes (L4).

    Takes 60-120 atomic themes and creates 40-60 fine themes.
    """

    def __init__(self, db, model: str = "anthropic/claude-3.5-sonnet", clustering_ratio: float = 2.5):
        super().__init__(db, model, level=4)
        self.clustering_ratio = clustering_ratio
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
        Generate Level 4 by clustering Level 5 nodes.

        Args:
            conversation_id: UUID of conversation
            parent_nodes: Level 5 atomic theme nodes
            utterances: Not used for clustering levels

        Returns:
            List of fine theme nodes (40-60 nodes)
        """
        if not parent_nodes:
            raise ValueError("Level 4 requires Level 5 parent nodes to cluster")

        # Call LLM to cluster atomic themes (pass transcript for additional context if available)
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
                node_name=cluster.get("label", "Untitled Fine Theme"),
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

        # Persist optional relationships between new fine themes
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
        """Call OpenRouter API to cluster atomic themes."""
        # Prepare parent theme data
        themes_data = []
        for node in parent_nodes:
            themes_data.append({
                "label": node.node_name,
                "summary": node.summary,
                "node_type": node.node_type,
                "utterance_count": len(node.utterance_ids or [])
            })

        # Build prompt (include raw transcript for additional context if provided)
        transcript_text = None
        if utterances:
            transcript_text = "\n".join([
                f"[{utt.sequence_number}] {utt.speaker_name or utt.speaker_id}: {utt.text}"
                for utt in utterances
            ])

        # Build prompt
        prompt = self._build_clustering_prompt(themes_data, transcript_text)

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
            return {
                "clusters": parsed.get("clusters", []),
                "relationships": parsed.get("relationships", []),
            }
        except json.JSONDecodeError as e:
            raise Exception(f"Failed to parse LLM JSON response: {e}\nContent: {content}")

    def _build_clustering_prompt(self, themes: List[Dict], transcript_text: str = None) -> str:
        """Build prompt for clustering atomic themes."""
        themes_text = "\n".join([
            f"{i+1}. {t['label']} ({t['utterance_count']} utterances): {t['summary']}"
            for i, t in enumerate(themes)
        ])

        target_count = len(themes) // 2  # Aim to merge 2 themes into 1

        transcript_section = f"\nRAW TRANSCRIPT:\n{transcript_text}\n" if transcript_text else ""

        prompt = f"""Given these {len(themes)} atomic themes, cluster related ones into fine-grained categories.

ATOMIC THEMES:
{themes_text}
{transcript_section}

TASK:
Create approximately {target_count} fine-grained theme clusters (range: {max(10, target_count - 10)} to {target_count + 10}).

GUIDELINES:
- Merge 2-3 atomic themes that discuss closely related sub-topics
- Only cluster themes that are DIRECTLY related
- Preserve important distinctions - don't over-cluster
- Each cluster should have a clear thematic coherence
- Use descriptive labels that capture the cluster's essence

Return JSON in this EXACT format:
{{
  "clusters": [
    {{
      "label": "Budget and Resource Planning",
      "summary": "Discussion of financial constraints and resource allocation",
      "node_type": "discussion",
      "parent_labels": ["Budget constraints", "Resource allocation", "Timeline concerns"]
    }},
    ...
  ],
  "relationships": [
    {{
      "source_label": "Budget and Resource Planning",
      "target_label": "Risk Management",
      "relationship_type": "leads_to",
      "description": "Explain how these fine themes connect",
      "confidence": 0.8
    }}
  ]
}}

IMPORTANT: parent_labels must EXACTLY match the labels from the atomic themes list above."""

        return prompt
