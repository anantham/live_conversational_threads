"""P1 integration tests: relationship round-trip fidelity through persist_graph
(real Postgres; skipped unless DATABASE_URL is set).

persist_graph has two relationship paths:
- FAITHFUL: if any node carries `edges_out`, each Relationship row is written
  verbatim — id, subtype, strength, confidence, is_bidirectional,
  supporting_utterance_ids all preserved. build_graph_data_from_nodes(...,
  include_edges_out=True) reads them back into the same edges_out shape, so a
  read → re-persist round-trip is LOSSLESS (relationship ids are stable).
- LEGACY: no edges_out, only singular successor/predecessor/contextual_relation
  fields → relationships are synthesized as temporal/contextual with freshly
  minted ids and fixed strength. Lossy for reconstruction.

These pin both paths and the `include_edges_out=False` default footgun (the
reader drops relationships unless the caller opts in).
"""

import asyncio
import uuid

from .pg_helpers import (
    REQUIRES_DB,
    cleanup_conversations,
    node,
    pg_session,
    read_graph,
    unique_owner,
)

pytestmark = REQUIRES_DB


async def _persist(session, conv_id, owner, existing_json, **kwargs):
    from lct_python_backend.services.graph_persistence import (
        ensure_conversation_row,
        persist_graph,
    )

    await ensure_conversation_row(
        db=session, conversation_id=conv_id, conversation_name="ITEST edge fidelity",
        source_type="text", owner_id=owner,
    )
    return await persist_graph(
        db=session, conversation_id=conv_id, existing_json=existing_json,
        conversation_name="ITEST edge fidelity", source_type="text", owner_id=owner,
        **kwargs,
    )


# ---------------------------------------------------------------------------
# T4 — faithful edges_out round-trip
# ---------------------------------------------------------------------------

def test_edges_out_round_trips_all_fields():
    """A relationship authored via edges_out with every field set persists
    verbatim and reads back (include_edges_out=True) with no field loss."""
    conv_id, owner = str(uuid.uuid4()), unique_owner()
    a_id, b_id = str(uuid.uuid4()), str(uuid.uuid4())
    rel_id = str(uuid.uuid4())
    sup = [str(uuid.uuid4()), str(uuid.uuid4())]
    edge = {
        "id": rel_id,
        "to": b_id,
        "relationship_type": "contextual",
        "relationship_subtype": "supports",
        "explanation": "A supports B",
        "strength": 0.73,
        "confidence": 0.91,
        "is_bidirectional": True,
        "supporting_utterance_ids": sup,
    }

    async def scenario():
        from lct_python_backend.services.conversation_reader import build_graph_data_from_nodes

        async with pg_session() as session:
            try:
                await _persist(session, conv_id, owner, [
                    node("A", node_id=a_id, edges_out=[edge]),
                    node("B", node_id=b_id),
                ])
                nodes, rels, utts = await read_graph(session, conv_id)

                # (1) the persisted Relationship row carries every field.
                assert len(rels) == 1
                r = rels[0]
                row_fields = {
                    "id": str(r.id),
                    "to": str(r.to_node_id),
                    "type": r.relationship_type,
                    "subtype": r.relationship_subtype,
                    "explanation": r.explanation,
                    "strength": r.strength,
                    "confidence": r.confidence,
                    "bidir": bool(r.is_bidirectional),
                    "sup": {str(u) for u in (r.supporting_utterance_ids or [])},
                }

                # (2) the reader round-trips them into edges_out.
                graph = build_graph_data_from_nodes(nodes, rels, utts, include_edges_out=True)
                a_node = next(n for n in graph if n["id"] == a_id)
                eo = a_node["edges_out"]
                return row_fields, eo
            finally:
                await cleanup_conversations(session, [conv_id])

    row, eo = asyncio.run(scenario())

    # Persisted row fidelity
    assert row["id"] == rel_id
    assert row["to"] == b_id
    assert row["type"] == "contextual"
    assert row["subtype"] == "supports"
    assert row["explanation"] == "A supports B"
    assert row["strength"] == 0.73
    assert row["confidence"] == 0.91
    assert row["bidir"] is True
    assert row["sup"] == set(sup)

    # Reader round-trip fidelity
    assert len(eo) == 1
    e = eo[0]
    assert e["id"] == rel_id
    assert e["to"] == b_id
    assert e["relationship_type"] == "contextual"
    assert e["relationship_subtype"] == "supports"
    assert e["explanation"] == "A supports B"
    assert e["strength"] == 0.73
    assert e["confidence"] == 0.91
    assert e["is_bidirectional"] is True
    assert set(e["supporting_utterance_ids"]) == set(sup)


