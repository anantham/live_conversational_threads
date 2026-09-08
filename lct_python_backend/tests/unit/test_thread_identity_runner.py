"""Intent: explicit pair review is source-bound, recoverable and non-canonical.

No automatic all-pairs inference; same original IDs are still compared. Receipts
survive unrelated growth, while changed source/owner/consent rejects checkpoint.
Current export excludes stale revisions and does not expose full source snapshots.
"""
import copy
import uuid
from types import SimpleNamespace

import pytest
from services.transcript import thread_identity_runner as module


class Envelope:
    fingerprint = 'test-envelope'
    providers = [{'id': 'local'}]

    def __init__(self):
        self.calls = 0
        self.after_call = lambda: None

    def with_system_prompt(self, prompt):
        return self

    def validate(self, prompt):
        return len(prompt)

    def complete_json(self, prompt):
        import json
        request = json.loads(prompt)
        self.calls += 1
        self.after_call()
        return SimpleNamespace(data={'judgment': 'related_distinct', 'rationale': 'Different inquiries.',
            'evidence': [{'node_id': node['node_id'], 'source_id': node['source_id'],
                          'quote': node['source_excerpt']} for node in request['nodes']]})


class Store:
    def __init__(self):
        self.rows = []

    def __call__(self):
        return self

    def begin(self):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def execute(self, query):
        params = query.compile().params
        rows = [r for r in self.rows if all(
            getattr(r, key.rsplit('_', 1)[0]) == value for key, value in params.items())]
        return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: rows))

    def add(self, row):
        self.rows.append(row)

    async def flush(self):
        pass


@pytest.fixture
def setup(monkeypatch):
    state = {'nodes': [], 'chunks': {}, 'utterance_chunk_map': {}}
    rows = []
    for index, sentence in enumerate(['Who pays hosting?', 'How will staffing work?', 'What about training?']):
        nid, cid, uid = f'n{index}', f'c{index}', f'u{index}'
        state['nodes'].append({'id': nid, 'chunk_id': cid, 'summary': sentence,
            'source_excerpt': sentence, 'thread_id': 'same-provisional-id', 'thread_label': 'Funding'})
        state['chunks'][cid] = sentence
        state['utterance_chunk_map'][cid] = [uid]
        rows.append({'id': uid, 'text': sentence, 'sequence_number': index + 1,
                     'speaker_id': 'SPEAKER_00'})
    basis = {'state': state, 'source': {'request': {'sources': rows}}}
    permissions = {'allowed': True}
    async def capture(db, **kwargs):
        return copy.deepcopy(basis)
    async def consent(db, *args, **kwargs):
        if not permissions['allowed']:
            raise PermissionError('Owner/consent no longer permitted')
    monkeypatch.setattr(module, 'capture_question_basis', capture)
    monkeypatch.setattr(module, 'check_inference_consent', consent)
    monkeypatch.setattr(module, '_authorized_conversation', consent)
    store, envelope = Store(), Envelope()
    runner = module.ThreadIdentityRunner(session_factory=store, conversation_id=str(uuid.uuid4()),
                                          owner_id='owner', envelope=envelope)
    return runner, store, envelope, basis, permissions


@pytest.mark.asyncio
async def test_explicit_same_id_pair_recovery_and_honest_coverage(setup):
    runner, store, envelope, basis, _ = setup
    result = await runner.run([('n1', 'n0')])
    assert result['reviewed_pair_count'] == 1
    assert result['possible_pair_count'] == 3
    assert result['coverage_complete'] is False
    assert result['annotations'][0]['judgment'] == 'related_distinct'
    assert result['accepted_for_projection'] is False
    assert envelope.calls == 1
    await runner.run([('n0', 'n1')])
    assert envelope.calls == 1 and len(store.rows) == 1
    assert {n['thread_id'] for n in basis['state']['nodes']} == {'same-provisional-id'}


