"""
Thematic Analysis Service
Generates coarse-grained thematic nodes from conversation utterances

Uses OpenRouter API to analyze conversations and create high-level thematic structure:
- Condenses 300-400 utterances into 10-15 thematic nodes
- Identifies relationships between thematic nodes (edges)
- Maps each thematic node to constituent utterances
- Supports multiple LLM providers via OpenRouter
"""

import json
import uuid
import httpx
import os
from typing import Dict, List, Any, Optional
from datetime import datetime
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_
from lct_python_backend.models import Utterance, Node, Relationship


class ThematicAnalyzer:
    """Generates thematic structure from conversation utterances"""

    def __init__(self, db_session: AsyncSession, model: str = "anthropic/claude-3.5-sonnet"):
        self.db = db_session
        self.model = model
        self.api_key = os.getenv("OPENROUTER_API_KEY")
        if not self.api_key:
            raise ValueError("OPENROUTER_API_KEY not found in environment variables")

    async def analyze_conversation(
        self,
        conversation_id: str,
        max_themes: int = 50,
        force_reanalysis: bool = False
    ) -> Dict[str, Any]:
        """
        Generate thematic structure for a conversation

        Args:
            conversation_id: UUID of conversation
            max_themes: Maximum number of thematic nodes (soft limit for cost control)
            force_reanalysis: Re-analyze even if thematic nodes exist

        Returns:
            {
                "thematic_nodes": [...],
                "edges": [...],
                "summary": {...}
            }
        """
        # Check if thematic analysis already exists
        if not force_reanalysis:
            existing_result = await self.db.execute(
                select(Node).where(
                    and_(
                        Node.conversation_id == uuid.UUID(conversation_id),
                        Node.level == 2  # Level 2 = thematic/coarse-grained
                    )
                )
            )
            existing_nodes = existing_result.scalars().all()

            if existing_nodes:
                # Return existing thematic structure
                return await self._serialize_existing_structure(existing_nodes, conversation_id)

        # Fetch all utterances for the conversation
        utterances_result = await self.db.execute(
            select(Utterance)
            .where(Utterance.conversation_id == uuid.UUID(conversation_id))
            .order_by(Utterance.sequence_number)
        )
        utterances = utterances_result.scalars().all()

        if not utterances:
            return {
                "thematic_nodes": [],
                "edges": [],
                "summary": {"total_utterances": 0, "error": "No utterances found"}
            }

        # Call LLM to generate thematic structure
        llm_response = await self._call_llm_for_analysis(utterances, max_themes)

        # Save to database
        saved_structure = await self._save_thematic_structure(
            conversation_id,
            utterances,
            llm_response
        )

        return saved_structure

    async def _call_llm_for_analysis(
        self,
        utterances: List[Utterance],
        max_themes: int
    ) -> Dict[str, Any]:
        """
        Call OpenRouter API to generate thematic structure
        """
        # Prepare utterance data for the prompt (use sequence numbers, not UUIDs)
        utterance_data = []
        for utt in utterances:
            utterance_data.append({
                "sequence": utt.sequence_number,
                "speaker": utt.speaker_name or utt.speaker_id,
                "text": utt.text,
                "timestamp_start": utt.timestamp_start,
                "timestamp_end": utt.timestamp_end
            })

        # Construct prompt
        prompt = self._build_thematic_analysis_prompt(utterance_data, max_themes)

        # Define JSON schema for structured response (using sequence numbers instead of UUIDs)
        json_schema = {
            "type": "object",
            "properties": {
                "thematic_nodes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string"},
                            "summary": {"type": "string"},
                            "utterance_sequence_numbers": {
                                "type": "array",
                                "items": {"type": "integer", "minimum": 0}
                            },
                            "node_type": {"type": "string"},
                            "timestamp_start": {"type": "number"},
                            "timestamp_end": {"type": "number"}
                        },
                        "required": ["label", "summary", "utterance_sequence_numbers", "node_type"]
                    }
                },
                "edges": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "source_label": {"type": "string"},
                            "target_label": {"type": "string"},
                            "relationship_type": {"type": "string"},
                            "description": {"type": "string"}
                        },
                        "required": ["source_label", "target_label", "relationship_type"]
                    }
                }
            },
            "required": ["thematic_nodes", "edges"]
        }

        # Try with strict schema first (for models that support it)
        request_body = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": "You are an expert conversation analyst. You analyze conversations and identify high-level thematic structure, relationships between ideas, and the flow of topics. You must respond with valid JSON only."
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "temperature": 0.3,
        }

        # Try to use schema if model supports it, otherwise fall back to json_object
        try:
            request_body["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "thematic_analysis",
                    "strict": True,
                    "schema": json_schema
                }
            }

            async with httpx.AsyncClient(timeout=120.0) as client:
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
        except Exception as e:
            # Fallback to basic json_object if schema not supported
            print(f"[WARNING] Schema-based response failed, falling back to json_object: {e}")
            request_body["response_format"] = {"type": "json_object"}

            async with httpx.AsyncClient(timeout=120.0) as client:
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

        # Extract JSON from response (handle cases where LLM adds explanatory text)
        try:
            # First try parsing the whole content as JSON
            thematic_structure = json.loads(content)
        except json.JSONDecodeError:
            # If that fails, try to extract JSON object from the content
            try:
                # Find the first { and last } to extract just the JSON part
                start_idx = content.find('{')
                end_idx = content.rfind('}')

                if start_idx == -1 or end_idx == -1:
                    raise Exception(f"No JSON object found in response.\nContent: {content}")

                json_str = content[start_idx:end_idx + 1]
                thematic_structure = json.loads(json_str)
            except (json.JSONDecodeError, Exception) as e:
                raise Exception(f"Failed to parse LLM JSON response: {e}\nContent: {content}")

        return thematic_structure

    def _build_thematic_analysis_prompt(
        self,
        utterances: List[Dict],
        max_themes: int
    ) -> str:
        """
        Build the prompt for thematic analysis
        """
        utterances_text = "\n".join([
            f"[{u['sequence']}] {u['speaker']}: {u['text']} (timestamp: {u['timestamp_start']:.1f}s)"
            for u in utterances
        ])

        prompt = f"""Analyze this conversation and generate a high-level thematic structure.

CONVERSATION ({len(utterances)} utterances):
{utterances_text}

TASK:
Analyze the conversation complexity and generate an appropriate number of high-level thematic nodes that capture the main topics, discussions, and movements. Each thematic node should represent a coherent segment of the conversation.

GUIDELINES FOR THEME COUNT:
- Simple conversations (single topic): 3-5 themes
- Moderate conversations (few topics): 5-10 themes
- Complex conversations (many topics/tangents): 10-20 themes
- Very complex conversations (many interrelated topics): 20+ themes

Choose the number of themes that best represents the conversation's natural structure. Maximum {max_themes} themes for cost control.

For each thematic node, identify:
1. A concise label (2-5 words)
2. A brief summary (1-2 sentences)
3. The utterance sequence numbers it encompasses (e.g., [5, 6, 7, 12, 15])
4. The node type (e.g., discussion, claim, worldview, normative, question, resolution, debate, consensus, tangent, etc.)
5. Timestamp range (start and end)

Also identify the relationships (edges) between thematic nodes. Create a RICH graph structure - each node should typically have 2-4 edges (either incoming or outgoing or both). Look for:
- TEMPORAL FLOW: How topics lead to each other chronologically (builds_on, leads_to)
- LOGICAL CONNECTIONS: How ideas support or contradict each other (supports, challenges, contradicts)
- THEMATIC LINKS: How topics relate conceptually (informs, explores, provides_context)
- RESOLUTION PATHS: How questions lead to answers (questions, resolves, concludes)
- TANGENTS: How conversation branches and returns (tangent_from, returns_to)

Use whatever relationship labels make sense for this conversation. Examples:
- builds_on, leads_to, informs, provides_context
- contradicts, conflicts_with, challenges, opposes
- supports, reinforces, validates, strengthens
- questions, explores, investigates, examines
- resolves, concludes, synthesizes, integrates
- tangent_from, returns_to, branches_to, revisits
- Or any other labels that accurately describe the relationship

IMPORTANT: Don't just create a linear chain (A→B→C). Look for cross-connections where nodes relate to multiple other nodes.

Return a JSON object with this EXACT structure:
{{
  "thematic_nodes": [
    {{
      "label": "Project Timeline Discussion",
      "summary": "Team discusses Q1 deadlines and resource allocation constraints",
      "utterance_sequence_numbers": [5, 6, 7, 12, 15, 16],
      "node_type": "discussion",
      "timestamp_start": 145.3,
      "timestamp_end": 312.8
    }},
    {{
      "label": "Budget Constraints",
      "summary": "Financial limitations and cost-cutting measures explored",
      "utterance_sequence_numbers": [17, 18, 19, 22],
      "node_type": "discussion",
      "timestamp_start": 315.2,
      "timestamp_end": 445.8
    }},
    {{
      "label": "Resource Allocation",
      "summary": "Debate over team assignments and workload distribution",
      "utterance_sequence_numbers": [20, 21, 25, 26],
      "node_type": "debate",
      "timestamp_start": 450.0,
      "timestamp_end": 620.5
    }}
  ],
  "edges": [
    {{
      "source_label": "Project Timeline Discussion",
      "target_label": "Budget Constraints",
      "relationship_type": "leads_to",
      "description": "Timeline discussion reveals budget concerns"
    }},
    {{
      "source_label": "Project Timeline Discussion",
      "target_label": "Resource Allocation",
      "relationship_type": "informs",
      "description": "Timeline directly impacts resource planning"
    }},
    {{
      "source_label": "Budget Constraints",
      "target_label": "Resource Allocation",
      "relationship_type": "constrains",
      "description": "Budget limits shape resource decisions"
    }}
  ]
}}

EDGE EXAMPLES - Each node can have MULTIPLE outgoing and incoming edges:
- One node can lead to multiple other nodes (fan-out)
- Multiple nodes can feed into one node (fan-in)
- Nodes can have both forward progression AND thematic connections
- Example: "Introduction" could have edges to "Problem Statement" (leads_to), "Background" (provides_context), AND "Motivation" (establishes)

IMPORTANT:
- Use utterance sequence numbers (simple integers) - NOT UUIDs
- Sequence numbers are much easier to work with than complex UUID strings
- Ensure timestamps are accurate (in seconds)
- Choose the number of themes that best fits the conversation complexity
- Every edge must reference labels that exist in thematic_nodes
- Use descriptive node types and relationship types that make sense for this specific conversation
"""
        return prompt

    async def _save_thematic_structure(
        self,
        conversation_id: str,
        utterances: List[Utterance],
        thematic_structure: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Save thematic nodes and edges to database

        Converts sequence numbers from LLM response to UUIDs for database storage
        """
        conv_uuid = uuid.UUID(conversation_id)
        created_nodes = []
        label_to_node_id = {}  # Map labels to created node IDs

        # Create mapping: sequence_number -> UUID (for remapping LLM response)
        seq_to_uuid = {utt.sequence_number: utt.id for utt in utterances}

        print(f"[INFO] Remapping sequence numbers to UUIDs using {len(seq_to_uuid)} utterances")

        # Create thematic nodes
        for theme in thematic_structure.get("thematic_nodes", []):
            # Remap sequence numbers to UUIDs
            sequence_numbers = theme.get("utterance_sequence_numbers", [])
            utterance_uuids = []

            for seq_num in sequence_numbers:
                if seq_num in seq_to_uuid:
                    utterance_uuids.append(seq_to_uuid[seq_num])
                else:
                    print(f"[WARNING] Sequence number {seq_num} not found in utterances for theme '{theme.get('label')}'")

            if not utterance_uuids:
                print(f"[WARNING] Theme '{theme.get('label')}' has no valid utterances, skipping")
                continue

            # Create Node
            node = Node(
                id=uuid.uuid4(),
                conversation_id=conv_uuid,
                node_name=theme.get("label", "Untitled Theme"),
                summary=theme.get("summary", ""),
                node_type=theme.get("node_type", "discussion"),
                level=2,  # Level 2 = thematic/coarse-grained
                chunk_ids=[],  # Thematic nodes don't belong to specific chunks
                utterance_ids=utterance_uuids,
                timestamp_start=theme.get("timestamp_start"),
                timestamp_end=theme.get("timestamp_end"),
                duration_seconds=(
                    theme.get("timestamp_end", 0) - theme.get("timestamp_start", 0)
                    if theme.get("timestamp_end") and theme.get("timestamp_start")
                    else None
                ),
                zoom_level_visible=[2],  # Visible at zoom level 2
                confidence_score=0.85  # Default confidence for AI-generated themes
            )

            self.db.add(node)
            created_nodes.append({
                "id": str(node.id),
                "label": theme.get("label"),
                "summary": theme.get("summary"),
                "utterance_ids": [str(uid) for uid in utterance_uuids],  # Convert UUIDs to strings for JSON
                "node_type": theme.get("node_type"),
                "timestamp_start": theme.get("timestamp_start"),
                "timestamp_end": theme.get("timestamp_end")
            })
            label_to_node_id[theme.get("label")] = node.id

        await self.db.flush()  # Flush to get node IDs

        # Create edges/relationships
        created_edges = []
        for edge in thematic_structure.get("edges", []):
            source_label = edge.get("source_label")
            target_label = edge.get("target_label")

            if source_label not in label_to_node_id or target_label not in label_to_node_id:
                print(f"[WARNING] Skipping edge: {source_label} -> {target_label} (node not found)")
                continue

            relationship = Relationship(
                id=uuid.uuid4(),
                conversation_id=conv_uuid,
                from_node_id=label_to_node_id[source_label],
                to_node_id=label_to_node_id[target_label],
                relationship_type=edge.get("relationship_type", "related"),
                explanation=edge.get("description", ""),
                strength=1.0,
                confidence=0.85
            )

            self.db.add(relationship)
            created_edges.append({
                "source": source_label,
                "target": target_label,
                "type": edge.get("relationship_type"),
                "description": edge.get("description")
            })

        await self.db.commit()

        return {
            "thematic_nodes": created_nodes,
            "edges": created_edges,
            "summary": {
                "total_utterances": len(utterances),
                "total_themes": len(created_nodes),
                "total_edges": len(created_edges),
                "model": self.model,
                "timestamp": datetime.utcnow().isoformat()
            }
        }

    async def _serialize_existing_structure(
        self,
        nodes: List[Node],
        conversation_id: str
    ) -> Dict[str, Any]:
        """
        Serialize existing thematic structure from database
        """
        thematic_nodes = []
        node_id_to_label = {}

        for node in nodes:
            thematic_nodes.append({
                "id": str(node.id),
                "label": node.node_name,
                "summary": node.summary,
                "utterance_ids": [str(uid) for uid in (node.utterance_ids or [])],
                "node_type": node.node_type,
                "timestamp_start": node.timestamp_start,
                "timestamp_end": node.timestamp_end
            })
            node_id_to_label[node.id] = node.node_name

        # Fetch relationships
        edges_result = await self.db.execute(
            select(Relationship).where(
                Relationship.conversation_id == uuid.UUID(conversation_id)
            )
        )
        relationships = edges_result.scalars().all()

        edges = []
        for rel in relationships:
            if rel.from_node_id in node_id_to_label and rel.to_node_id in node_id_to_label:
                edges.append({
                    "source": str(rel.from_node_id),  # Use node ID, not label
                    "target": str(rel.to_node_id),    # Use node ID, not label
                    "type": rel.relationship_type,
                    "description": rel.explanation
                })

        # Debug logging for edge data flow
        print(f"[DEBUG thematic_analyzer] Returning {len(edges)} edges from _serialize_existing_structure:")
        for edge in edges:
            print(f"  Edge: {edge['source']} -> {edge['target']} (type: {edge['type']})")
        print(f"[DEBUG thematic_analyzer] Node IDs available: {list(node_id_to_label.keys())}")

        return {
            "thematic_nodes": thematic_nodes,
            "edges": edges,
            "summary": {
                "total_themes": len(thematic_nodes),
                "total_edges": len(edges),
                "from_cache": True
            }
        }
