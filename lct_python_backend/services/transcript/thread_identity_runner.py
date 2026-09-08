"""Explicit source-backed occurrence-pair reviews, never canonical thread merges.

Uses the shared authorized source projection and append-only artifact store.
Candidate selection is caller-owned and bounded; coverage never implies that a
retrieved subset exhausts all possible pairs or proves semantic truth.
"""
import asyncio
import copy
import json
import uuid
from sqlalchemy import select
from lct_python_backend.models import PipelineArtifact
from .passage_journal import JournalConflict, _hash, _authorized_conversation
from .question_review_runner import capture_question_basis
from .source_inspection_runner import check_inference_consent
from .thread_identity_review import (THREAD_IDENTITY_REVIEW_PROMPT, thread_identity_request,
                                      validate_thread_identity_review)

ARTIFACT_TYPE = 'source_reviewed_thread_identity'


def occurrence_ids(state):
    ids = [node['id'] for node in state['nodes']
           if isinstance(node.get('thread_id'), str) and node['thread_id'].strip()]
    if len(ids) != len(set(ids)):
        raise JournalConflict('Duplicate thread occurrence identities')
    return sorted(ids)


def pair_basis(basis, pair):
    if (not isinstance(pair, (list, tuple)) or len(pair) != 2
            or any(not isinstance(i, str) for i in pair) or pair[0] == pair[1]):
        raise ValueError('Two distinct thread occurrence IDs required')
    ids = sorted(pair)
    state = basis['state']
    if not set(ids) <= set(occurrence_ids(state)):
        raise ValueError('Thread occurrence pair is unavailable in this revision')
    nodes = sorted((node for node in state['nodes'] if node['id'] in ids), key=lambda n: n['id'])
    chunks = sorted({node['chunk_id'] for node in nodes})
    mapping = {cid: state['utterance_chunk_map'][cid] for cid in chunks}
    uids = {uid for members in mapping.values() for uid in members}
    rows = [row for row in basis['source']['request']['sources'] if row['id'] in uids]
    if len(rows) != len(uids) or {row['id'] for row in rows} != uids:
        raise JournalConflict('Thread pair source identities are missing or duplicated')
    return copy.deepcopy({'state': {'nodes': nodes, 'chunks': {cid: state['chunks'][cid] for cid in chunks},
                                   'utterance_chunk_map': mapping},
                          'sources': sorted(rows, key=lambda row: (row['sequence_number'], row['id']))})


def pair_request(local_basis, pair, envelope=None):
    request = thread_identity_request(local_basis['state'], pair)
    rows = {row['id']: row for row in local_basis['sources']}
    for source in request['sources']:
        fragments = [rows[uid] for uid in source['utterance_ids']]
        if ' '.join(row['text'] for row in fragments) != source['text']:
            raise JournalConflict('Thread review source differs from committed passage')
        source['utterance_fields'] = ['sequence_number', 'start', 'end', 'speaker_id']
        source['utterances'] = []
        offset = 0
        for row in fragments:
            source['utterances'].append([row['sequence_number'], offset, offset + len(row['text']), row['speaker_id']])
            offset += len(row['text']) + 1
    if envelope is not None:
        envelope.validate(json.dumps(request, ensure_ascii=False, separators=(',', ':')))
    return request


def annotation(saved):
    return {**copy.deepcopy(saved['review']), 'pair': list(saved['pair']),
            'sources': copy.deepcopy(saved['request']['sources']),
            'policy_fingerprint': saved['policy_fingerprint'], 'basis_hash': saved['basis_hash'],
            'verification': 'model_reviewed_not_human_verified'}


