"""P1.5 integration tests: import-style graph persistence links leaf nodes to
their utterances so build_coverage_summary is REAL (non-null), against Postgres.

Reproduces the import situation: persist_graph is called with utterances that
carry a `chunk_id` (the import stitch) + a stable `id`, and NO explicit
`utterance_chunk_map` (only the live processor passes one). The fix derives the
chunk→utterance map from the utterances themselves, so leaf nodes get
utterance_ids and coverage is auditable.

Beyond the happy path, these tests pin the derived-map edge semantics codex
flagged (PR #63 review): a caller-supplied map wins over the derived one,
utterances missing an id or chunk_id stay unlinked (their turn is honestly
uncovered, no crash), duplicate ids are de-duped, and a node whose chunk has no
utterances gets an empty link set rather than erroring.

Skipped unless DATABASE_URL is set; each test creates + cascade-cleans its own
conversation.
"""

import asyncio
import os
import uuid

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

DATABASE_URL = os.getenv("DATABASE_URL")

pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set")


def _async_url(url: str) -> str:
    if url.startswith("postgresql+asyncpg://"):
        return url
    return url.replace("postgresql://", "postgresql+asyncpg://", 1)


async def _engine_session():
    engine = create_async_engine(_async_url(DATABASE_URL), connect_args={"ssl": False})
    return engine, AsyncSession(engine, expire_on_commit=False)


def _utt(seq, chunk=None, *, with_id=True):
    """One canonical utterance dict, as the import stitch would emit it.

    `chunk=None` omits chunk_id; `with_id=False` omits the stable id — the two
    ways an utterance can fail to be linkable by the derived map.
    """
    row = {
        "text": f"utterance number {seq}",
        "speaker_id": f"S{seq % 2}",
        "sequence_number": seq,
    }
    if with_id:
        row["id"] = str(uuid.uuid4())
    if chunk is not None:
        row["chunk_id"] = chunk
    return row


def _node(name, chunk):
    """A leaf node with NO authored utterance_ids (the LLM doesn't emit them)."""
    return {"id": str(uuid.uuid4()), "node_name": name, "summary": name.lower(), "chunk_id": chunk}


async def _persist_and_read(conv_id, existing_json, utterances, utterance_chunk_map=None):
    """ensure_conversation_row + persist_graph, then read coverage back.

    Returns (node_links, summary) where node_links maps node_name → list of
    persisted utterance_id strings. The session is closed before the caller
    asserts, so we return plain data (not ORM rows).
    """
    from lct_python_backend.models import Conversation
    from lct_python_backend.services.conversation_reader import (
        build_coverage_summary,
        build_graph_data_from_nodes,
        fetch_conversation_bundle,
    )
    from lct_python_backend.services.graph_persistence import (
        ensure_conversation_row,
        persist_graph,
    )

    engine, session = await _engine_session()
    try:
        await ensure_conversation_row(
            db=session, conversation_id=conv_id, conversation_name="P1.5 edge test",
            source_type="text", owner_id="usr_aditya",
        )
        await persist_graph(
            db=session, conversation_id=conv_id, existing_json=existing_json,
            utterances=utterances, utterance_chunk_map=utterance_chunk_map,
            conversation_name="P1.5 edge test", source_type="text", owner_id="usr_aditya",
        )
        _, nodes, rels, utts = await fetch_conversation_bundle(session, uuid.UUID(conv_id))
        graph_data = build_graph_data_from_nodes(nodes, rels, utts)
        summary = build_coverage_summary(graph_data, utts)
        node_links = {n.node_name: [str(u) for u in (n.utterance_ids or [])] for n in nodes}
        return node_links, summary
    finally:
        await session.execute(delete(Conversation).where(Conversation.id == uuid.UUID(conv_id)))
        await session.commit()
        await session.close()
        await engine.dispose()


def test_import_style_persist_makes_coverage_real():
    """Happy path: import passes utterances (id + chunk_id) but NO map; the
    derived map links each leaf node to its 2 utterances → coverage 100%."""
    conv_id = str(uuid.uuid4())
    chunk_a, chunk_b = str(uuid.uuid4()), str(uuid.uuid4())
    utterances = [_utt(1, chunk_a), _utt(2, chunk_a), _utt(3, chunk_b), _utt(4, chunk_b)]
    existing_json = [_node("Node A", chunk_a), _node("Node B", chunk_b)]

    node_links, summary = asyncio.run(_persist_and_read(conv_id, existing_json, utterances))

    assert all(len(ids) == 2 for ids in node_links.values()), node_links
    assert summary == {"total_turns": 4, "covered_turns": 4, "pct": 100.0, "auditable": True}


def test_explicit_map_wins_over_derived():
    """A caller-supplied utterance_chunk_map (the live processor path) must NOT
    be clobbered by the derived map. setdefault only fills chunks the caller
    didn't map — here the caller maps chunk_a to ONLY utt1, so utt2 stays
    unlinked even though the derived map would have included it."""
    conv_id = str(uuid.uuid4())
    chunk_a = str(uuid.uuid4())
    utt1, utt2 = _utt(1, chunk_a), _utt(2, chunk_a)
    explicit_map = {chunk_a: [utt1["id"]]}  # derived would add utt2 — must not win

    node_links, summary = asyncio.run(
        _persist_and_read(conv_id, [_node("Node A", chunk_a)], [utt1, utt2], explicit_map)
    )

    assert node_links["Node A"] == [utt1["id"]], node_links
    assert summary == {"total_turns": 2, "covered_turns": 1, "pct": 50.0, "auditable": True}


