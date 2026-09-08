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
