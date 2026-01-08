"""
Base Clusterer Class

Abstract base class for all hierarchical theme clusterers.
Provides common functionality for caching, database access, and node creation.
"""

from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional
import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, delete

from lct_python_backend.models import Node, Utterance, Relationship


class BaseClusterer(ABC):
    """
    Abstract base class for hierarchical theme clustering.

    Each level (1-5) implements this to generate nodes for that level.
    Provides caching and database utilities.
    """

    def __init__(self, db: AsyncSession, model: str, level: int):
        """
        Initialize clusterer.

        Args:
            db: Database session
            model: OpenRouter model to use (e.g., "anthropic/claude-3.5-sonnet")
            level: Which level this clusterer generates (1-5)
        """
        self.db = db
        self.model = model
        self.level = level

    async def get_or_generate(
        self,
        conversation_id: str,
        parent_nodes: Optional[List[Node]] = None,
        utterances: Optional[List[Utterance]] = None,
        force_regenerate: bool = False
    ) -> List[Node]:
        """
        Get nodes for this level from cache, or generate if missing.

        Args:
            conversation_id: UUID of conversation
            parent_nodes: Parent level nodes (for clustering)
            utterances: Raw utterances (for L5 atomic generation)
            force_regenerate: If True, delete existing nodes and regenerate

        Returns:
            List of Node objects for this level
        """
        # If force regenerate, clean up existing nodes first
        if force_regenerate:
            deleted_count = await self._delete_existing_nodes(conversation_id)
            if deleted_count > 0:
                print(f"[INFO] Deleted {deleted_count} existing level {self.level} nodes")
        else:
            # Check cache first
            existing_nodes = await self._load_from_db(conversation_id)
            if existing_nodes:
                print(f"[INFO] Level {self.level} nodes found in cache ({len(existing_nodes)} nodes)")
                return existing_nodes

        # Generate new nodes
        print(f"[INFO] Generating level {self.level} nodes...")
        new_nodes = await self.generate_level(conversation_id, parent_nodes, utterances)
        print(f"[INFO] Generated {len(new_nodes)} level {self.level} nodes")

        return new_nodes

    async def _delete_existing_nodes(self, conversation_id: str) -> int:
        """Delete existing nodes for this level. Returns count of deleted nodes."""
        # First delete relationships involving these nodes
        existing_nodes = await self._load_from_db(conversation_id)
        if not existing_nodes:
            return 0

        node_ids = [node.id for node in existing_nodes]

        # Delete relationships where these nodes are source or target
        await self.db.execute(
            delete(Relationship).where(
                and_(
                    Relationship.conversation_id == uuid.UUID(conversation_id),
                    (Relationship.from_node_id.in_(node_ids)) | (Relationship.to_node_id.in_(node_ids))
                )
            )
        )

        # Delete the nodes
        result = await self.db.execute(
            delete(Node).where(
                and_(
                    Node.conversation_id == uuid.UUID(conversation_id),
                    Node.level == self.level
                )
            )
        )

        await self.db.commit()
        return len(existing_nodes)

    @abstractmethod
    async def generate_level(
        self,
        conversation_id: str,
        parent_nodes: Optional[List[Node]] = None,
        utterances: Optional[List[Utterance]] = None
    ) -> List[Node]:
        """
        Generate nodes for this level.

        Must be implemented by each level's clusterer.

        Args:
            conversation_id: UUID of conversation
            parent_nodes: Nodes from parent level to cluster
            utterances: Raw utterances (for L5 only)

        Returns:
            List of newly created Node objects
        """
        pass

    async def _load_from_db(self, conversation_id: str) -> List[Node]:
        """Load existing nodes for this level from database."""
        result = await self.db.execute(
            select(Node).where(
                and_(
                    Node.conversation_id == uuid.UUID(conversation_id),
                    Node.level == self.level
                )
            ).order_by(Node.created_at)
        )
        return list(result.scalars().all())

    def _create_node(
        self,
        conversation_id: str,
        node_name: str,
        summary: str,
        node_type: str,
        utterance_ids: List[uuid.UUID],
        parent_node_id: Optional[uuid.UUID] = None,
        timestamp_start: Optional[float] = None,
        timestamp_end: Optional[float] = None
    ) -> Node:
        """
        Create a Node object (not yet saved to DB).

        Args:
            conversation_id: UUID of conversation
            node_name: Name/label for the node
            summary: Description of this theme
            node_type: Type of node (discussion, claim, etc.)
            utterance_ids: Utterances that belong to this node
            parent_node_id: Parent node in hierarchy (if any)
            timestamp_start: Start time in seconds
            timestamp_end: End time in seconds

        Returns:
            Node object ready to be added to session
        """
        duration = None
        if timestamp_start is not None and timestamp_end is not None:
            duration = timestamp_end - timestamp_start

        node = Node(
            id=uuid.uuid4(),
            conversation_id=uuid.UUID(conversation_id),
            node_name=node_name,
            summary=summary,
            node_type=node_type,
            level=self.level,
            parent_id=parent_node_id,
            chunk_ids=[],
            utterance_ids=utterance_ids,
            timestamp_start=timestamp_start,
            timestamp_end=timestamp_end,
            duration_seconds=duration,
            zoom_level_visible=[self.level],  # Visible at this level only
            confidence_score=0.85,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow()
        )

        return node

    async def _save_nodes(self, nodes: List[Node]) -> None:
        """Save nodes to database and update parent-child relationships."""
        # Add all nodes
        for node in nodes:
            self.db.add(node)

        await self.db.flush()  # Get IDs assigned

        # Update parent nodes' children_ids if parents exist
        if nodes and nodes[0].parent_id:
            # Group children by parent
            parent_to_children: Dict[uuid.UUID, List[uuid.UUID]] = {}
            for node in nodes:
                if node.parent_id:
                    if node.parent_id not in parent_to_children:
                        parent_to_children[node.parent_id] = []
                    parent_to_children[node.parent_id].append(node.id)

            # Update each parent's children_node_ids
            for parent_id, child_ids in parent_to_children.items():
                parent_result = await self.db.execute(
                    select(Node).where(Node.id == parent_id)
                )
                parent_node = parent_result.scalar_one_or_none()
                if parent_node:
                    parent_node.children_ids = child_ids

        await self.db.commit()
        print(f"[INFO] Saved {len(nodes)} nodes to database")

    async def _persist_relationships(
        self,
        conversation_id: str,
        nodes: List[Node],
        relationships_data: List[Dict[str, Any]]
    ) -> List[Relationship]:
        """
        Persist relationships returned by the LLM.
        Expects source_label/target_label that match node.node_name for the newly created nodes.
        """
        if not relationships_data:
            return []

        label_to_node = {node.node_name: node for node in nodes}
        created: List[Relationship] = []

        for rel in relationships_data:
            source_label = rel.get("source_label")
            target_label = rel.get("target_label")
            if not source_label or not target_label:
                continue
            if source_label not in label_to_node or target_label not in label_to_node:
                print(f"[WARNING] Relationship skipped - unknown labels: {source_label} -> {target_label}")
                continue

            relationship = Relationship(
                id=uuid.uuid4(),
                conversation_id=uuid.UUID(conversation_id),
                from_node_id=label_to_node[source_label].id,
                to_node_id=label_to_node[target_label].id,
                relationship_type=rel.get("relationship_type", "related"),
                relationship_subtype=rel.get("relationship_subtype"),
                explanation=rel.get("description", ""),
                strength=float(rel.get("strength", 1.0)),
                confidence=float(rel.get("confidence", 0.85)),
                supporting_utterance_ids=rel.get("supporting_utterance_ids"),
                is_bidirectional=bool(rel.get("is_bidirectional", False)),
            )
            self.db.add(relationship)
            created.append(relationship)

        if created:
            await self.db.commit()
            print(f"[INFO] Saved {len(created)} relationships for level {self.level}")

        return created
