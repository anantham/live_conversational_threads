"""Test intent: retain exact prompt bytes and distinguish cached serving evidence.

Synthetic only: receipt generation must neither invoke a model nor read a DB.
Missing usage must remain missing rather than becoming a false zero-token result.
"""
import json
from types import SimpleNamespace

import pytest

from tools.probe_canonical_selection import RELATION_PROMPT, probe_receipt


@pytest.mark.parametrize('cached,usage', [(False, 123), (True, None)])
def test_receipt_preserves_prompt_and_actual_serving_telemetry(cached, usage):
    request = {'text': 'Quoted "source"\nUnicode: café'}
    result = SimpleNamespace(data={'comparisons': []}, model='served-revision',
        cache_hit=cached, finish_reason='stop', prompt_tokens=usage, completion_tokens=17)
    receipt = probe_receipt(request, result, 'frozen-policy')
    assert receipt['messages'] == [
        {'role': 'system', 'content': RELATION_PROMPT},
        {'role': 'user', 'content': json.dumps(request, ensure_ascii=False, separators=(',', ':'))}]
    assert receipt['cache_hit'] is cached
    assert receipt['prompt_tokens'] == usage
    assert receipt['served_model'] == 'served-revision'
    assert receipt['policy_fingerprint'] == 'frozen-policy'
    assert receipt['reasoning_effort'] == 'none'
    assert receipt['finish_reason'] == 'stop'