def test_missing_id_or_chunk_id_leaves_turn_uncovered():
    """Utterances missing an id (can't be referenced) or a chunk_id (can't be
    bucketed) are still persisted but stay unlinked — the derived map skips them
    and coverage honestly reports them as uncovered rather than crashing."""
    conv_id = str(uuid.uuid4())
    chunk_a = str(uuid.uuid4())
    utt1 = _utt(1, chunk_a)
    utt_no_id = _utt(2, chunk_a, with_id=False)   # has chunk_id, no id
    utt_no_chunk = _utt(3, chunk=None)            # has id, no chunk_id
    utterances = [utt1, utt_no_id, utt_no_chunk]

    node_links, summary = asyncio.run(
        _persist_and_read(conv_id, [_node("Node A", chunk_a)], utterances)
    )

    assert node_links["Node A"] == [utt1["id"]], node_links
    # all 3 utterances persist; only utt1 is linked → 1/3 covered.
    assert summary == {"total_turns": 3, "covered_turns": 1, "pct": 33.3, "auditable": True}


def test_duplicate_utterance_ids_are_deduped():
    """A map (or stitch) that lists the same utterance id twice must not produce
    duplicate links on the node — normalization de-dupes per chunk."""
    conv_id = str(uuid.uuid4())
    chunk_a = str(uuid.uuid4())
    utt1, utt2 = _utt(1, chunk_a), _utt(2, chunk_a)
    dup_map = {chunk_a: [utt1["id"], utt1["id"], utt2["id"]]}  # utt1 listed twice

    node_links, summary = asyncio.run(
        _persist_and_read(conv_id, [_node("Node A", chunk_a)], [utt1, utt2], dup_map)
    )

    assert sorted(node_links["Node A"]) == sorted([utt1["id"], utt2["id"]]), node_links
    assert len(node_links["Node A"]) == 2  # not 3
    assert summary == {"total_turns": 2, "covered_turns": 2, "pct": 100.0, "auditable": True}


def test_node_with_unmatched_chunk_has_empty_links():
    """A leaf node whose chunk has no utterances gets an empty link set (not an
    error) and contributes nothing to coverage; sibling nodes are unaffected."""
    conv_id = str(uuid.uuid4())
    chunk_a, chunk_orphan = str(uuid.uuid4()), str(uuid.uuid4())
    utterances = [_utt(1, chunk_a), _utt(2, chunk_a)]  # nothing in chunk_orphan
    existing_json = [_node("Node A", chunk_a), _node("Orphan", chunk_orphan)]

    node_links, summary = asyncio.run(_persist_and_read(conv_id, existing_json, utterances))

    assert len(node_links["Node A"]) == 2, node_links
    assert node_links["Orphan"] == [], node_links
    assert summary == {"total_turns": 2, "covered_turns": 2, "pct": 100.0, "auditable": True}


def test_empty_text_utterance_not_linked_or_counted():
    """An utterance with id + chunk_id but EMPTY text is dropped by
    _normalize_utterances (never persisted). The derived map must skip it too, so
    the node never inherits a phantom id and coverage can't over-report
    (covered > total / pct > 100). codex PR #63 finding 1 (derived-map side)."""
    conv_id = str(uuid.uuid4())
    chunk_a = str(uuid.uuid4())
    utt1 = _utt(1, chunk_a)
    utt_empty = {
        "id": str(uuid.uuid4()), "text": "", "speaker_id": "S0",
        "sequence_number": 2, "chunk_id": chunk_a,
    }

    node_links, summary = asyncio.run(
        _persist_and_read(conv_id, [_node("Node A", chunk_a)], [utt1, utt_empty])
    )

    # only utt1 persists; the empty-text row is neither persisted nor linked.
    assert node_links["Node A"] == [utt1["id"]], node_links
    assert summary == {"total_turns": 1, "covered_turns": 1, "pct": 100.0, "auditable": True}


def test_node_referencing_unpersisted_utterance_id_is_not_counted():
    """A node can carry an utterance id that was never persisted (here authored
    directly, as a hallucinated id would be). build_coverage_summary must
    INTERSECT with persisted ids — covered counts only the real one, so pct stays
    <= 100 instead of reporting 2/1 = 200. codex PR #63 finding 1 (coverage side)."""
    conv_id = str(uuid.uuid4())
    chunk_a = str(uuid.uuid4())
    utt1 = _utt(1, chunk_a)
    bogus_id = str(uuid.uuid4())
    # Author utterance_ids directly so the chunk fallback is skipped; reference
    # one real utterance + one id that is never persisted.
    node = _node("Node A", chunk_a)
    node["utterance_ids"] = [utt1["id"], bogus_id]

    node_links, summary = asyncio.run(_persist_and_read(conv_id, [node], [utt1]))

    # the node still stores both ids it authored...
    assert sorted(node_links["Node A"]) == sorted([utt1["id"], bogus_id]), node_links
    # ...but coverage counts ONLY the persisted one — no pct=200 over-report.
    assert summary == {"total_turns": 1, "covered_turns": 1, "pct": 100.0, "auditable": True}
