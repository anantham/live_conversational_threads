"""P1 integration tests: graph_query_service tier (zoom-level) filtering and the
cross-tier edge drop, against real Postgres (skipped unless DATABASE_URL set).

persist_graph writes each node with zoom_level_visible=[level] (level from the
authored semantic_level/level, clamped 1-5). load_nodes_for_conversation(zoom_level=N)
filters via array_position(zoom_level_visible, N), so a node is returned only at
its own tier. load_edges_for_nodes requires BOTH endpoints to be in the supplied
node set — so once nodes are tier-filtered, an edge that crosses tiers is
SILENTLY dropped (a known UX gap worth pinning). load_edges_for_conversation
returns every edge regardless.
"""

import asyncio
import uuid

from .pg_helpers import (
    REQUIRES_DB,
    cleanup_conversations,
    edge_out,
    node,
    pg_session,
    unique_owner,
)

pytestmark = REQUIRES_DB


async def _persist(session, conv_id, owner, existing_json):
    from lct_python_backend.services.graph_persistence import (
        ensure_conversation_row,
        persist_graph,
    )

    await ensure_conversation_row(
        db=session, conversation_id=conv_id, conversation_name="ITEST tier",
        source_type="text", owner_id=owner,
    )
    return await persist_graph(
        db=session, conversation_id=conv_id, existing_json=existing_json,
        conversation_name="ITEST tier", source_type="text", owner_id=owner,
    )


def _seed_two_tier_graph():
    """C1, C2 at level 1; I1 at level 2. Edges: C1->C2 (within tier 1),
    C1->I1 (crosses tier 1->2)."""
    c1, c2, i1 = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    existing = [
        node("C1", node_id=c1, semantic_level=1, edges_out=[
            edge_out(c2, relationship_type="temporal"),
            edge_out(i1, relationship_type="contextual"),
        ]),
        node("C2", node_id=c2, semantic_level=1),
        node("I1", node_id=i1, semantic_level=2),
    ]
    return existing, (c1, c2, i1)


def test_zoom_level_filters_nodes_to_their_tier():
    conv_id, owner = str(uuid.uuid4()), unique_owner()
    existing, (c1, c2, i1) = _seed_two_tier_graph()

    async def scenario():
        from lct_python_backend.services.graph_query_service import load_nodes_for_conversation

        async with pg_session() as session:
            try:
                await _persist(session, conv_id, owner, existing)
                cuid = uuid.UUID(conv_id)
                lvl1 = await load_nodes_for_conversation(session, cuid, zoom_level=1)
                lvl2 = await load_nodes_for_conversation(session, cuid, zoom_level=2)
                all_nodes = await load_nodes_for_conversation(session, cuid, zoom_level=None)
                return (
                    {str(n.id) for n in lvl1},
                    {str(n.id) for n in lvl2},
                    {str(n.id) for n in all_nodes},
                )
            finally:
                await cleanup_conversations(session, [conv_id])

    lvl1, lvl2, all_ids = asyncio.run(scenario())
    assert lvl1 == {c1, c2}        # only the two chunk-tier nodes
    assert lvl2 == {i1}            # only the idea-tier node
    assert all_ids == {c1, c2, i1}  # no filter → everything


def test_cross_tier_edge_silently_dropped_when_nodes_tier_filtered():
    """The known gap: load_edges_for_nodes needs BOTH endpoints in the node set.
    With the tier-1 node set, the within-tier edge (C1->C2) is returned but the
    cross-tier edge (C1->I1) is silently dropped — I1 isn't in the set."""
    conv_id, owner = str(uuid.uuid4()), unique_owner()
    existing, (c1, c2, i1) = _seed_two_tier_graph()

    async def scenario():
        from lct_python_backend.services.graph_query_service import (
            load_edges_for_conversation,
            load_edges_for_nodes,
            load_nodes_for_conversation,
        )

        async with pg_session() as session:
            try:
                await _persist(session, conv_id, owner, existing)
                cuid = uuid.UUID(conv_id)

                lvl1_nodes = await load_nodes_for_conversation(session, cuid, zoom_level=1)
                lvl1_ids = [n.id for n in lvl1_nodes]
                tier_edges = await load_edges_for_nodes(session, cuid, lvl1_ids)
                all_edges = await load_edges_for_conversation(session, cuid)
                return (
                    {(str(e.from_node_id), str(e.to_node_id)) for e in tier_edges},
                    {(str(e.from_node_id), str(e.to_node_id)) for e in all_edges},
                )
            finally:
                await cleanup_conversations(session, [conv_id])

    tier_edges, all_edges = asyncio.run(scenario())
    # Within-tier edge survives; cross-tier edge dropped from the tier view.
    assert tier_edges == {(c1, c2)}
    # ...but it DOES exist in the conversation — the drop is a view artifact.
    assert all_edges == {(c1, c2), (c1, i1)}


def test_load_edges_for_nodes_empty_set_returns_empty():
    """Guard: an empty node-id list short-circuits to [] (no all-rows leak)."""
    conv_id, owner = str(uuid.uuid4()), unique_owner()
    existing, _ = _seed_two_tier_graph()

    async def scenario():
        from lct_python_backend.services.graph_query_service import load_edges_for_nodes

        async with pg_session() as session:
            try:
                await _persist(session, conv_id, owner, existing)
                edges = await load_edges_for_nodes(session, uuid.UUID(conv_id), [])
                return edges
            finally:
                await cleanup_conversations(session, [conv_id])

    assert asyncio.run(scenario()) == []
