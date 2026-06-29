"""P0 integration tests for persist_graph's destructive write semantics, against
a real Postgres (skipped unless DATABASE_URL is set).

persist_graph is the canonical graph materializer (ADR-030 §D3) and is
DESTRUCTIVE by design: on the normal path it DELETEs every Node/Relationship row
for the conversation, then re-INSERTs from existing_json. On the segment-and-
stitch RESUME path (protect_node_ids), the delete is scoped to *exclude* the
protected ids so a prior recording segment's graph is frozen.

These behaviors can only be verified against a real DB — they exercise the
delete-before-insert ordering and the ondelete=CASCADE FK on
relationships.from_node_id/to_node_id, neither of which a mock reproduces.

T1: delete-before-insert (incl. the empty-graph-wipes-existing footgun).
T2: resume path (protect_node_ids) — protected survive, unprotected delete,
    their relationships cascade away.

Each test creates + cascade-cleans its own conversation.
"""

import asyncio
import uuid

from .pg_helpers import (
    REQUIRES_DB,
    cleanup_conversations,
    edge_out,
    node,
    pg_session,
    read_graph,
    unique_owner,
)

pytestmark = REQUIRES_DB


async def _persist(session, conv_id, owner, existing_json, **kwargs):
    """ensure_conversation_row (idempotent) + persist_graph. Returns node count."""
    from lct_python_backend.services.graph_persistence import (
        ensure_conversation_row,
        persist_graph,
    )

    await ensure_conversation_row(
        db=session, conversation_id=conv_id, conversation_name="ITEST persist_graph",
        source_type="text", owner_id=owner,
    )
    return await persist_graph(
        db=session, conversation_id=conv_id, existing_json=existing_json,
        conversation_name="ITEST persist_graph", source_type="text", owner_id=owner,
        **kwargs,
    )


# ---------------------------------------------------------------------------
# T1 — delete-before-insert
# ---------------------------------------------------------------------------

def test_second_persist_replaces_nodes_and_relationships():
    """A second persist_graph with a DIFFERENT graph wipes the first graph's
    Node + Relationship rows entirely and replaces them. Proves the destructive
    delete-before-insert: no orphan rows from the prior materialization survive."""
    conv_id = str(uuid.uuid4())
    owner = unique_owner()

    async def scenario():
        async with pg_session() as session:
            try:
                # Segment 1: A -> B
                a_id, b_id = str(uuid.uuid4()), str(uuid.uuid4())
                seg1 = [
                    node("A", node_id=a_id, edges_out=[edge_out(b_id)]),
                    node("B", node_id=b_id),
                ]
                await _persist(session, conv_id, owner, seg1)
                nodes1, rels1, _ = await read_graph(session, conv_id)
                first_ids = {str(n.id) for n in nodes1}

                # Segment 2: C -> D (completely different graph)
                c_id, d_id = str(uuid.uuid4()), str(uuid.uuid4())
                seg2 = [
                    node("C", node_id=c_id, edges_out=[edge_out(d_id)]),
                    node("D", node_id=d_id),
                ]
                await _persist(session, conv_id, owner, seg2)
                nodes2, rels2, _ = await read_graph(session, conv_id)
                second_ids = {str(n.id) for n in nodes2}

                return first_ids, second_ids, len(rels1), len(rels2), \
                    {(str(r.from_node_id), str(r.to_node_id)) for r in rels2}, \
                    (a_id, b_id, c_id, d_id)
            finally:
                await cleanup_conversations(session, [conv_id])

    first_ids, second_ids, n_rels1, n_rels2, rel2_pairs, (a, b, c, d) = asyncio.run(scenario())

    assert first_ids == {a, b}
    assert second_ids == {c, d}
    # The first graph's nodes are GONE, not merged in.
    assert first_ids.isdisjoint(second_ids)
    assert n_rels1 == 1
    assert n_rels2 == 1
    # The only surviving relationship is the new one; A->B was deleted.
    assert rel2_pairs == {(c, d)}


