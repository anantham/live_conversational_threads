"""P1 integration tests: the two-phase RawTurn import — Phase 2
(extract_graph_for_conversation), against real Postgres (skipped unless
DATABASE_URL set).

Phase 1 (persist_turns / POST /api/import/turns) persists raw Utterance rows
with provenance. Phase 2 (extract_graph_for_conversation / /turns/extract) feeds
those persisted turns to the extractor, builds the graph, and calls
persist_graph(utterances=None) — which rewrites Nodes/Relationships while LEAVING
the Utterance rows untouched. That "Eternal Reprocessability" contract (re-run
extraction without re-sending turns) is the property under test.

The extractor (TranscriptProcessor) and the LLM-config loaders are lazy-imported
inside extract_graph_for_conversation, so they're monkeypatched here with a
deterministic fake — no LLM call. The fake emits one level-1 node per turn
(level 1 → the idea-tier consolidation never triggers, so no consolidation LLM
call either) linked to the real persisted utterance id.
"""

import asyncio
import uuid

import pytest

from .pg_helpers import REQUIRES_DB, cleanup_conversations, pg_session, unique_owner

pytestmark = REQUIRES_DB


# ---------------------------------------------------------------------------
# Deterministic fake extractor
# ---------------------------------------------------------------------------

class _FakeProcessor:
    """Stand-in for TranscriptProcessor: records the utterance_ids it's fed and,
    on flush, emits one level-1 node per turn linked to that utterance id."""

    def __init__(self, *args, **kwargs):
        self._utt_ids = []
        self.existing_json = []
        self.chunk_utterance_map = {}

    async def handle_final_text(self, text, speaker_segments=None, utterance_id=None):
        self._utt_ids.append(utterance_id)

    async def flush(self):
        self.existing_json = [
            {
                "id": str(uuid.uuid4()),
                "node_name": f"Node {i}",
                "summary": f"summary {i}",
                "semantic_level": 1,           # level 1 → no idea-tier consolidation
                "utterance_ids": [uid],         # link to the real persisted turn
            }
            for i, uid in enumerate(self._utt_ids)
        ]


def _install_fakes(monkeypatch):
    import lct_python_backend.services.transcript.transcript_processing as tp
    import lct_python_backend.services.llm_config as llm

    monkeypatch.setattr(tp, "TranscriptProcessor", _FakeProcessor)

    async def _cfg(*_a, **_k):
        return {}

    async def _providers(*_a, **_k):
        return {"providers": []}

    monkeypatch.setattr(llm, "load_llm_config", _cfg)
    monkeypatch.setattr(llm, "load_llm_providers", _providers)


def _spy_persist_graph(monkeypatch):
    """Wrap the real persist_graph to record the `utterances` kwarg of every call,
    then delegate to the real function. Returns the list of recorded values.

    This pins the actual re-runnability CONTRACT (extract must call
    persist_graph with utterances=None). Comparing utterance-id SETS alone is
    insufficient: a regression to persist_graph(utterances=<the loaded list>)
    would delete the rows then re-insert them with the SAME ids (the dicts carry
    the existing ids via _normalize_utterances), so the id set would be unchanged
    and the test would falsely pass despite the rows being destroyed/recreated.
    """
    import lct_python_backend.services.graph_persistence as gp

    original = gp.persist_graph
    calls = []

    async def _spy(**kwargs):
        calls.append(kwargs.get("utterances", "MISSING"))
        return await original(**kwargs)

    monkeypatch.setattr(gp, "persist_graph", _spy)
    return calls


def _payload(group_id, owner, n_turns):
    from lct_python_backend.raw_turn_contract import RawTurnsPayloadV1

    return RawTurnsPayloadV1(
        group_id=group_id,
        conversation_name="ITEST extract phase2",
        source_type="google_meet",
        owner_id=owner,
        privacy={"redaction_applied": True},
        turns=[
            {"seq": i, "source_identifier": f"itest-ex:{i}", "speaker_id": "S0", "text": f"turn {i}"}
            for i in range(n_turns)
        ],
    )


async def _utterance_ids(session, conv_uuid):
    from sqlalchemy import select
    from lct_python_backend.models import Utterance

    rows = (await session.execute(
        select(Utterance).where(Utterance.conversation_id == conv_uuid)
    )).scalars().all()
    return {str(u.id) for u in rows}


async def _node_rows(session, conv_uuid):
    from sqlalchemy import select
    from lct_python_backend.models import Node

    return (await session.execute(
        select(Node).where(Node.conversation_id == conv_uuid)
    )).scalars().all()


# ---------------------------------------------------------------------------
# T6 — Phase 2 extract
# ---------------------------------------------------------------------------

