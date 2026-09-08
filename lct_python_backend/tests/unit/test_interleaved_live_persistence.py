"""Journaled live sessions must never enter legacy replacement persistence.

Exercise the real final-flush persistence entry, replacing only the durable
writer with a recorder so the regression cannot delete any actual graph.
Pump presence is lifecycle state, not the authority to choose persistence mode.
"""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from lct_python_backend.services.stt import stt_ws_session as mod


@pytest.mark.asyncio
@pytest.mark.parametrize('interleaved', [False, True])
@pytest.mark.parametrize('pump_present', [False, True])
async def test_interleaved_session_never_replaces_journal_graph(monkeypatch, pump_present, interleaved):
    session = object.__new__(mod.WsSessionContext)
    session._interleaved_runtime = object() if interleaved else None
    session._passage_pump = object() if pump_present else None
    session.state = SimpleNamespace(conversation_id='synthetic', session_id='synthetic', metadata={})
    session.graph_persist_requested = False
    session.graph_persist_task = None
    session.graph_persist_lock = asyncio.Lock()
    session.protected_node_ids = None
    session._snapshot_existing_graph = AsyncMock(return_value=([{'id': 'committed-moment'}], {}))
    session._record_observability_event = Mock()
    writes = []
    async def record_write(**kwargs):
        writes.append(kwargs)
        return 1
    monkeypatch.setattr(mod, 'persist_live_graph_snapshot', record_write)
    await session._ensure_graph_persisted(reason='final_flush')
    assert len(writes) == int(not interleaved), 'Persistence mode must not depend on pump lifecycle'


@pytest.mark.asyncio
async def test_post_flush_delivers_reviewed_snapshot_without_legacy_stages(monkeypatch):
    """Actual session finalization dispatch; DB finalizer is covered separately."""
    from lct_python_backend.services.stt import interleaved_live
    session = object.__new__(mod.WsSessionContext)
    session._interleaved_runtime = object()
    session._runtime_llm_providers = []
    session._passage_pump = SimpleNamespace(notify=Mock(), drain=AsyncMock())
    session.state = SimpleNamespace(conversation_id='synthetic', session_id='synthetic',
                                    metadata={}, store_audio=False)
    session.pending_stt_chunk_tasks = set()
    session.pending_processor_final_tasks = set()
    session.pending_partial_parts = []
    session.stt_runtime = None
    session.processor_lock = asyncio.Lock()
    session.processor = SimpleNamespace(flush=AsyncMock())
    session._clear_pending_draft_graph = AsyncMock()
    session._record_observability_event = Mock()
    session._record_durable_session_event = AsyncMock()
    session._record_stt_quota_usage = AsyncMock()
    session._mark_terminal_state = Mock()
    session._run_participant_speaker_inference = AsyncMock()
    forbidden = []
    async def legacy(**kwargs):
        forbidden.append(kwargs)
    session._run_hierarchy_consolidation_locked = legacy
    session._run_edge_enrichment_locked = legacy
    session._ensure_graph_persisted = legacy
    session._run_utterance_node_reconciliation = legacy
    delivered = []
    async def send(payload):
        delivered.append(payload)
    session.websocket = SimpleNamespace(client_state=SimpleNamespace(name='CONNECTED'), send_json=send)
    graph = [{'id': f'n{level}', 'semantic_level': level} for level in range(1, 6)]
    async def finalize(**kwargs):
        assert kwargs['config'] is session._interleaved_runtime
        assert kwargs['processor'] is session.processor
        await kwargs['send_update'](graph, {'c': 'Synthetic source'})
    monkeypatch.setattr(interleaved_live, 'finalize_live_passages', finalize)
    await session._run_post_flush_processing()
    assert forbidden == []
    assert {'type': 'existing_json', 'data': graph} in delivered
    assert {'type': 'chunk_dict', 'data': {'c': 'Synthetic source'}} in delivered
    assert not session._mark_terminal_state.called
