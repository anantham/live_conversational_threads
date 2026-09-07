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
    reconciliation = await runtime.build_reconciliation(**scope).run()
    receipts = await runtime.build_aggregation(**scope).run_through()
    nodes = moments + [node for receipt in receipts for node in receipt['nodes']]
    return {'node_count': len(nodes),
            'auditable_node_count': sum(bool(n.get('utterance_ids')) for n in nodes),
            'source_review': {key: reconciliation[key] for key in (
                'review_pass_complete', 'unresolved_mappings', 'abstained_inspection_pages',
                'abstained_inspection_partitions', 'semantic_reconciliation_complete')},
            'pipeline_status': 'reconciliation_pending'}
