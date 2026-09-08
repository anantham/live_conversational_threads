"""Test intent: accept completed JSON only; reject tool use/failure/truncation.
No cloud calls or credentials in these synthetic parser tests.
"""
import json
import pytest
from tools.public_frontier_transport import parse_events, complete_public_json


def events(item_type='agent_message', message='{"nodes":[]}'):
    return '\n'.join(map(json.dumps, [
        {'type': 'item.completed', 'item': {'type': item_type, 'text': message}},
        {'type': 'turn.completed', 'usage': {'input_tokens': 12, 'output_tokens': 4}},
    ]))


def test_completed_object_and_usage():
    data, usage = parse_events(events())
    assert data == {'nodes': []}
    assert usage['input_tokens'] == 12


@pytest.mark.parametrize('item', ['command_execution', 'mcp_tool_call', 'file_change', 'unknown'])
def test_tool_use_or_unknown_items_are_not_accepted(item):
    with pytest.raises(ValueError):
        parse_events(events(item_type=item))


@pytest.mark.parametrize('message', ['[]', '```json\n{}\n```', '{'])
def test_non_object_or_invalid_json_rejected(message):
    with pytest.raises(ValueError):
        parse_events(events(message=message))


def test_missing_completed_turn_rejected():
    with pytest.raises(ValueError):
        parse_events(events().splitlines()[0])


def test_failure_after_message_rejected():
    with pytest.raises(ValueError):
        parse_events(events() + '\n' + json.dumps({'type': 'turn.failed'}))


def test_local_only_policy_blocks_transport_before_subprocess_or_file_write(monkeypatch, tmp_path):
    from lct_python_backend.services.egress_guard import CloudEgressBlocked
    monkeypatch.setenv('LCT_LOCAL_ONLY', '1')
    monkeypatch.delenv('LCT_LOCAL_ONLY_ALLOW_HOSTS', raising=False)
    def forbidden(*args, **kwargs):
        raise AssertionError('Must not invoke an external process')
    monkeypatch.setattr('tools.public_frontier_transport.subprocess.run', forbidden)
    target = tmp_path / 'receipt'
    with pytest.raises(CloudEgressBlocked):
        complete_public_json([{'role': 'user', 'content': 'synthetic'}], target)
    assert not target.exists()