def test_extract_builds_graph_and_preserves_utterances(monkeypatch):
    """Phase 2 writes Nodes from the persisted turns AND leaves the Utterance
    rows untouched (same ids before and after) — the re-runnable contract."""
    _install_fakes(monkeypatch)
    persist_calls = _spy_persist_graph(monkeypatch)
    conv_id_holder = {}
    owner = unique_owner()
    group_id = f"ITEST-EX-{uuid.uuid4().hex[:10]}"

    async def scenario():
        from lct_python_backend.services.graph_persistence import persist_turns
        from lct_python_backend.services.import_orchestrator import extract_graph_for_conversation

        async with pg_session() as session:
            try:
                # Phase 1: persist 3 turns.
                res = await persist_turns(db=session, payload=_payload(group_id, owner, 3))
                conv_id = res["conversation_id"]
                conv_id_holder["id"] = conv_id
                cuid = uuid.UUID(conv_id)
                utt_ids_before = await _utterance_ids(session, cuid)

                # Phase 2: extract the graph.
                await extract_graph_for_conversation(session, conversation_id=conv_id, owner_id=owner)

                nodes = await _node_rows(session, cuid)
                utt_ids_after = await _utterance_ids(session, cuid)
                linked = set()
                for n in nodes:
                    linked.update(str(u) for u in (n.utterance_ids or []))
                return utt_ids_before, utt_ids_after, len(nodes), linked
            finally:
                if "id" in conv_id_holder:
                    await cleanup_conversations(session, [conv_id_holder["id"]])

    before, after, n_nodes, linked = asyncio.run(scenario())
    assert len(before) == 3
    assert n_nodes == 3                 # one node per turn
    assert after == before              # utterances UNTOUCHED by extract
    assert linked == before             # every node linked to a real persisted turn
    # CONTRACT: extract must materialize the graph WITHOUT deleting utterances —
    # i.e. persist_graph(utterances=None). (id-set equality alone can't catch a
    # delete+reinsert-with-same-id regression; this can.)
    assert persist_calls == [None]


def test_extract_is_rerunnable_without_touching_utterances(monkeypatch):
    """Running extract a SECOND time rewrites the graph (new node ids) but the
    Utterance rows are still the same — re-extract never re-sends/duplicates
    turns."""
    _install_fakes(monkeypatch)
    persist_calls = _spy_persist_graph(monkeypatch)
    conv_id_holder = {}
    owner = unique_owner()
    group_id = f"ITEST-EX-{uuid.uuid4().hex[:10]}"

    async def scenario():
        from lct_python_backend.services.graph_persistence import persist_turns
        from lct_python_backend.services.import_orchestrator import extract_graph_for_conversation

        async with pg_session() as session:
            try:
                res = await persist_turns(db=session, payload=_payload(group_id, owner, 2))
                conv_id = res["conversation_id"]
                conv_id_holder["id"] = conv_id
                cuid = uuid.UUID(conv_id)
                utt_before = await _utterance_ids(session, cuid)

                await extract_graph_for_conversation(session, conversation_id=conv_id, owner_id=owner)
                nodes1 = {str(n.id) for n in await _node_rows(session, cuid)}
                utt_mid = await _utterance_ids(session, cuid)

                await extract_graph_for_conversation(session, conversation_id=conv_id, owner_id=owner)
                nodes2 = {str(n.id) for n in await _node_rows(session, cuid)}
                utt_after = await _utterance_ids(session, cuid)
                return utt_before, utt_mid, utt_after, nodes1, nodes2
            finally:
                if "id" in conv_id_holder:
                    await cleanup_conversations(session, [conv_id_holder["id"]])

    utt_before, utt_mid, utt_after, nodes1, nodes2 = asyncio.run(scenario())
    assert len(utt_before) == 2
    assert utt_before == utt_mid == utt_after   # utterances stable across re-extracts
    assert len(nodes1) == 2 and len(nodes2) == 2
    assert nodes1.isdisjoint(nodes2)            # graph fully re-materialized (fresh node ids)
    # Both extract passes must leave utterances alone (utterances=None each time).
    assert persist_calls == [None, None]


def test_extract_rejects_unknown_conversation(monkeypatch):
    """Extract with a conversation_id that was never persisted raises ValueError
    (nothing to extract) rather than silently creating an empty graph."""
    _install_fakes(monkeypatch)
    owner = unique_owner()
    missing_id = str(uuid.uuid4())

    async def scenario():
        from lct_python_backend.services.import_orchestrator import extract_graph_for_conversation

        async with pg_session() as session:
            with pytest.raises(ValueError):
                await extract_graph_for_conversation(session, conversation_id=missing_id, owner_id=owner)

    asyncio.run(scenario())
