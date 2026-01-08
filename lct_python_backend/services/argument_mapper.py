"""
ArgumentMapper Service - Premise → Conclusion Tree Detection

Analyzes claims to build argument structures:
- Identifies premises and conclusions
- Detects argument types (deductive, inductive, abductive)
- Finds circular reasoning
- Validates logical structure
- Generates visualization data for argument trees

Uses Claude 3.5 Sonnet for argument structure analysis.
"""

import json
import uuid
from typing import List, Dict, Any, Optional
from datetime import datetime
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import anthropic
import os

from models import ArgumentTree, Claim, Node
from services.prompt_manager import get_prompt_manager


class ArgumentMapper:
    """
    Service for mapping argument structures from claims.

    Builds premise → conclusion trees to understand reasoning.
    """

    def __init__(self, db_session: AsyncSession):
        """
        Initialize argument mapper.

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

    async def analyze_node(
        self,
        node_id: str,
        force_reanalysis: bool = False
    ) -> Optional[Dict[str, Any]]:
        """
        Analyze a node for argument structures.

        Args:
            node_id: UUID of node
            force_reanalysis: If True, re-analyze even if exists

        Returns:
            Argument tree data or None if no argument found
        """
        # Check if already analyzed
        if not force_reanalysis:
            existing = await self._get_node_argument_tree(uuid.UUID(node_id))
            if existing:
                return self._argument_tree_to_dict(existing)

        # Get claims from node
        claims = await self._get_node_claims(uuid.UUID(node_id))

        if len(claims) < 2:
            # Need at least 2 claims to form an argument
            return None

        # Build argument tree
        tree_data = await self.build_argument_tree(claims)

        if not tree_data.get("has_argument", True):
            return None

        # Save to database
        node = await self._get_node(uuid.UUID(node_id))
        if node:
            saved = await self._save_argument_tree(
                str(node.conversation_id),
                node_id,
                tree_data.get("root_claim_id"),
                tree_data
            )
            return saved

        return tree_data

    async def build_argument_tree(
        self,
        claims: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Build argument tree from claims.

        Args:
            claims: List of claim dicts

        Returns:
            {
                "argument_type": str,
                "tree_structure": dict,
                "is_valid": bool,
                "is_sound": bool,
                "premise_claim_ids": list,
                "conclusion_claim_ids": list,
                "circular_dependencies": list,
                "identified_fallacies": list,
                "confidence": float
            }
        """
        # Call LLM to analyze argument structure
        response = await self._call_llm_for_argument_structure(claims)

        # Extract claim IDs for premises and conclusions
        if "tree_structure" in response:
            premise_ids, conclusion_ids = self._extract_claim_ids_from_tree(
                response["tree_structure"],
                claims
            )
            response["premise_claim_ids"] = premise_ids
            response["conclusion_claim_ids"] = conclusion_ids

        # Generate visualization data
        if response.get("has_argument", True):
            response["visualization_data"] = self._generate_visualization_data(response, claims)

        return response

    async def _call_llm_for_argument_structure(
        self,
        claims: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Call Claude API to analyze argument structure.

        Args:
            claims: List of claim dicts

        Returns:
            Parsed JSON response with argument structure
        """
        # Format claims for LLM
        claims_text = self._format_claims_for_llm(claims)

        # Render prompt
        prompt_text = self.prompt_manager.render_prompt(
            "build_argument_tree",
            {"claims": claims_text}
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
            return {"has_argument": False, "reason": "Failed to parse response"}
        except Exception as e:
            print(f"Error calling LLM: {e}")
            return {"has_argument": False, "reason": str(e)}

    def _format_claims_for_llm(self, claims: List[Dict[str, Any]]) -> str:
        """Format claims for LLM prompt."""
        lines = []
        for i, claim in enumerate(claims):
            claim_id = claim.get("id", f"claim_{i}")
            claim_text = claim.get("claim_text", "")
            claim_type = claim.get("claim_type", "unknown")

            lines.append(f"[{i}] ID: {claim_id}")
            lines.append(f"    Type: {claim_type}")
            lines.append(f"    Text: {claim_text}")
            lines.append("")

        return "\n".join(lines)

    def _extract_claim_ids_from_tree(
        self,
        tree_structure: Dict,
        claims: List[Dict]
    ) -> tuple:
        """
        Extract premise and conclusion claim IDs from tree structure.

        Args:
            tree_structure: Nested tree dict
            claims: Original claims list

        Returns:
            (premise_ids, conclusion_ids) tuple
        """
        premise_ids = []
        conclusion_ids = []

        def traverse(node, is_root=False):
            if isinstance(node, dict):
                # If this node has a claim_id, track it
                if "claim_id" in node:
                    claim_id = node["claim_id"]
                    if is_root or node.get("is_conclusion"):
                        conclusion_ids.append(claim_id)
                    else:
                        premise_ids.append(claim_id)

                # Traverse premises/children
                if "premises" in node:
                    for premise in node["premises"]:
                        traverse(premise, is_root=False)

        traverse(tree_structure, is_root=True)

        return (list(set(premise_ids)), list(set(conclusion_ids)))

    def _generate_visualization_data(
        self,
        tree_data: Dict,
        claims: List[Dict]
    ) -> Dict[str, Any]:
        """
        Generate visualization data for UI rendering.

        Args:
            tree_data: Argument tree data
            claims: Original claims

        Returns:
            {
                "nodes": [...],
                "edges": [...]
            }
        """
        nodes = []
        edges = []

        # Create claim ID to text mapping
        claim_map = {c.get("id"): c.get("claim_text", "") for c in claims}

        # Build nodes
        for claim_id in tree_data.get("premise_claim_ids", []):
            nodes.append({
                "id": claim_id,
                "label": claim_map.get(claim_id, "")[:50],  # Truncate for display
                "type": "premise",
                "color": "#3B82F6"  # Blue
            })

        for claim_id in tree_data.get("conclusion_claim_ids", []):
            nodes.append({
                "id": claim_id,
                "label": claim_map.get(claim_id, "")[:50],
                "type": "conclusion",
                "color": "#10B981"  # Green
            })

        # Build edges from tree structure
        if "tree_structure" in tree_data:
            def extract_edges(node):
                if isinstance(node, dict):
                    node_id = node.get("claim_id")
                    if node_id and "premises" in node:
                        for premise in node["premises"]:
                            if isinstance(premise, dict) and "claim_id" in premise:
                                edges.append({
                                    "from": premise["claim_id"],
                                    "to": node_id,
                                    "label": "supports"
                                })
                            extract_edges(premise)

            extract_edges(tree_data["tree_structure"])

        return {"nodes": nodes, "edges": edges}

    async def _save_argument_tree(
        self,
        conversation_id: str,
        node_id: str,
        root_claim_id: Optional[str],
        tree_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Save argument tree to database."""
        argument_tree = ArgumentTree(
            id=uuid.uuid4(),
            conversation_id=uuid.UUID(conversation_id),
            node_id=uuid.UUID(node_id),
            root_claim_id=uuid.UUID(root_claim_id) if root_claim_id else None,
            tree_structure=tree_data.get("tree_structure", {}),
            title=tree_data.get("title"),
            summary=tree_data.get("summary"),
            argument_type=tree_data.get("argument_type"),
            is_valid=tree_data.get("is_valid"),
            is_sound=tree_data.get("is_sound"),
            confidence=tree_data.get("confidence"),
            identified_fallacies=tree_data.get("identified_fallacies", []),
            circular_dependencies=[
                uuid.UUID(cid) for cid in tree_data.get("circular_dependencies", [])
            ],
            premise_claim_ids=[
                uuid.UUID(cid) for cid in tree_data.get("premise_claim_ids", [])
            ],
            conclusion_claim_ids=[
                uuid.UUID(cid) for cid in tree_data.get("conclusion_claim_ids", [])
            ],
            visualization_data=tree_data.get("visualization_data")
        )

        self.db.add(argument_tree)
        await self.db.commit()
        await self.db.refresh(argument_tree)

        return self._argument_tree_to_dict(argument_tree)

    def _argument_tree_to_dict(self, tree: ArgumentTree) -> Dict[str, Any]:
        """Convert ArgumentTree model to dict."""
        return {
            "id": str(tree.id),
            "conversation_id": str(tree.conversation_id),
            "node_id": str(tree.node_id),
            "root_claim_id": str(tree.root_claim_id) if tree.root_claim_id else None,
            "tree_structure": tree.tree_structure,
            "title": tree.title,
            "summary": tree.summary,
            "argument_type": tree.argument_type,
            "is_valid": tree.is_valid,
            "is_sound": tree.is_sound,
            "confidence": tree.confidence,
            "identified_fallacies": tree.identified_fallacies,
            "circular_dependencies": [str(cid) for cid in (tree.circular_dependencies or [])],
            "premise_claim_ids": [str(cid) for cid in (tree.premise_claim_ids or [])],
            "conclusion_claim_ids": [str(cid) for cid in (tree.conclusion_claim_ids or [])],
            "visualization_data": tree.visualization_data,
            "created_at": tree.created_at.isoformat() if tree.created_at else None
        }

    async def _get_node_claims(self, node_id: uuid.UUID) -> List[Dict[str, Any]]:
        """Get all claims for a node."""
        query = select(Claim).where(Claim.node_id == node_id)
        result = await self.db.execute(query)
        claims = result.scalars().all()

        return [self._claim_to_dict(c) for c in claims]

    def _claim_to_dict(self, claim: Claim) -> Dict[str, Any]:
        """Convert Claim to dict."""
        return {
            "id": str(claim.id),
            "claim_text": claim.claim_text,
            "claim_type": claim.claim_type,
            "strength": claim.strength,
            "confidence": claim.confidence,
            "verification_status": claim.verification_status
        }

    async def _get_node(self, node_id: uuid.UUID) -> Optional[Node]:
        """Get node by ID."""
        query = select(Node).where(Node.id == node_id)
        result = await self.db.execute(query)
        return result.scalar_one_or_none()

    async def _get_node_argument_tree(self, node_id: uuid.UUID) -> Optional[ArgumentTree]:
        """Get existing argument tree for node."""
        query = select(ArgumentTree).where(ArgumentTree.node_id == node_id)
        result = await self.db.execute(query)
        return result.scalar_one_or_none()
