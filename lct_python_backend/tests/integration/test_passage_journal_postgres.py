"""Real transaction proof using only new synthetic rows in an opt-in local DB.

No schema creation/migration or existing-conversation changes. Cleanup targets
only this test's random conversation ID and owner. Never run against production.

Snapshot test intent: a source or applied-context change between capture and
commit must leave graph/cursor unchanged; recapturing permits a clean retry.
"""
import asyncio
import json
from datetime import datetime, timezone
import os
from urllib.parse import urlparse
import uuid

import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from lct_python_backend.models import Conversation, Utterance, Node, Relationship
from lct_python_backend.services.transcript.passage_journal import (
    JournalConflict, append_passage, load_journal, restore_records,
)
from lct_python_backend.services.transcript.passage_runtime import PassageJournalSession
from lct_python_backend.services.transcript.conversation_context import PassageContextPolicy
from lct_python_backend.services.transcript import transcript_processing as processing
from lct_python_backend.services.transcript.question_memory import fold_question_memory
from lct_python_backend.services.conversation_reader import build_graph_data_from_nodes
from lct_python_backend.services.transcript.passage_pump import PassagePump, read_owned_source_page
from lct_python_backend.services.transcript.attribution_revisions import validate_attribution_history


@pytest.mark.asyncio
async def test_real_rollback_restart_concurrent_retry_owner_and_source_revision(monkeypatch):
    url = os.getenv("PASSAGE_JOURNAL_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Explicit isolated local database URL required")
    parsed = urlparse(url)
    assert parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port == 55439
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    cid = uuid.uuid4()
    owner = f"synthetic-passage-journal-{cid}"
    ids = [uuid.uuid4(), uuid.uuid4()]
    chunk = str(uuid.uuid4())
    graph = {"nodes": [{"id": str(uuid.uuid4()), "chunk_id": chunk, "summary": "Original interpretation"}],
             "chunks": {chunk: "Synthetic first question."},
             "utterance_chunk_map": {chunk: [str(ids[0])]}}
    graph["nodes"][0]["question_updates"] = [{"question_id": "synthetic-question", "action": "open",
        "wording": "Synthetic first question.", "evidence_quote": "Synthetic first question.",
        "rationale": "An explicit synthetic question."}]
    args = dict(conversation_id=str(cid), owner_id=owner, expected_revision=0,
                source_ids=[str(ids[0])], patch=graph, policy_fingerprint="synthetic-v1")
    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid, owner_id=owner, conversation_name="Synthetic journal test",
                                conversation_type="transcript", source_type="synthetic",
                                started_at=datetime.now(timezone.utc)))
            await db.flush()
            for i, identity in enumerate(ids, 1):
                db.add(Utterance(id=identity, conversation_id=cid, sequence_number=i,
                                 speaker_id="SPEAKER_00",
                                 text="Synthetic first question." if i == 1 else "Synthetic later answer."))

        # An unjournaled legacy graph must not silently become a resume base.
        with pytest.raises(RuntimeError, match="rollback legacy fixture"):
            async with sessions.begin() as db:
                db.add(Node(id=uuid.uuid4(), conversation_id=cid, node_name="Legacy synthetic node", summary="Legacy", chunk_ids=[]))
                await db.flush()
                with pytest.raises(JournalConflict, match="no passage journal"):
                    await load_journal(db, conversation_id=str(cid), owner_id=owner)
                raise RuntimeError("rollback legacy fixture")

        # Ownership is enforced before reading any artifact/source.
        with pytest.raises(PermissionError):
            await read_owned_source_page(sessions, conversation_id=str(cid), owner_id="wrong-owner", after_sequence=0, limit=1)
        first_page = await read_owned_source_page(sessions, conversation_id=str(cid), owner_id=owner, after_sequence=0, limit=1)
        assert [row["id"] for row in first_page] == [str(ids[0])]
        second_page = await read_owned_source_page(sessions, conversation_id=str(cid), owner_id=owner, after_sequence=first_page[0]["sequence_number"], limit=1)
        assert [row["id"] for row in second_page] == [str(ids[1])]
        assert second_page[0]["speaker_id"] == "SPEAKER_00"
        async with sessions() as db:
            with pytest.raises(PermissionError):
                await load_journal(db, conversation_id=str(cid), owner_id="wrong-owner")
        async with sessions.begin() as db:
            with pytest.raises(JournalConflict, match="skips"):
                await append_passage(db, **{**args, "source_ids": [str(ids[1])]})

        # A flush is not a commit. Closing this failed transaction must leave
        # no checkpoint for a fresh process/session to observe.
        with pytest.raises(RuntimeError, match="after flush"):
            async with sessions.begin() as db:
                await append_passage(db, **args)
                raise RuntimeError("after flush")
        async with sessions() as db:
            assert await load_journal(db, conversation_id=str(cid), owner_id=owner) == []
            assert await db.get(Node, uuid.UUID(graph["nodes"][0]["id"])) is None

        async def commit():
            async with sessions.begin() as db:
                return await append_passage(db, **args)

        # Both writers start with revision 0. Row locking makes the second
        # recover the original result instead of appending another revision.
        first, retried = await asyncio.gather(commit(), commit())
        assert first == retried
        async with sessions() as db:
            records = await load_journal(db, conversation_id=str(cid), owner_id=owner)
            assert len(records) == 1
            restored = restore_records(records)
            assert restored["nodes"] == graph["nodes"]
            assert restored["committed_through"] == 1
            original_node = await db.get(Node, uuid.UUID(graph["nodes"][0]["id"]))
            assert original_node is not None, "Journal commit must include canonical graph rows"
            assert original_node.display_preferences["question_updates"] == graph["nodes"][0]["question_updates"]
            exported = build_graph_data_from_nodes([original_node], [])
            assert exported[0]["question_updates"] == graph["nodes"][0]["question_updates"]
        async with sessions.begin() as db:
            await db.execute(update(Node).where(Node.id == uuid.UUID(graph["nodes"][0]["id"])).values(
                summary="Human-corrected interpretation"))

        requests = []
        def generate(prompt, **kwargs):
            payload = json.loads(prompt)
            requests.append(payload)
            return ([{"node_name": "A later answer", "semantic_level": 1,
                      "question_updates": [{"question_id": "synthetic-question", "action": "answer",
                          "wording": "The later answer.", "evidence_quote": "Synthetic later answer.",
                          "rationale": "The explicit answer in this synthetic fixture."}],
                      "edge_relations": [{"related_node_id": graph["nodes"][0]["id"],
                                           "relation_type": "clarifies"}],
                      "source_excerpt": "Synthetic later answer."}], "local_test")
        monkeypatch.setattr(processing, "generate_lct_json", generate)
        async def notify(*args, **kwargs):
            async with sessions() as db:
                saved = await load_journal(db, conversation_id=str(cid), owner_id=owner)
                assert len(saved) == 2, "Notification must observe committed DB state"
            raise RuntimeError("Synthetic browser disconnect")

        def processor():
            journal = PassageJournalSession(session_factory=sessions, conversation_id=str(cid),
                                            owner_id=owner, policy_fingerprint="synthetic-v1")
            return processing.TranscriptProcessor(
                send_update=notify, batch_size=1, initial_batch_size=1,
                graph_first_update_max_wait_ms=0, graph_steady_update_max_wait_ms=0,
                llm_config={"mode": "local"}, providers=[],
                passage_context_policy=PassageContextPolicy(8000), passage_journal=journal,
            )
        live = processor()
        await live.handle_final_text("Synthetic first question.", utterance_id=str(ids[0]))
        assert requests == [], "Committed redelivery must not invoke inference"
        assert live.existing_json[0]["summary"] == "Human-corrected interpretation"
        async with sessions.begin() as db:
            await db.execute(update(Node).where(Node.id == uuid.UUID(graph["nodes"][0]["id"])).values(
                summary="Correction made during this session"))
        async def read_backlog(after, limit):
            return await read_owned_source_page(sessions, conversation_id=str(cid), owner_id=owner,
                                                after_sequence=after, limit=limit)
        pump = PassagePump(processor=live, read_page=read_backlog, committed_sequence=1, page_size=1)
        pump.notify()
        await pump.drain()
        assert len(requests) == 1
        assert requests[0]["earlier_passages"][0]["nodes"][0]["summary"] == "Correction made during this session"
        saved_ids = [node["id"] for node in live.existing_json]
        restarted = processor()
        await restarted.handle_final_text("Synthetic later answer.", utterance_id=str(ids[1]))
        assert [node["id"] for node in restarted.existing_json] == saved_ids
        assert len(requests) == 1
        assert restarted.accumulator == []
        question = fold_question_memory(restarted.existing_json, restarted.chunk_dict)["synthetic-question"]
        assert question["status"] == "answered"
        assert question["original"]["node_id"] == saved_ids[0]
        assert question["latest"]["node_id"] == saved_ids[1]
        assert restarted.existing_json[0]["summary"] == "Correction made during this session"
        async with sessions() as db:
            prior = await db.get(Node, uuid.UUID(saved_ids[0]))
            assert prior.summary == "Correction made during this session"
            checkpoints = await load_journal(db, conversation_id=str(cid), owner_id=owner)
            assert checkpoints[0]["patch"]["nodes"][0]["summary"] == "Original interpretation"
            edges = (await db.execute(select(Relationship).where(Relationship.conversation_id == cid))).scalars().all()
            assert any(str(e.from_node_id) == saved_ids[0] and str(e.to_node_id) == saved_ids[1]
                       and e.relationship_type == "clarifies" for e in edges)

        # A retry with a new generated UUID still returns the saved graph.
        async with sessions.begin() as db:
            retry = await append_passage(db, **{**args, "patch": {"nodes": []}})
            assert retry == first
        async with sessions.begin() as db:
            with pytest.raises(JournalConflict, match="policy"):
                await append_passage(db, **{**args, "policy_fingerprint": "changed"})

        # Human/transcript revisions must not silently reuse an old memory.
        async with sessions.begin() as db:
            await db.execute(update(Utterance).where(Utterance.id == ids[0]).values(text="Corrected source."))
        async with sessions() as db:
            with pytest.raises(JournalConflict, match="revised"):
                await load_journal(db, conversation_id=str(cid), owner_id=owner)

        # Exercise the real materializer against only this synthetic row. Its
        # receipt and immutable speaker segment commit together; the journal
        # still requires reconciliation rather than silently accepting it.
        from lct_python_backend import db_session
        from lct_python_backend.models import SpeakerSegment
        from lct_python_backend.services.speaker_materialization import persist_speaker_refinement
        monkeypatch.setattr(db_session, "get_async_session_context", sessions)
        async with sessions.begin() as db:
            await db.execute(update(Utterance).where(Utterance.id == ids[0]).values(text="Synthetic first question."))
        result = await persist_speaker_refinement(conversation_id=str(cid),
            source_utterance_id=str(ids[0]), segments=[{"speaker": "SPEAKER_01", "text": "Synthetic first question."}],
            provider="synthetic", model="synthetic", transport="synthetic")
        assert result["updated_utterances"] == 1
        async with sessions() as db:
            changed = await db.get(Utterance, ids[0])
            receipts = validate_attribution_history("SPEAKER_00", 0, changed.speaker_id,
                                                    changed.speaker_revision, changed.platform_metadata)
            assert len(receipts) == 1
            assert changed.text == "Synthetic first question."
            evidence = await db.get(SpeakerSegment, uuid.UUID(receipts[0]["evidence_segment_ids"][0]))
            assert evidence.conversation_id == cid and evidence.speaker_id == "SPEAKER_01"
            unchanged_records = await load_journal(db, conversation_id=str(cid), owner_id=owner)
            assert unchanged_records[0]["sources"][0]["speaker_id"] == "SPEAKER_00"
        audited = processor()
        await audited.handle_final_text("Synthetic later answer.", utterance_id=str(ids[1]))
        assert audited.existing_json[0]["attribution_review_required"] is True
        assert audited.existing_json[0]["summary"] == "Correction made during this session"
        assert audited.existing_json[0]["source_attributions"][0]["current_speaker_id"] == "SPEAKER_01"
        memory = fold_question_memory(audited.existing_json, audited.chunk_dict)["synthetic-question"]
        assert memory["original"]["attribution_review_required"] is True
        # A correction after a successful commit does not erase the receipt
        # for that commit. An old retry recovers its original identities.
        async with sessions.begin() as db:
            retry_after_refinement = await append_passage(db, **args)
            assert retry_after_refinement == first
        # An out-of-band label change is NOT legitimized merely by a nonzero
        # revision counter or the presence of some historical speaker evidence.
        async with sessions.begin() as db:
            await db.execute(update(Utterance).where(Utterance.id == ids[0]).values(speaker_id="UNSUPPORTED"))
        async with sessions() as db:
            with pytest.raises(JournalConflict, match="receipt"):
                await load_journal(db, conversation_id=str(cid), owner_id=owner)
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize("changed", ["source", "context"])
async def test_capture_commit_race_rejects_stale_inference(changed, monkeypatch):
    url = os.getenv("PASSAGE_JOURNAL_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Explicit isolated local database URL required")
    parsed = urlparse(url)
    assert parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port == 55439
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    cid, first_id, next_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    owner = f"synthetic-snapshot-race-{cid}"
    journal = PassageJournalSession(session_factory=sessions, conversation_id=str(cid),
                                    owner_id=owner, policy_fingerprint="synthetic-race-v1")

    async def captured_patch(identity, text):
        state = await journal.refresh_context()
        chunk = str(uuid.uuid4())
        return {"nodes": [{"id": str(uuid.uuid4()), "chunk_id": chunk, "summary": text}],
                "chunks": {chunk: text}, "utterance_chunk_map": {chunk: [str(identity)]},
                "inference_sources": await journal.capture_sources([str(identity)]),
                "inference_context_revision": state["interpretation_revision"]}

    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid, owner_id=owner, conversation_name="Synthetic capture race",
                                conversation_type="transcript", source_type="synthetic",
                                started_at=datetime.now(timezone.utc)))
            await db.flush()
            db.add_all([Utterance(id=first_id, conversation_id=cid, sequence_number=1,
                                  speaker_id="SPEAKER_00", text="First source."),
                        Utterance(id=next_id, conversation_id=cid, sequence_number=2,
                                  speaker_id="SPEAKER_00", text="Next source.")])
        initial = await captured_patch(first_id, "First source.")
        await journal.commit(initial)
        stale = await captured_patch(next_id, "Next source.")
        # This independent transaction represents an edit while the model is
        # processing its captured request. No provider request is necessary.
        if changed == "source":
            from lct_python_backend import db_session
            from lct_python_backend.services.speaker_materialization import persist_speaker_refinement
            monkeypatch.setattr(db_session, "get_async_session_context", sessions)
            result = await persist_speaker_refinement(conversation_id=str(cid),
                source_utterance_id=str(next_id), segments=[{"speaker": "SPEAKER_01", "text": "Next source."}],
                provider="synthetic", model="synthetic", transport="synthetic")
            assert result["updated_utterances"] == 1
        else:
            async with sessions.begin() as db:
                await db.execute(update(Node).where(Node.id == uuid.UUID(initial["nodes"][0]["id"])).values(
                    summary="Applied correction during inference."))
        with pytest.raises(JournalConflict, match="changed before commit"):
            await journal.commit(stale)
        async with sessions() as db:
            records = await load_journal(db, conversation_id=str(cid), owner_id=owner)
            assert len(records) == 1 and records[0]["committed_through"] == 1
            assert await db.get(Node, uuid.UUID(stale["nodes"][0]["id"])) is None
        fresh = await captured_patch(next_id, "Next source.")
        if changed == "source":
            assert fresh["inference_sources"][0]["speaker_id"] == "SPEAKER_01"
        else:
            assert fresh["inference_context_revision"] != stale["inference_context_revision"]
        saved = await journal.commit(fresh)
        assert saved["revision"] == 2 and saved["committed_through"] == 2
        assert len(saved["nodes"]) == 2
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()
