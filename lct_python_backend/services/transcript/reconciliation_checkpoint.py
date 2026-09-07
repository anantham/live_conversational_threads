"""Atomic source-reviewed relation receipts and append-only canonical edges.

Caller owns the transaction and must refresh consent before generation as well.
This commit boundary rechecks source, leaf interpretations and consent. It never
replaces human edges, writes thread identities or marks questions answered.
"""
import copy
import uuid

from sqlalchemy import null, select

from lct_python_backend.models import Node, PipelineArtifact, Relationship
from .passage_journal import JournalConflict, _hash
from .reconciliation_mapping import map_reviewed_relations
from .source_inspection_runner import capture_inspection, check_inference_consent
from .canonical_selection import canonical_candidates

STAGE = 'conversation_relation_review_v1'


async def capture_reconciliation(db, *, conversation_id, owner_id, lock=False):
    source = await capture_inspection(db, conversation_id=conversation_id, owner_id=owner_id, lock=lock)
    statement = select(Node).where(Node.conversation_id == uuid.UUID(conversation_id), Node.level == 1).order_by(Node.id)
    if lock:
        statement = statement.with_for_update()
    rows = (await db.execute(statement.execution_options(populate_existing=True))).scalars().all()
    nodes = [{'id': str(row.id), 'level': row.level, 'node_name': row.node_name,
              'summary': row.summary, 'source_excerpt': row.source_excerpt,
              'utterance_ids': [str(identity) for identity in (row.utterance_ids or [])],
              'source_ref': row.source_ref, 'thread_id': row.thread_id, 'thread_state': row.thread_state,
              'display_preferences': row.display_preferences} for row in rows]
    basis = {'source_snapshot': source, 'nodes': nodes}
    return {**copy.deepcopy(basis), 'basis_hash': _hash(basis)}


def validate_context_source(context, snapshot):
    source_snapshot = snapshot['source_snapshot']
    if context.get('input_hash') != source_snapshot['input_hash']:
        raise JournalConflict('Relation context uses a different source revision')
    sources = {source['id']: source for source in source_snapshot['request']['sources']}
    watermark = context.get('available_through_sequence')
    if type(watermark) is not int:
        raise JournalConflict('Relation context requires an explicit source watermark')
    for observation in [context['focal'], *context['candidates']]:
        if ('canonical_candidates' in observation and
                observation['canonical_candidates'] != canonical_candidates(observation, snapshot['nodes'])):
            raise JournalConflict('Canonical candidates differ from the captured node snapshot')
        for excerpt in observation['source_excerpts']:
            source = sources.get(excerpt['utterance_id'])
            start, end = excerpt['start'], excerpt['end']
            if (source is None or source['sequence_number'] > watermark
                    or type(start) is not int or type(end) is not int
                    or not 0 <= start <= end <= len(source['text'])
                    or source['text'][start:end] != excerpt['text']
                    or any(excerpt.get(key) != source.get(key) for key in ('sequence_number', 'speaker_id', 'speaker_revision'))):
                raise JournalConflict('Relation context excerpt differs from authorized source')


async def checkpoint_relation_review(db, *, conversation_id, owner_id, snapshot, context,
                                     batch_index, policy_fingerprint, providers, review=None):
    if type(batch_index) is not int or batch_index < 0 or not isinstance(policy_fingerprint, str) or not policy_fingerprint:
        raise ValueError('Relation checkpoint requires a batch index and policy fingerprint')
    await check_inference_consent(db, conversation_id=conversation_id, owner_id=owner_id, providers=providers)
    current = await capture_reconciliation(db, conversation_id=conversation_id, owner_id=owner_id, lock=True)
    if current != snapshot:
        raise JournalConflict('Source or leaf interpretation changed before relation commit')
    validate_context_source(context, snapshot)
    cid = uuid.UUID(conversation_id)
    artifacts = (await db.execute(select(PipelineArtifact).where(
        PipelineArtifact.conversation_id == cid, PipelineArtifact.stage == STAGE,
        PipelineArtifact.stage_index == batch_index))).scalars().all()
    if len(artifacts) > 1:
        raise JournalConflict('Multiple relation receipts at one batch index')
    if artifacts:
        saved = artifacts[0].artifact_json
        if _hash(saved) != artifacts[0].content_hash:
            raise JournalConflict('Relation receipt digest mismatch')
        if (saved['basis_hash'] != snapshot['basis_hash'] or saved['context_hash'] != _hash(context)
                or saved['policy_fingerprint'] != policy_fingerprint):
            raise JournalConflict('Saved relation batch requires explicit reconciliation')
        for edge in saved['edges']:
            row = (await db.execute(select(Relationship).where(
                Relationship.id == uuid.UUID(edge['id']), Relationship.conversation_id == cid))).scalar_one_or_none()
            if row is None or (str(row.from_node_id), str(row.to_node_id), row.relationship_type) != (
                    edge['from_node_id'], edge['to_node_id'], edge['relation_type']):
                raise JournalConflict('Saved relation endpoint missing or structurally changed')
        return copy.deepcopy(saved)
    if review is None:
        return None
    if review.get('policy_fingerprint') != policy_fingerprint:
        raise JournalConflict('Relation review was produced under another policy')
    mapped = map_reviewed_relations(review, context, snapshot['nodes'])
    grouped = {}
    for proposal in mapped:
        if proposal['disposition'] in ('unique_source_ownership', 'semantic_selection'):
            key = (proposal['from_node_id'], proposal['to_node_id'], proposal['relation']['relation_type'])
            grouped.setdefault(key, []).append(proposal)
    edges = []
    for (origin, destination, kind), proposals in grouped.items():
        existing = (await db.execute(select(Relationship).where(
            Relationship.conversation_id == cid, Relationship.from_node_id == uuid.UUID(origin),
            Relationship.to_node_id == uuid.UUID(destination), Relationship.relationship_type == kind
        ).order_by(Relationship.id).with_for_update())).scalars().all()
        if existing:
            identities = [str(row.id) for row in existing]
            disposition = 'existing_edges_preserved'
        else:
            identity = uuid.uuid4()
            evidence_ids = sorted({citation['utterance_id'] for p in proposals for citation in p['relation']['evidence']})
            db.add(Relationship(id=identity, conversation_id=cid,
                from_node_id=uuid.UUID(origin), to_node_id=uuid.UUID(destination), relationship_type=kind,
                relationship_subtype='reconciled:source_cited',
                explanation='\n'.join(dict.fromkeys(p['relation']['rationale'] for p in proposals)),
                supporting_utterance_ids=[uuid.UUID(value) for value in evidence_ids],
                strength=null(), confidence=null()))  # No fabricated numeric model confidence.
            identities, disposition = [str(identity)], 'created'
        edges.extend({'id': identity, 'from_node_id': origin, 'to_node_id': destination,
                      'relation_type': kind, 'disposition': disposition} for identity in identities)
    receipt = {'basis_hash': snapshot['basis_hash'], 'context_hash': _hash(context),
               'policy_fingerprint': policy_fingerprint, 'context': copy.deepcopy(context),
               'review': copy.deepcopy(review), 'mapping': mapped, 'edges': edges,
               'semantic_reconciliation_complete': False}
    db.add(PipelineArtifact(conversation_id=cid, stage=STAGE, stage_index=batch_index,
        artifact_type='source_reviewed_relations', artifact_json=receipt, content_hash=_hash(receipt)))
    await db.flush()
    return copy.deepcopy(receipt)