def test_empty_graph_with_utterances_wipes_existing_nodes():
    """FOOTGUN PIN: the early-return guard (`if not existing_json and utterances
    is None: return 0`) only protects when utterances is None. Passing an empty
    existing_json WITH a (here empty) utterances list slips past the guard,
    proceeds to the delete, and WIPES the existing graph — returning 0 nodes.

    This documents a real data-loss path: an empty graph + a non-None utterances
    arg silently destroys a previously-materialized graph."""
    conv_id = str(uuid.uuid4())
    owner = unique_owner()

    async def scenario():
        async with pg_session() as session:
            try:
                a_id, b_id = str(uuid.uuid4()), str(uuid.uuid4())
                seg1 = [node("A", node_id=a_id, edges_out=[edge_out(b_id)]), node("B", node_id=b_id)]
                await _persist(session, conv_id, owner, seg1)
                before, _, _ = await read_graph(session, conv_id)

                # Empty graph + non-None utterances ([]) → slips past the guard,
                # deletes everything, inserts nothing.
                returned = await _persist(session, conv_id, owner, [], utterances=[])
                after, after_rels, _ = await read_graph(session, conv_id)
                return len(before), returned, len(after), len(after_rels)
            finally:
                await cleanup_conversations(session, [conv_id])

    n_before, returned, n_after, n_after_rels = asyncio.run(scenario())
    assert n_before == 2
    assert returned == 0
    assert n_after == 0      # graph wiped
    assert n_after_rels == 0


def test_empty_graph_with_none_utterances_is_noop():
    """COUNTERPART: the early-return guard DOES protect when utterances is None —
    an empty existing_json returns 0 early WITHOUT deleting the existing graph."""
    conv_id = str(uuid.uuid4())
    owner = unique_owner()

    async def scenario():
        async with pg_session() as session:
            try:
                a_id, b_id = str(uuid.uuid4()), str(uuid.uuid4())
                seg1 = [node("A", node_id=a_id, edges_out=[edge_out(b_id)]), node("B", node_id=b_id)]
                await _persist(session, conv_id, owner, seg1)

                returned = await _persist(session, conv_id, owner, [])  # utterances defaults to None
                after, after_rels, _ = await read_graph(session, conv_id)
                return returned, len(after), len(after_rels)
            finally:
                await cleanup_conversations(session, [conv_id])

    returned, n_after, n_after_rels = asyncio.run(scenario())
    assert returned == 0
    assert n_after == 2      # graph PRESERVED — guard fired
    assert n_after_rels == 1


def test_total_nodes_reflects_count_after_destructive_replace():
    """Conversation.total_nodes tracks the materialized node count — and tracks
    it DOWN after a destructive replace (3 nodes → 1), not just on first
    materialization. A broken impl that only ever grew total_nodes (or set it
    once) would fail the second assertion."""
    conv_id = str(uuid.uuid4())
    owner = unique_owner()

    async def scenario():
        from lct_python_backend.models import Conversation, Node
        from sqlalchemy import func, select

        async with pg_session() as session:
            try:
                cuid = uuid.UUID(conv_id)
                # First materialization: 3 nodes.
                await _persist(session, conv_id, owner, [node("A"), node("B"), node("C")])
                res = await session.execute(select(Conversation).where(Conversation.id == cuid))
                total_after_3 = res.scalar_one().total_nodes

                # Destructive replace with a single-node graph.
                await _persist(session, conv_id, owner, [node("Solo")])
                res = await session.execute(select(Conversation).where(Conversation.id == cuid))
                total_after_1 = res.scalar_one().total_nodes
                cnt = await session.execute(
                    select(func.count()).select_from(Node).where(Node.conversation_id == cuid)
                )
                actual_nodes = cnt.scalar_one()
                return total_after_3, total_after_1, actual_nodes
            finally:
                await cleanup_conversations(session, [conv_id])

    total_after_3, total_after_1, actual_nodes = asyncio.run(scenario())
    assert total_after_3 == 3
    assert actual_nodes == 1
    assert total_after_1 == 1  # tracked DOWN, not just up


