"""Synthetic local DB proof: aggregate citations and overlapping memberships
survive append, export, and re-persist; source rows and existing moments survive.
Only random test-owned conversation rows are created/deleted. No model calls.
"""
import copy
import json
from datetime import datetime, timezone
import os
from urllib.parse import urlparse
import uuid

import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from lct_python_backend.models import Conversation, Node, Relationship, Utterance
from lct_python_backend.services.graph_persistence import persist_graph
from lct_python_backend.services.conversation_reader import build_graph_data_from_nodes
from lct_python_backend.services.transcript.source_backed_aggregation import build_aggregation_request, validate_aggregation
from lct_python_backend.services.transcript.aggregation_checkpoint import capture_aggregation, commit_aggregation
from lct_python_backend.services.transcript.passage_journal import JournalConflict


@pytest.mark.asyncio
@pytest.mark.parametrize("changed_field", ["summary", "speaker"])
async def test_aggregation_append_export_roundtrip_preserves_evidence(changed_field):
    url = os.getenv("PASSAGE_JOURNAL_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Explicit isolated local database URL required")
    parsed = urlparse(url)
    assert parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port == 55439
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    cid, uid1, uid2 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    owner = f"synthetic-aggregation-{cid}"
    sources = {str(uid1): {"id": str(uid1), "sequence_number": 1, "text": "The key is shared."},
               str(uid2): {"id": str(uid2), "sequence_number": 2, "text": "Sam keeps the key."}}
    leaves = [{"id": str(uuid.uuid4()), "semantic_level": 1, "node_name": "Sharing",
               "summary": "The key is shared.", "utterance_ids": [str(uid1)], "thread_id": "access"},
              {"id": str(uuid.uuid4()), "semantic_level": 1, "node_name": "Custody",
               "summary": "Sam keeps the key.", "utterance_ids": [str(uid2)], "thread_id": "custody"}]
    citations = [{"child_id": leaf["id"], "utterance_id": leaf["utterance_ids"][0],
                  "quote": leaf["summary"]} for leaf in leaves]
    parents = validate_aggregation({"nodes": [
        {"node_name": "Shared access and custody", "summary": "Sam holds the shared key.",
         "children_ids": [leaf["id"] for leaf in leaves], "membership_evidence": citations},
        {"node_name": "Custodian", "summary": "Sam holds the key.",
         "children_ids": [leaves[1]["id"]], "membership_evidence": [citations[1]]},
    ]}, build_aggregation_request(leaves, sources, target_level=2))

    async def exported():
        async with sessions() as db:
            nodes = (await db.execute(select(Node).where(Node.conversation_id == cid))).scalars().all()
            edges = (await db.execute(select(Relationship).where(Relationship.conversation_id == cid))).scalars().all()
            utterances = (await db.execute(select(Utterance).where(Utterance.conversation_id == cid))).scalars().all()
            assert {str(u.id): u.text for u in utterances} == {key: value["text"] for key, value in sources.items()}
            graph = build_graph_data_from_nodes(nodes, edges, utterances, include_edges_out=True)
            # Exercise the actual .threads JSON response producer, not only
            # its read helper. This direct call does not test HTTP auth.
            from lct_python_backend.share_api import export_threads
            response = await export_threads(str(cid), db=db)
            bundle = json.loads(response.body)
            assert bundle["format"] == "lct.threads"
            assert bundle["graph_data"] == graph
            assert {u["id"]: u["text"] for u in bundle["utterances"]} == {
                key: value["text"] for key, value in sources.items()}
            return graph

    try:
        async with sessions.begin() as db:
            db.add(Conversation(id=cid, owner_id=owner, conversation_name="Synthetic aggregation",
                                conversation_type="transcript", source_type="synthetic",
                                started_at=datetime.now(timezone.utc)))
            await db.flush()
            for source in sources.values():
                db.add(Utterance(id=uuid.UUID(source["id"]), conversation_id=cid,
                                 sequence_number=source["sequence_number"], text=source["text"], speaker_id="SPEAKER_00"))
        async with sessions.begin() as db:
            await persist_graph(db=db, conversation_id=str(cid), owner_id=owner,
                                existing_json=copy.deepcopy(leaves), append_only=True, commit=False)
        capture_args = dict(conversation_id=str(cid), owner_id=owner, target_level=2)
        async with sessions() as db:
            with pytest.raises(PermissionError):
                await capture_aggregation(db, **{**capture_args, "owner_id": "wrong-owner"})
            snapshot = await capture_aggregation(db, **capture_args)
        commit_args = dict(conversation_id=str(cid), owner_id=owner, snapshot=snapshot,
                           payload={"nodes": parents}, policy_fingerprint="synthetic-aggregation-v1")
        # A flushed stage receipt is not success until its graph transaction
        # commits. A failed outer transaction must leave only the two moments.
        with pytest.raises(RuntimeError, match="rollback aggregate"):
            async with sessions.begin() as db:
                await commit_aggregation(db, **commit_args)
                raise RuntimeError("rollback aggregate")
        assert len(await exported()) == 2
        async with sessions.begin() as db:
            if changed_field == "summary":
                await db.execute(update(Node).where(Node.id == uuid.UUID(leaves[0]["id"])).values(
                    summary="Applied wording correction."))
                leaves[0]["summary"] = "Applied wording correction."
            else:
                # Synthetic source mutation tests snapshot detection, not the
                # separately tested speaker-refinement audit mechanism.
                await db.execute(update(Utterance).where(Utterance.id == uid1).values(
                    speaker_id="SPEAKER_01", speaker_revision=1))
        with pytest.raises(JournalConflict, match="changed before commit"):
            async with sessions.begin() as db:
                await commit_aggregation(db, **commit_args)
        assert len(await exported()) == 2
        async with sessions() as db:
            commit_args["snapshot"] = await capture_aggregation(db, **capture_args)
        async with sessions.begin() as db:
            receipt = await commit_aggregation(db, **commit_args)
        parents = receipt["nodes"]
        assert receipt["request"] == commit_args["snapshot"]["request"]
        # Restart/retry can ignore a newly generated response and recover the
        # saved IDs. It must not append another tier or overwrite child edits.
        async with sessions.begin() as db:
            retried = await commit_aggregation(db, **{**commit_args, "payload": {"nodes": []}})
            assert retried == receipt
        with pytest.raises(JournalConflict, match="reconciliation"):
            async with sessions.begin() as db:
                await commit_aggregation(db, **{**commit_args, "policy_fingerprint": "changed-policy"})
        first = await exported()
        by_id = {node["id"]: node for node in first}
        for parent in parents:
            assert by_id[parent["id"]]["membership_evidence"] == parent["membership_evidence"]
            assert by_id[parent["id"]]["thread_ids"] == parent["thread_ids"]
        assert by_id[leaves[0]["id"]]["summary"] == leaves[0]["summary"]
        assert {m["parent_id"] for m in by_id[leaves[1]["id"]]["memberships"]} == {p["id"] for p in parents}
        # Exercise canonical export -> full re-materialization only on this
        # disposable test conversation, never on a production journal.
        async with sessions.begin() as db:
            await persist_graph(db=db, conversation_id=str(cid), owner_id=owner,
                                existing_json=copy.deepcopy(first), commit=False)
        again = {node["id"]: node for node in await exported()}
        for parent in parents:
            for field in ("membership_evidence", "thread_ids", "utterance_ids"):
                assert again[parent["id"]][field] == by_id[parent["id"]][field]
        assert again[leaves[1]["id"]]["memberships"] == by_id[leaves[1]["id"]]["memberships"]
        # Once inputs change after commit, an old receipt cannot masquerade as
        # a current successful pass. Keep the saved graph, require reconciliation.
        async with sessions.begin() as db:
            await db.execute(update(Node).where(Node.id == uuid.UUID(leaves[0]["id"])).values(
                summary="A new interpretation after aggregation."))
        with pytest.raises(JournalConflict, match="inputs changed"):
            async with sessions.begin() as db:
                await commit_aggregation(db, **commit_args)
    finally:
        async with sessions.begin() as db:
            await db.execute(delete(Conversation).where(Conversation.id == cid, Conversation.owner_id == owner))
        await engine.dispose()
