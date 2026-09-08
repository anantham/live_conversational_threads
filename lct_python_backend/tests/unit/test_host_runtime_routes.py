"""Intent: real HTTP/WS routing uses only host-owned runtime configuration.

Request/query fields cannot opt in, change consent, or replace the runtime.
Observe the selected configuration through endpoint results; invalid host state
fails rather than silently falling back. No model, database or STT calls occur.
"""
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from lct_python_backend.services.transcript.interleaved_runtime import InterleavedRuntimeConfig


def host_config():
    return InterleavedRuntimeConfig(lambda: None, {'synthetic': 32768}, ('synthetic',))


@pytest.mark.parametrize('configured', [False, True])
def test_http_extract_uses_host_not_payload(monkeypatch, configured):
    from lct_python_backend import import_api
    app = FastAPI()
    app.include_router(import_api.router)
    config = host_config()
    if configured:
        app.state.interleaved_runtime = config

    async def session():
        yield object()
    app.dependency_overrides[import_api.get_async_session] = session

    async def extract(db, **kwargs):
        assert kwargs.get('interleaved_runtime') is (config if configured else None)
        return dict(conversation_id='00000000-0000-0000-0000-000000000001',
                    utterance_count=1, node_count=2 if configured else 1, auditable_node_count=1)
    monkeypatch.setattr(import_api, 'extract_graph_for_conversation', extract)
    with TestClient(app) as client:
        response = client.post('/api/import/turns/extract?interleaved_runtime=attacker', json={
            'conversation_id': '00000000-0000-0000-0000-000000000001',
            'interleaved_runtime': {'external_llm_ok': True}})
    assert response.status_code == 200, response.text
    assert response.json()['node_count'] == (2 if configured else 1)


@pytest.mark.parametrize('configured', [False, True])
def test_websocket_uses_host_not_query(monkeypatch, configured):
    from lct_python_backend import stt_api
    app = FastAPI()
    app.include_router(stt_api.router)
    config = host_config()
    if configured:
        app.state.interleaved_runtime = config
    @asynccontextmanager
    async def session():
        yield object()
    monkeypatch.setattr(stt_api, 'get_async_session_context', session)
    monkeypatch.setattr(stt_api, 'check_ws_auth_message', AsyncMock(return_value=True))
    monkeypatch.setattr(stt_api, 'load_llm_config', AsyncMock(return_value={}))
    monkeypatch.setattr(stt_api, '_load_llm_providers', AsyncMock(return_value=[]))
    class Session:
        def __init__(self, **kwargs):
            self.websocket = kwargs['websocket']
            self.runtime = kwargs['interleaved_runtime']
        async def run(self):
            assert self.runtime is (config if configured else None)
            await self.websocket.send_json({'host_runtime_selected': self.runtime is config})
    monkeypatch.setattr(stt_api, 'WsSessionContext', Session)
    with TestClient(app) as client:
        with client.websocket_connect('/ws/transcripts?interleaved_runtime=attacker') as ws:
            assert ws.receive_json() == {'host_runtime_selected': configured}


def test_invalid_host_configuration_rejected():
    from starlette.requests import Request
    from lct_python_backend.services.transcript.host_runtime import runtime_for_connection
    app = FastAPI()
    app.state.interleaved_runtime = {'external_llm_ok': True}
    with pytest.raises(RuntimeError, match='Host interleaved runtime'):
        runtime_for_connection(Request({'type': 'http', 'app': app}))