def test_faithful_repersist_preserves_relationship_id():
    """Read a faithful graph (include_edges_out=True) then RE-persist it: the
    relationship id survives unchanged. This is the lossless re-materialization
    that enrich/consolidate scripts rely on."""
    conv_id, owner = str(uuid.uuid4()), unique_owner()
    a_id, b_id = str(uuid.uuid4()), str(uuid.uuid4())
    rel_id = str(uuid.uuid4())

    async def scenario():
        from lct_python_backend.services.conversation_reader import build_graph_data_from_nodes

        async with pg_session() as session:
            try:
                await _persist(session, conv_id, owner, [
                    node("A", node_id=a_id, edges_out=[{
                        "id": rel_id, "to": b_id, "relationship_type": "contextual",
                        "strength": 0.8, "confidence": 0.9,
                    }]),
                    node("B", node_id=b_id),
                ])
                nodes, rels, utts = await read_graph(session, conv_id)
                graph = build_graph_data_from_nodes(nodes, rels, utts, include_edges_out=True)

                # Re-persist the read-back graph verbatim.
                await _persist(session, conv_id, owner, graph)
                _, rels2, _ = await read_graph(session, conv_id)
                return str(rels[0].id), [str(r.id) for r in rels2]
            finally:
                await cleanup_conversations(session, [conv_id])

    first_rel_id, second_rel_ids = asyncio.run(scenario())
    assert first_rel_id == rel_id
    assert second_rel_ids == [rel_id]  # id preserved across the round-trip


def test_reader_omits_edges_out_by_default_footgun():
    """FOOTGUN PIN: build_graph_data_from_nodes defaults include_edges_out=False,
    so the round-trip silently drops relationships unless the caller opts in. A
    re-persist of the default output would lose every edge."""
    conv_id, owner = str(uuid.uuid4()), unique_owner()
    a_id, b_id = str(uuid.uuid4()), str(uuid.uuid4())

    async def scenario():
        from lct_python_backend.services.conversation_reader import build_graph_data_from_nodes

        async with pg_session() as session:
            try:
                await _persist(session, conv_id, owner, [
                    node("A", node_id=a_id, edges_out=[{
                        "id": str(uuid.uuid4()), "to": b_id,
                        "relationship_type": "contextual", "strength": 0.8,
                    }]),
                    node("B", node_id=b_id),
                ])
                nodes, rels, utts = await read_graph(session, conv_id)
                default_graph = build_graph_data_from_nodes(nodes, rels, utts)  # no flag
                a_default = next(n for n in default_graph if n["id"] == a_id)
                return len(rels), ("edges_out" in a_default)
            finally:
                await cleanup_conversations(session, [conv_id])

    n_rels, has_edges_out = asyncio.run(scenario())
    assert n_rels == 1                 # the relationship IS persisted
    assert has_edges_out is False      # ...but the default reader omits it


def test_legacy_successor_path_synthesizes_temporal_edge():
    """LEGACY path: a node authored with only a `successor` (no edges_out)
    produces a synthesized temporal relationship with fixed strength 1.0 and a
    freshly minted id — documenting the lossy derivation."""
    conv_id, owner = str(uuid.uuid4()), unique_owner()
    a_id, b_id = str(uuid.uuid4()), str(uuid.uuid4())

    async def scenario():
        async with pg_session() as session:
            try:
                # successor references the other node BY NAME (legacy field).
                await _persist(session, conv_id, owner, [
                    node("A", node_id=a_id, successor="B"),
                    node("B", node_id=b_id),
                ])
                _, rels, _ = await read_graph(session, conv_id)
                return [(str(r.from_node_id), str(r.to_node_id), r.relationship_type, r.strength) for r in rels]
            finally:
                await cleanup_conversations(session, [conv_id])

    edges = asyncio.run(scenario())
    assert len(edges) == 1
    frm, to, rtype, strength = edges[0]
    assert (frm, to) == (a_id, b_id)
    assert rtype == "temporal"
    assert strength == 1.0
