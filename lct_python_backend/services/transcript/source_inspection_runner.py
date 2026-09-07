"""Revision-checked, resumable source inspection using the existing artifact store.

Inspection is not a new graph, a completed abstraction tier, or proof that every
meaning was found. Production aggregation is not switched to this runner yet.
"""
import asyncio
import copy
import json
import uuid

from sqlalchemy import select

from lct_python_backend.models import PipelineArtifact, Utterance
from lct_python_backend.services.deployment_privacy_policy import (
    DeploymentPrivacyError, assert_raw_transcript_retention_allowed, select_providers_for_privacy,
)
from .passage_journal import JournalConflict, _authorized_conversation, _hash, _source
from .source_inspection import validate_inspection
from .source_inspection_pages import inspection_sources, plan_inspection_pages, source_span

STAGE = 'conversation_source_inspection_v2'


async def check_inference_consent(db, *, conversation_id, owner_id, providers):
    conversation = await _authorized_conversation(db, conversation_id, owner_id, lock=True)
    metadata = conversation.source_metadata if isinstance(conversation.source_metadata, dict) else {}
    privacy = metadata.get('privacy')
    permitted = select_providers_for_privacy(providers, privacy)
    if permitted != providers:
        raise DeploymentPrivacyError('Stored consent no longer permits the frozen inference routes')
    if not isinstance(privacy, dict) or privacy.get('redaction_applied') is not True:
        assert_raw_transcript_retention_allowed()


async def capture_inspection(db, *, conversation_id, owner_id, lock=False):
    """Raw source owns inspection identity; graph revisions own later mapping.

    Read ALL authorized utterances, including ones extraction may have missed.
    No historical graph-bound receipts are silently reinterpreted as this format.
    """
    await _authorized_conversation(db, conversation_id, owner_id, lock=lock)
    statement = select(Utterance).where(Utterance.conversation_id == uuid.UUID(conversation_id)).order_by(Utterance.sequence_number)
    if lock:
        statement = statement.with_for_update()
    rows = (await db.execute(statement.execution_options(populate_existing=True))).scalars().all()
    request = {'sources': [_source(row) for row in rows]}
    return {'request': request, 'input_hash': _hash(request)}


def validate_page(page, snapshot):
    sources = inspection_sources(snapshot['request']['sources'])
    by_id = {source['id']: source for source in sources}
    if (page.get('source_snapshot_hash') != _hash(sources)
            or type(page.get('page_index')) is not int or page['page_index'] < 0
            or page.get('offset_unit') != 'unicode_codepoints'
            or not isinstance(page.get('spans'), list) or not page['spans']):
        raise JournalConflict('Inspection page is not bound to this source snapshot')
    previous = None
    for span in page['spans']:
        if not isinstance(span, dict):
            raise JournalConflict('Inspection span must be a source-range object')
        identity, start, end = span.get('utterance_id'), span.get('start'), span.get('end')
        if (not isinstance(identity, str) or identity not in by_id
                or type(start) is not int or type(end) is not int
                or not 0 <= start <= end <= len(by_id[identity]['text'])
                or (start == end and by_id[identity]['text'])
                or span != source_span(by_id[identity], start, end)):
            raise JournalConflict('Inspection span differs from its original source')
        position = (span['sequence_number'], start, end)
        if previous is not None and (position <= previous
                or (position[0] == previous[0] and start < previous[2])):
            raise JournalConflict('Inspection spans overlap or are out of source order')
        previous = position


async def checkpoint_inspection(db, *, conversation_id, owner_id, snapshot, page,
                                policy_fingerprint, payload=None):
    """Caller owns transaction; no inference or long-held locks here."""
    if not isinstance(policy_fingerprint, str) or not policy_fingerprint.strip():
        raise ValueError('Inspection policy fingerprint required')
    if _hash(snapshot['request']) != snapshot['input_hash']:
        raise JournalConflict('Inspection snapshot digest mismatch')
    current = await capture_inspection(db, conversation_id=conversation_id, owner_id=owner_id, lock=True)
    if current != snapshot:
        raise JournalConflict('Inspection source changed; recapture required')
    validate_page(page, snapshot)
    rows = (await db.execute(select(PipelineArtifact).where(
        PipelineArtifact.conversation_id == uuid.UUID(conversation_id),
        PipelineArtifact.stage == STAGE, PipelineArtifact.stage_index == page['page_index']))).scalars().all()
    if len(rows) > 1:
        raise JournalConflict('Multiple inspection receipts for one page')
    if rows:
        saved = rows[0].artifact_json
        if rows[0].content_hash != _hash(saved):
            raise JournalConflict('Inspection receipt digest mismatch')
        if (saved['input_hash'] != snapshot['input_hash'] or saved['page'] != page
                or saved['policy_fingerprint'] != policy_fingerprint):
            raise JournalConflict('Saved inspection requires explicit revision reconciliation')
        return copy.deepcopy(saved)
    legacy = (await db.execute(select(PipelineArtifact.id).where(
        PipelineArtifact.conversation_id == uuid.UUID(conversation_id),
        PipelineArtifact.stage.like('conversation_inspection_l%')).limit(1))).scalar_one_or_none()
    if legacy is not None:
        raise JournalConflict('Legacy graph-bound inspection requires explicit migration or separate replay')
    if payload is None:
        return None
    result = validate_inspection(payload, page)
    receipt = {'input_hash': snapshot['input_hash'], 'page': copy.deepcopy(page),
               'policy_fingerprint': policy_fingerprint, 'result': result}
    db.add(PipelineArtifact(conversation_id=uuid.UUID(conversation_id), stage=STAGE,
        stage_index=page['page_index'], artifact_type='source_inspection',
        artifact_json=receipt, content_hash=_hash(receipt)))
    await db.flush()
    return copy.deepcopy(receipt)


class SourceInspectionRunner:
    def __init__(self, *, session_factory, conversation_id, owner_id, envelope):
        self.sessions = session_factory
        self.conversation_id = conversation_id
        self.owner_id = owner_id
        self.envelope = envelope

    async def check_consent(self, db):
        await check_inference_consent(db, conversation_id=self.conversation_id,
                                      owner_id=self.owner_id, providers=self.envelope.providers)

    async def run(self):
        scope = {'conversation_id': self.conversation_id, 'owner_id': self.owner_id}
        async with self.sessions.begin() as db:
            await self.check_consent(db)
            snapshot = await capture_inspection(db, **scope)
        pages = plan_inspection_pages(snapshot['request']['sources'], envelope=self.envelope)
        receipts = []
        for page in pages:
            args = {**scope, 'snapshot': snapshot, 'page': page,
                    'policy_fingerprint': self.envelope.fingerprint}
            async with self.sessions.begin() as db:
                await self.check_consent(db)
                receipt = await checkpoint_inspection(db, **args)
            if receipt is None:
                prompt = json.dumps(page, ensure_ascii=False, separators=(',', ':'))
                result = await asyncio.to_thread(self.envelope.complete_json, prompt)
                async with self.sessions.begin() as db:
                    await self.check_consent(db)
                    receipt = await checkpoint_inspection(db, **args, payload=result.data)
            receipts.append(receipt)
        return {'input_hash': snapshot['input_hash'], 'receipts': receipts,
                'submitted_characters': sum(span['end'] - span['start'] for page in pages for span in page['spans']),
                'abstained_pages': sum(not receipt['result']['observations'] for receipt in receipts),
                'semantic_reconciliation_complete': False}
