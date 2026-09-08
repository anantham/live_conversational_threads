"""Atomic source-backed aggregation receipt in the existing artifact store.

The caller owns the transaction. Capture and generation happen without long
locks; commit rechecks evidence under short locks before inserting parents and
the receipt together. Existing tiers with changed inputs require reconciliation,
not duplicate parents or destructive replacement of human-edited nodes.
"""
import copy
import uuid

from sqlalchemy import select

from lct_python_backend.models import Node, Relationship, Utterance, PipelineArtifact
from lct_python_backend.services.conversation_reader import build_graph_data_from_nodes
from lct_python_backend.services.graph_persistence import persist_graph
from .passage_journal import JournalConflict, _authorized_conversation, _hash, _source
from .source_backed_aggregation import build_aggregation_request, validate_aggregation

STAGE = "conversation_abstraction_v1"


async def capture_aggregation(db, *, conversation_id, owner_id, target_level, lock=False):
    await _authorized_conversation(db, conversation_id, owner_id, lock=lock)
    cid = uuid.UUID(conversation_id)
    rows = []
    for model in (Utterance, Node, Relationship):
        statement = select(model).where(model.conversation_id == cid).order_by(model.id)
        if lock:
            statement = statement.with_for_update()
        rows.append((await db.execute(statement.execution_options(populate_existing=True))).scalars().all())
    sources, nodes, relationships = rows
    graph = build_graph_data_from_nodes(nodes, relationships, sources)
    children = [node for node in graph if node["semantic_level"] == target_level - 1]
    source_map = {str(source.id): _source(source) for source in sources}
    children.sort(key=lambda node: (min((source_map[i]["sequence_number"] for i in node["utterance_ids"]), default=0), node["id"]))
    request = build_aggregation_request(children, source_map, target_level=target_level)
    return {"request": request, "input_hash": _hash(request)}


async def commit_aggregation(db, *, conversation_id, owner_id, snapshot, payload, policy_fingerprint,
                             revision_guard=None):
    """Return saved parent identities only after caller commits this transaction.

An exact retry returns the original receipt, not newly generated identities.
Current output edits are never overwritten by receipt recovery.
"""
    if not isinstance(policy_fingerprint, str) or not policy_fingerprint.strip():
        raise ValueError("Aggregation policy fingerprint required")
    request = snapshot["request"]
    if _hash(request) != snapshot["input_hash"]:
        raise JournalConflict("Aggregation snapshot digest mismatch")
    level = request["target_level"]
    current = await capture_aggregation(db, conversation_id=conversation_id, owner_id=owner_id,
                                        target_level=level, lock=True)
    # Conversation/source locks also serialize annotation writers. Check the
    # proposal's auxiliary interpretation basis before recovery or parent writes.
    if revision_guard is not None:
        await revision_guard(db)
    cid = uuid.UUID(conversation_id)
    artifacts = (await db.execute(select(PipelineArtifact).where(
        PipelineArtifact.conversation_id == cid, PipelineArtifact.stage == STAGE,
        PipelineArtifact.stage_index == level))).scalars().all()
    if len(artifacts) > 1:
        raise JournalConflict("Multiple active aggregation receipts require reconciliation")
    if artifacts:
        artifact = artifacts[0]
        saved = artifact.artifact_json
        if _hash(saved) != artifact.content_hash:
            raise JournalConflict("Aggregation receipt digest mismatch")
        if saved["input_hash"] != snapshot["input_hash"] or saved["policy_fingerprint"] != policy_fingerprint:
            raise JournalConflict("Existing abstraction requires source-backed reconciliation")
        if current != snapshot:
            raise JournalConflict("Saved abstraction inputs changed; source-backed reconciliation required")
        identities = [uuid.UUID(node["id"]) for node in saved["nodes"]]
        present = (await db.execute(select(Node.id).where(Node.conversation_id == cid, Node.id.in_(identities)))).scalars().all()
        if set(present) != set(identities):
            raise JournalConflict("Saved aggregation nodes missing; structural reconciliation required")
        return copy.deepcopy(saved)
    if current != snapshot:
        raise JournalConflict("Aggregation source or interpretation changed before commit")
    existing_tier = (await db.execute(select(Node.id).where(
        Node.conversation_id == cid, Node.level == level).limit(1))).scalar_one_or_none()
    if existing_tier is not None:
        raise JournalConflict("Existing tier has no aggregation receipt; explicit reconciliation required")
    if payload is None:
        # Recovery probe: all ownership/snapshot/existing-tier checks above
        # still apply, but no graph or receipt is created.
        return None
    parents = validate_aggregation(payload, request)
    await persist_graph(db=db, conversation_id=conversation_id, owner_id=owner_id,
                        existing_json=copy.deepcopy(parents), append_only=True, commit=False)
    receipt = {"input_hash": snapshot["input_hash"], "policy_fingerprint": policy_fingerprint,
               "target_level": level, "request": copy.deepcopy(request), "nodes": parents}
    db.add(PipelineArtifact(conversation_id=cid, stage=STAGE, stage_index=level,
        artifact_type="source_backed_abstraction", artifact_json=receipt, content_hash=_hash(receipt)))
    await db.flush()
    return copy.deepcopy(receipt)