# ---------------------------------------------------------------------------
# T2 — resume path (protect_node_ids)
# ---------------------------------------------------------------------------

def test_resume_protects_subset_culls_rest_and_appends_new_segment():
    """Resume path, proving all three behaviors in one test: only the nodes
    passed as protect_node_ids are frozen (A, B survive); a prior node NOT in the
    protected set is culled (STALE deleted); the new segment's nodes are appended
    (D). Strengthened from a protect-everything case — that variant would pass
    even if the resume-path delete were a no-op, since there'd be nothing to
    cull."""
    conv_id = str(uuid.uuid4())
    owner = unique_owner()

    async def scenario():
        async with pg_session() as session:
            try:
                # Segment 1: A, B (to be protected) + STALE (to be culled).
                a_id, b_id, stale_id = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
                await _persist(session, conv_id, owner, [
                    node("A", node_id=a_id),
                    node("B", node_id=b_id),
                    node("STALE", node_id=stale_id),
                ])
                nodes1, _, _ = await read_graph(session, conv_id)
                by_name = {n.node_name: n.id for n in nodes1}
                protect = [by_name["A"], by_name["B"]]  # STALE deliberately omitted

                # Segment 2: D, persisted with protect_node_ids.
                d_id = str(uuid.uuid4())
                await _persist(
                    session, conv_id, owner, [node("D", node_id=d_id)],
                    protect_node_ids=protect,
                )
                after, _, _ = await read_graph(session, conv_id)
                return {n.node_name for n in after}
            finally:
                await cleanup_conversations(session, [conv_id])

    names = asyncio.run(scenario())
    # A, B frozen (protected); STALE culled (unprotected); D appended.
    assert names == {"A", "B", "D"}


def test_resume_deletes_unprotected_and_cascades_their_relationships():
    """Resume path scopes the delete to nodes NOT in protect_node_ids. An
    unprotected node is deleted, and any relationship touching it drops via the
    ondelete=CASCADE FK — while a relationship between two protected nodes
    survives untouched (the resume path never deletes the Relationship table
    directly; it relies on the cascade)."""
    conv_id = str(uuid.uuid4())
    owner = unique_owner()

    async def scenario():
        async with pg_session() as session:
            try:
                # Segment 1: A -> B and A -> C. Protect {A, B}; C is unprotected.
                a_id, b_id, c_id = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
                seg1 = [
                    node("A", node_id=a_id, edges_out=[edge_out(b_id), edge_out(c_id)]),
                    node("B", node_id=b_id),
                    node("C", node_id=c_id),
                ]
                await _persist(session, conv_id, owner, seg1)
                nodes1, rels1, _ = await read_graph(session, conv_id)
                by_name = {n.node_name: n.id for n in nodes1}
                protect = [by_name["A"], by_name["B"]]  # C left unprotected

                # Segment 2: a new node D (no edges). Resume persist.
                d_id = str(uuid.uuid4())
                await _persist(
                    session, conv_id, owner, [node("D", node_id=d_id)],
                    protect_node_ids=protect,
                )
                nodes2, rels2, _ = await read_graph(session, conv_id)
                return (
                    len(rels1),
                    {n.node_name for n in nodes2},
                    {(str(r.from_node_id), str(r.to_node_id)) for r in rels2},
                    (a_id, b_id),
                )
            finally:
                await cleanup_conversations(session, [conv_id])

    n_rels1, names_after, rel_pairs_after, (a, b) = asyncio.run(scenario())
    assert n_rels1 == 2  # A->B and A->C initially
    # C deleted (unprotected); A, B frozen; D appended.
    assert names_after == {"A", "B", "D"}
    # A->C cascaded away with C; A->B (both protected) survives.
    assert rel_pairs_after == {(a, b)}
