"""Shared opt-in stage composition for persisted imports and controlled replays.

Callers resolve owner and commit original source first. Each stage independently
checks current stored consent and source identity. No host settings are mutated.
"""


async def run_interleaved_stages(*, runtime, conversation_id, owner_id, providers, privacy, utterances):
    async def noop(*args, **kwargs):
        pass

    scope = dict(conversation_id=conversation_id, owner_id=owner_id, providers=providers, privacy=privacy)
    processor = runtime.build(**scope, send_update=noop, send_status=None)
    for utterance in utterances:
        await processor.handle_final_text(utterance['text'],
            speaker_segments=[{'speaker': utterance['speaker_id'], 'text': utterance['text']}],
            utterance_id=utterance['id'])
    await processor.flush()
    moments = list(processor.existing_json)
    return await run_interleaved_final_stages(runtime=runtime, moments=moments,
        chunks=processor.chunk_dict, **scope)


async def run_interleaved_final_stages(*, runtime, conversation_id, owner_id,
                                     providers, privacy, moments, chunks):
    """Finalize committed moments identically for persisted imports and live audio."""
    scope = dict(conversation_id=conversation_id, owner_id=owner_id, providers=providers, privacy=privacy)
    from lct_python_backend.services.transcript.thread_identity_context import identity_candidates
    identity = await runtime.build_thread_identity(**scope).run(
        identity_candidates(moments, chunks))
    reconciliation = await runtime.build_reconciliation(**scope).run()
    receipts = await runtime.build_aggregation(**scope).run_through()
    questions = await runtime.build_question_review(**scope).run()
    nodes = moments + [node for receipt in receipts for node in receipt['nodes']]
    return {'node_count': len(nodes),
            'thread_identity_review': {key: identity[key] for key in (
                'candidate_pair_count', 'reviewed_pair_count', 'possible_pair_count', 'coverage_complete')},
            'auditable_node_count': sum(bool(n.get('utterance_ids')) for n in nodes),
            'question_review': {
                'reviewed_count': len(questions['projections']),
                'uncertain_count': sum(bool(q['unresolved_events']) or q['reviewed_status'] == 'uncertain'
                                       for q in questions['projections']),
                'verification': 'model_reviewed_not_human_verified'},
            'source_review': {key: reconciliation[key] for key in (
                'review_pass_complete', 'unresolved_mappings', 'abstained_inspection_pages',
                'abstained_inspection_partitions', 'semantic_reconciliation_complete')},
            'pipeline_status': 'reconciliation_pending'}
