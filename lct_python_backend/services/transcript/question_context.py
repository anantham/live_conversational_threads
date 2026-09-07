"""Current, policy-bound review annotations for the next processing passage.

The caller's committed history must match the authorized database projection.
Reviews are model judgments, not replacement events or human acceptance.
"""
from .question_review_export import export_question_reviews


class QuestionContextReader:
    def __init__(self, runner):
        self.runner = runner

    async def __call__(self, nodes, chunks, mapping):
        # Run uses durable question-local receipts; unchanged questions do not
        # repeat inference. Requests only use committed question source passages.
        await self.runner.run()
        expected = {'nodes': nodes, 'chunks': chunks, 'utterance_chunk_map': mapping}
        async with self.runner.sessions() as db:
            exported = await export_question_reviews(db, **self.runner.scope, expected_state=expected)
        selected = [policy for policy in exported['policies']
                    if policy['policy_fingerprint'] == self.runner.envelope.fingerprint
                    and policy['revision_scope'] == 'question_v1']
        if len(selected) > 1:
            raise ValueError('Multiple current question context policies')
        return {q['question_id']: q for q in selected[0]['questions']} if selected else {}
