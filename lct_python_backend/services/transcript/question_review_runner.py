"""Owner/consent checked question review receipts, separate from graph mutation."""
import asyncio
import copy
import json
import uuid
from sqlalchemy import select
from lct_python_backend.models import PipelineArtifact
from .passage_journal import load_journal, restore_records, JournalConflict, _hash
from .passage_projection import load_interpretation_projection
from .source_inspection_runner import capture_inspection, check_inference_consent
from .question_memory import fold_question_memory
from .question_review import build_question_review, validate_question_review, QUESTION_REVIEW_PROMPT

STAGE = 'conversation_question_review_v1'


async def capture_question_basis(db, *, conversation_id, owner_id, lock=False):
    scope = dict(conversation_id=conversation_id, owner_id=owner_id)
    source = await capture_inspection(db, **scope, lock=lock)
    records = await load_journal(db, **scope)
    state = await load_interpretation_projection(db, **scope, state=restore_records(records), source_records=records)
    return {'source': source, 'state': state}


def attributed_question_request(basis, question_id, envelope):
    state = basis['state']
    request = build_question_review(state['nodes'], state['chunks'], question_id, envelope=envelope)
    rows = {row['id']: row for row in basis['source']['request']['sources']}
    for source in request['sources']:
        ids = state['utterance_chunk_map'][source['chunk_id']]
        fragments = [rows[uid] for uid in ids]
        if ' '.join(row['text'] for row in fragments) != source['text']:
            raise JournalConflict('Question review source differs from committed passage')
        offset = 0
        source['utterance_fields'] = ['sequence_number', 'start', 'end', 'speaker_id']
        source['utterances'] = []
        for row in fragments:
            # Attribute exact ranges of the already supplied full source.
            # Repeating each utterance's text here wastes context, not evidence.
            # Canonical UUIDs/revisions/timestamps remain in the source basis;
            # the reviewer needs source order, exact range and speaker here.
            source['utterances'].append([row['sequence_number'], offset,
                                         offset + len(row['text']), row['speaker_id']])
            offset += len(row['text']) + 1
    envelope.validate(json.dumps(request, ensure_ascii=False, separators=(',', ':')))
    return request


class QuestionReviewRunner:
    def __init__(self, *, session_factory, conversation_id, owner_id, envelope):
        self.sessions = session_factory
        self.scope = dict(conversation_id=conversation_id, owner_id=owner_id)
        self.envelope = envelope.with_system_prompt(QUESTION_REVIEW_PROMPT)

    async def capture(self, db, lock=False):
        await check_inference_consent(db, **self.scope, providers=self.envelope.providers)
        return await capture_question_basis(db, **self.scope, lock=lock)

    async def checkpoint(self, db, basis, index, request, response=None):
        current = await self.capture(db, lock=True)
        if current != basis:
            raise JournalConflict('Question source or interpretation changed during review')
        cid = uuid.UUID(self.scope['conversation_id'])
        rows = (await db.execute(select(PipelineArtifact).where(
            PipelineArtifact.conversation_id == cid, PipelineArtifact.stage == STAGE,
            PipelineArtifact.stage_index == index))).scalars().all()
        if len(rows) > 1:
            raise JournalConflict('Multiple question receipts at one index')
        identity = {'basis_hash': _hash(basis), 'request_hash': _hash(request),
                    'policy_fingerprint': self.envelope.fingerprint}
        if rows:
            saved = rows[0].artifact_json
            if _hash(saved) != rows[0].content_hash or any(saved.get(k) != v for k, v in identity.items()):
                raise JournalConflict('Saved question review requires explicit revision')
            # Revalidate saved raw judgments, not only their digest.
            if validate_question_review(saved['response'], request) != saved['review']:
                raise JournalConflict('Question review no longer reproduces')
            return copy.deepcopy(saved)
        if response is None:
            return None
        review = validate_question_review(response, request)
        saved = {**identity, 'request': copy.deepcopy(request), 'response': copy.deepcopy(response), 'review': review}
        db.add(PipelineArtifact(conversation_id=cid, stage=STAGE, stage_index=index,
            artifact_type='source_reviewed_question', artifact_json=saved, content_hash=_hash(saved)))
        await db.flush()
        return saved

    async def run(self):
        async with self.sessions.begin() as db:
            basis = await self.capture(db)
        state = basis['state']
        questions = fold_question_memory(state['nodes'], state['chunks'])
        receipts = []
        for index, qid in enumerate(sorted(questions)):
            request = attributed_question_request(basis, qid, self.envelope)
            async with self.sessions.begin() as db:
                saved = await self.checkpoint(db, basis, index, request)
            if saved is None:
                if len(request['events']) == 1:
                    response = {'assessments': []}
                else:
                    result = await asyncio.to_thread(self.envelope.complete_json,
                        json.dumps(request, ensure_ascii=False, separators=(',', ':')))
                    response = result.data
                async with self.sessions.begin() as db:
                    saved = await self.checkpoint(db, basis, index, request, response)
            receipts.append(saved)
        return {'receipts': receipts, 'accepted_for_projection': False}
