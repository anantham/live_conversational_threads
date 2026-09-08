"""Fork pre-relation public replay state into an EMPTY isolated database.

Original databases are read-only. No policy rewriting, deletes, schema creation,
inference or publication. The same run/source IDs remain valid in the separate
database. Only reconciliation may change; old review outputs stay in the origin.
"""
import copy
import hashlib
import json

from sqlalchemy import insert, select, text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from lct_python_backend.models import Conversation, Utterance, Node, Relationship, PipelineArtifact, Cluster
from lct_python_backend.services.transcript.passage_journal import _hash, load_journal, restore_records
from lct_python_backend.services.transcript.reconciliation_checkpoint import capture_reconciliation
from tools.public_replay_harness import ensure_replay, validate_target

MODELS = (Conversation, Utterance, Node, Relationship, PipelineArtifact)
KEEP_TYPES = {'passage_checkpoint', 'source_inspection',
              'source_reviewed_question', 'source_reviewed_thread_identity'}
REVIEW_TYPES = {'source_reviewed_relations', 'partial_relation_review'}


def select_pre_relation_rows(rows):
    """Return a deep copy and exclusion receipt; never infer edge ownership."""
    result = copy.deepcopy(rows)
    artifacts = result['pipeline_artifacts']
    edges = {str(row['id']): row for row in result['relationships']}
    created, excluded = set(), []
    for artifact in artifacts:
        kind, body = artifact['artifact_type'], artifact['artifact_json']
        if kind not in KEEP_TYPES | REVIEW_TYPES:
            raise ValueError('Unknown/downstream artifact prevents pre-relation fork')
        if kind != 'passage_checkpoint' and _hash(body) != artifact['content_hash']:
            raise ValueError('Artifact digest differs before replay fork')
        if kind in REVIEW_TYPES:
            excluded.append({'id': str(artifact['id']), 'content_hash': artifact['content_hash']})
        if kind == 'source_reviewed_relations':
            for proposal in body['edges']:
                edge = edges.get(proposal['id'])
                if edge is None or (str(edge['from_node_id']), str(edge['to_node_id']), edge['relationship_type']) != (
                        proposal['from_node_id'], proposal['to_node_id'], proposal['relation_type']):
                    raise ValueError('Reviewed edge is missing or changed')
                if proposal['disposition'] == 'created':
                    if edge['relationship_subtype'] != 'reconciled:source_cited':
                        raise ValueError('Created edge provenance differs')
                    created.add(proposal['id'])
                elif proposal['disposition'] != 'existing_edges_preserved':
                    raise ValueError('Unknown reviewed edge disposition')
    if any(row['level'] != 1 or row['parent_id'] or row['children_ids'] for row in result['nodes']):
        raise ValueError('Hierarchy already exists; pre-relation fork unavailable')
    if any(row['relationship_subtype'] == 'reconciled:source_cited' and identity not in created
           for identity, row in edges.items()):
        raise ValueError('Unreceipted reconciled edge prevents replay fork')
    result['pipeline_artifacts'] = [row for row in artifacts if row['artifact_type'] in KEEP_TYPES]
    result['relationships'] = [row for row in result['relationships'] if str(row['id']) not in created]
    return result, {'excluded_relation_artifacts': excluded, 'excluded_created_edge_ids': sorted(created)}


async def fork_replay(*, source_url, target_url, run_id, owner_id, source, policy,
                      previous_reconciliation, external_llm_ok=False):
    """One source snapshot and one atomic insert into a different empty target."""
    origin = validate_target(source_url, run_id)
    target = validate_target(target_url, run_id)
    # Do not allow host spelling or user aliases to disguise the same DB.
    if (origin.port, origin.database) == (target.port, target.database):
        raise ValueError('Replay fork needs a separate database')
    if (not isinstance(previous_reconciliation, str) or len(previous_reconciliation) != 64
            or previous_reconciliation == policy.get('reconciliation')):
        raise ValueError('Explicit previous reconciliation fingerprint must differ')
    old_policy = {**policy, 'reconciliation': previous_reconciliation}
    reader = create_async_engine(source_url, isolation_level='REPEATABLE READ')
    writer = create_async_engine(target_url)
    args = dict(run_id=run_id, owner_id=owner_id, source=source, external_llm_ok=external_llm_ok)
    try:
        async with async_sessionmaker(reader).begin() as db:
            await db.execute(text('SET TRANSACTION READ ONLY'))
            cid = await ensure_replay(db, **args, policy=old_policy, resume=True)
            journal = await load_journal(db, conversation_id=str(cid), owner_id=owner_id)
            state = restore_records(journal)
            if (not journal or state['committed_through'] != source[-1]['sequence_number']
                    or any(row['policy_fingerprint'] != policy['runtime'] for row in journal)):
                raise ValueError('Extraction must be complete under the unchanged runtime policy')
            if (await db.execute(select(Cluster.id).where(Cluster.conversation_id == cid).limit(1))).first():
                raise ValueError('Clusters already exist; pre-relation fork unavailable')
            rows = {}
            for model in MODELS:
                table = model.__table__
                condition = table.c.id == cid if model is Conversation else table.c.conversation_id == cid
                rows[table.name] = [dict(row) for row in (await db.execute(
                    select(table).where(condition).order_by(table.c.id))).mappings()]
            basis = await capture_reconciliation(db, conversation_id=str(cid), owner_id=owner_id)
            if any(row['artifact_type'] in REVIEW_TYPES and
                   row['artifact_json'].get('basis_hash') != basis['basis_hash']
                   for row in rows['pipeline_artifacts']):
                raise ValueError('Source or canonical leaves changed since saved relation review')
            projected, excluded = select_pre_relation_rows(rows)
            # Retains a digest of every copied column, including original timestamps.
            digest = hashlib.sha256(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()
        projected['conversations'][0]['source_metadata']['replay_policy'] = copy.deepcopy(policy)
        receipt = {'source_database': origin.database, 'source_rows_sha256': digest,
                   'source_leaf_basis_hash': basis['basis_hash'],
                   'old_policy': old_policy, 'new_policy': policy, **excluded,
                   'copied_counts': {name: len(values) for name, values in projected.items()}}
        async with async_sessionmaker(writer).begin() as db:
            await db.execute(text('SELECT pg_advisory_xact_lock(706182901)'))
            for model in (*MODELS, Cluster):
                if (await db.execute(select(model.id).limit(1))).first():
                    raise ValueError('Replay fork target must be empty; no overwrite permitted')
            for model in MODELS:
                values = projected[model.__tablename__]
                if values:
                    if model is Node:
                        # One statement permits forward/self-FK references among
                        # copied leaves; executemany could expose a partial graph.
                        await db.execute(insert(model.__table__).values(values))
                    else:
                        await db.execute(insert(model.__table__), values)
            await ensure_replay(db, **args, policy=policy, resume=True)
            restored = await load_journal(db, conversation_id=str(cid), owner_id=owner_id)
            if restored != journal:
                raise ValueError('Forked extraction journal differs')
            db.add(PipelineArtifact(conversation_id=cid, stage='public_replay_fork_v1', stage_index=0,
                artifact_type='public_replay_fork', artifact_json=receipt, content_hash=_hash(receipt)))
        return receipt
    finally:
        await reader.dispose()
        await writer.dispose()