class ThreadIdentityRunner:
    def __init__(self, *, session_factory, conversation_id, owner_id, envelope,
                 candidate_policy_id='explicit_pairs_v1'):
        if not isinstance(candidate_policy_id, str) or not candidate_policy_id.strip():
            raise ValueError('Explicit candidate policy identity required')
        self.sessions = session_factory
        self.scope = dict(conversation_id=conversation_id, owner_id=owner_id)
        self.envelope = envelope.with_system_prompt(THREAD_IDENTITY_REVIEW_PROMPT)
        self.candidate_policy_id = candidate_policy_id
        self.fingerprint = _hash({'version': 1, 'inference': self.envelope.fingerprint,
                                  'candidate_policy_id': candidate_policy_id})

    async def capture(self, db, *, lock=False):
        await check_inference_consent(db, **self.scope, providers=self.envelope.providers)
        return await capture_question_basis(db, **self.scope, lock=lock)

    async def checkpoint(self, db, captured, pair, request, response=None):
        current = await self.capture(db, lock=True)
        try:
            local = pair_basis(current, pair)
            if local != pair_basis(captured, pair):
                raise JournalConflict('Thread occurrence source or interpretation changed during review')
        except (ValueError, KeyError) as exc:
            raise JournalConflict('Thread occurrence is unavailable in current source revision') from exc
        if request != pair_request(local, pair, self.envelope):
            raise JournalConflict('Thread review request differs from current occurrence evidence')
        identity = {'pair': sorted(pair), 'basis_hash': _hash(local), 'request_hash': _hash(request),
                    'policy_fingerprint': self.fingerprint, 'candidate_policy_id': self.candidate_policy_id}
        stage = 'tidrev_v1_' + _hash(identity)[:40]
        rows = (await db.execute(select(PipelineArtifact).where(
            PipelineArtifact.conversation_id == uuid.UUID(self.scope['conversation_id']),
            PipelineArtifact.stage == stage, PipelineArtifact.stage_index == 0))).scalars().all()
        if len(rows) > 1:
            raise JournalConflict('Multiple thread identity receipts for one revision')
        if rows:
            saved = rows[0].artifact_json
            if _hash(saved) != rows[0].content_hash or any(saved.get(k) != v for k, v in identity.items()):
                raise JournalConflict('Thread identity receipt content or revision identity differs')
            if saved['request'] != request:
                raise JournalConflict('Saved thread identity request differs from its receipt identity')
            if validate_thread_identity_review(saved['response'], request) != saved['review']:
                raise JournalConflict('Saved thread identity review no longer reproduces')
            return copy.deepcopy(saved)
        if response is None:
            return None
        saved = {**identity, 'request': copy.deepcopy(request), 'response': copy.deepcopy(response),
                 'review': validate_thread_identity_review(response, request)}
        db.add(PipelineArtifact(conversation_id=uuid.UUID(self.scope['conversation_id']), stage=stage,
            stage_index=0, artifact_type=ARTIFACT_TYPE, artifact_json=saved, content_hash=_hash(saved)))
        await db.flush()
        return saved

    async def run(self, candidate_pairs):
        if not isinstance(candidate_pairs, (list, tuple)):
            raise ValueError('Explicit candidate pair list required; no automatic all-pairs inference')
        async with self.sessions.begin() as db:
            basis = await self.capture(db)
        # Validate all candidates before any model invocation or receipt write.
        for pair in candidate_pairs:
            pair_basis(basis, pair)
        pairs = sorted({tuple(sorted(pair)) for pair in candidate_pairs})
        receipts = []
        for pair in pairs:
            request = pair_request(pair_basis(basis, pair), pair, self.envelope)
            async with self.sessions.begin() as db:
                saved = await self.checkpoint(db, basis, pair, request)
            if saved is None:
                result = await asyncio.to_thread(self.envelope.complete_json,
                    json.dumps(request, ensure_ascii=False, separators=(',', ':')))
                async with self.sessions.begin() as db:
                    saved = await self.checkpoint(db, basis, pair, request, result.data)
            receipts.append(saved)
        total = len(occurrence_ids(basis['state']))
        possible = total * (total - 1) // 2
        return {'annotations': [annotation(saved) for saved in receipts],
                'candidate_policy_id': self.candidate_policy_id, 'policy_fingerprint': self.fingerprint,
                'candidate_list_hash': _hash(pairs), 'candidate_pair_count': len(pairs),
                'reviewed_pair_count': len(receipts), 'possible_pair_count': possible,
                'coverage_complete': len(receipts) == possible, 'accepted_for_projection': False}


async def export_thread_identity_reviews(db, *, conversation_id, owner_id, expected_state=None):
    """Read current annotations with pair-local sources, never the global snapshot."""
    await _authorized_conversation(db, conversation_id, owner_id, lock=False)
    basis = await capture_question_basis(db, conversation_id=conversation_id, owner_id=owner_id)
    if expected_state is not None and any(basis['state'].get(k) != v for k, v in expected_state.items()):
        raise JournalConflict('Thread identity context differs from processor history')
    rows = (await db.execute(select(PipelineArtifact).where(
        PipelineArtifact.conversation_id == uuid.UUID(conversation_id),
        PipelineArtifact.artifact_type == ARTIFACT_TYPE))).scalars().all()
    total = len(occurrence_ids(basis['state']))
    possible, superseded, grouped = total * (total - 1) // 2, 0, {}
    for row in rows:
        saved = row.artifact_json
        if _hash(saved) != row.content_hash:
            raise JournalConflict('Thread identity export receipt digest mismatch')
        try:
            local = pair_basis(basis, saved['pair'])
        except (ValueError, KeyError):
            superseded += 1
            continue
        if _hash(local) != saved['basis_hash']:
            superseded += 1
            continue
        request = pair_request(local, saved['pair'])
        if request != saved['request'] or _hash(request) != saved['request_hash']:
            raise JournalConflict('Thread identity export request differs from current evidence')
        if validate_thread_identity_review(saved['response'], request) != saved['review']:
            raise JournalConflict('Thread identity export review no longer reproduces')
        group = grouped.setdefault(saved['policy_fingerprint'], {})
        pair = tuple(saved['pair'])
        if pair in group:
            raise JournalConflict('Multiple current thread identity reviews for one pair and policy')
        group[pair] = annotation(saved)
    return {'schema_version': 1, 'verification': 'model_reviewed_not_human_verified',
            'status': 'current_reviews' if grouped else 'no_current_review',
            'possible_pair_count': possible, 'superseded_review_count': superseded,
            'policies': [{'policy_fingerprint': policy, 'annotations': [group[p] for p in sorted(group)],
                          'reviewed_pair_count': len(group), 'possible_pair_count': possible,
                          'coverage_complete': len(group) == possible} for policy, group in sorted(grouped.items())]}
