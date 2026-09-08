"""One budgeted regeneration for an unknown question, without changing evidence.

Test intent: preserve source/history and question identities; require a real
opening; recheck consent before/after each inference; never retry transport,
budget, provenance or historical-state errors. Failed candidates never commit.
"""
import asyncio
import json
import uuid

from .question_evidence import attach_question_evidence
from .question_memory import UnknownQuestionUpdate, fold_question_memory

RECOVERY_POLICY = 'unknown_question_regeneration_once_v1'


async def generate_with_question_recovery(*, envelope, prompt, existing_nodes,
                                         chunks, passage, fragments, guard=None,
                                         on_retry=None, **generation_kwargs):
    # A corrupt historical projection is not something a model may repair.
    fold_question_memory(existing_nodes, chunks)
    required_ids = set()
    request = prompt
    for attempt in range(2):
        envelope.validate(request)
        if guard is not None:
            await guard()
        nodes, backend = await asyncio.to_thread(envelope.generate, request, **generation_kwargs)
        if guard is not None:
            await guard()
        grounded = attach_question_evidence(nodes, passage, fragments)
        identities = {update['question_id'] for node in grounded
                      for update in node.get('question_updates', [])}
        if not required_ids.issubset(identities):
            raise ValueError('Question recovery dropped a previously proposed question identity')
        chunk_id = str(uuid.uuid4())
        try:
            fold_question_memory(existing_nodes + [{**n, 'chunk_id': chunk_id} for n in grounded],
                                 {**chunks, chunk_id: passage})
        except UnknownQuestionUpdate as error:
            if attempt:
                raise
            required_ids = identities
            payload = json.loads(prompt)
            payload['validation_feedback'] = {
                'error': 'Question update refers to an unknown question',
                'unknown_question_id': error.question_id,
                'preserve_question_ids': sorted(required_ids),
                'instruction': (
                    'Regenerate the complete moments from the unchanged source and memory. '
                    'A new question requires an explicit source-backed open event before '
                    'its answer or other updates. Preserve all proposed question identities, '
                    'questions, answers, deferrals and uncertainty. Do not invent earlier '
                    'events or delete questions to pass validation. If the source does not '
                    'support an opening, do not fabricate one.'),
            }
            request = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
            # Fail before notification or another call if feedback cannot fit.
            envelope.validate(request)
            if on_retry is not None:
                await on_retry()
        else:
            return nodes, backend