@pytest.mark.asyncio
async def test_unrelated_growth_reuses_pair_and_source_change_supersedes(setup):
    runner, store, envelope, basis, _ = setup
    await runner.run([('n0', 'n1')])
    basis['state']['nodes'][2]['summary'] = 'An unrelated revised interpretation.'
    await runner.run([('n0', 'n1')])
    assert envelope.calls == 1
    basis['source']['request']['sources'][0]['speaker_id'] = 'corrected-speaker'
    exported = await module.export_thread_identity_reviews(store, **runner.scope)
    assert exported['superseded_review_count'] == 1
    assert not exported['policies']
    await runner.run([('n0', 'n1')])
    assert len(store.rows) == 2 and envelope.calls == 2
    exported = await module.export_thread_identity_reviews(store, **runner.scope)
    assert exported['superseded_review_count'] == 1
    projected_sources = exported['policies'][0]['annotations'][0]['sources']
    assert len(projected_sources) == 2
    assert {s['chunk_id'] for s in projected_sources} == {'c0', 'c1'}
    assert all('u2' not in s['utterance_ids'] for s in projected_sources)


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['source', 'permission'])
async def test_changes_during_inference_cannot_commit(setup, change):
    runner, store, envelope, basis, permissions = setup
    def mutate():
        if change == 'source':
            basis['source']['request']['sources'][0]['text'] = 'Changed original source.'
        else:
            permissions['allowed'] = False
    envelope.after_call = mutate
    with pytest.raises((module.JournalConflict, PermissionError)):
        await runner.run([('n0', 'n1')])
    assert store.rows == []


@pytest.mark.asyncio
async def test_empty_candidates_do_not_infer_or_claim_coverage(setup):
    runner, store, envelope, _, _ = setup
    result = await runner.run([])
    assert envelope.calls == 0 and store.rows == []
    assert result['candidate_pair_count'] == 0
    assert result['possible_pair_count'] == 3
    assert not result['coverage_complete']


@pytest.mark.asyncio
async def test_unknown_candidate_fails_before_any_generation(setup):
    runner, store, envelope, _, _ = setup
    with pytest.raises(ValueError, match='unavailable'):
        await runner.run([('n0', 'n1'), ('n0', 'unknown')])
    assert envelope.calls == 0 and store.rows == []


@pytest.mark.asyncio
async def test_distinct_candidate_policies_do_not_share_receipts(setup):
    runner, store, envelope, _, _ = setup
    await runner.run([('n0', 'n1')])
    other = module.ThreadIdentityRunner(session_factory=store, **runner.scope, envelope=envelope,
                                         candidate_policy_id='revised-selection-v2')
    result = await other.run([('n0', 'n1')])
    assert envelope.calls == 2 and len(store.rows) == 2
    assert result['policy_fingerprint'] != runner.fingerprint
    exported = await module.export_thread_identity_reviews(store, **runner.scope)
    assert len(exported['policies']) == 2


@pytest.mark.asyncio
async def test_wrong_owner_or_revoked_permission_blocks_recovery_and_export(setup):
    runner, store, envelope, _, permissions = setup
    await runner.run([('n0', 'n1')])
    permissions['allowed'] = False
    with pytest.raises(PermissionError):
        await runner.run([('n0', 'n1')])
    with pytest.raises(PermissionError):
        await module.export_thread_identity_reviews(store, **runner.scope)
    assert envelope.calls == 1 and len(store.rows) == 1


@pytest.mark.asyncio
async def test_saved_digest_cannot_hide_inconsistent_request(setup):
    runner, store, envelope, _, _ = setup
    await runner.run([('n0', 'n1')])
    store.rows[0].artifact_json['request']['sources'][0]['text'] = 'Fabricated stored request'
    store.rows[0].content_hash = module._hash(store.rows[0].artifact_json)
    with pytest.raises(module.JournalConflict, match='request'):
        await runner.run([('n0', 'n1')])
    assert envelope.calls == 1
