"""Intent: save exact public replay requests before inference, even on failure.

Failure must propagate unchanged; exception strings may contain credentials and
must not be copied into receipts. Success retains serving and usage evidence.
"""
import json
from types import SimpleNamespace
import pytest
from tools.public_replay_harness import record_inference


@pytest.mark.parametrize('fail', [False, True])
def test_request_is_saved_before_call_and_result_is_separate(tmp_path, fail):
    envelope = SimpleNamespace(_messages=lambda prompt: [{'role': 'user', 'content': prompt}],
        fingerprint='p', tokenizer_id='t', providers=[{'model': 'm'}])
    response = SimpleNamespace(data={'ok': True}, model='m', cache_hit=False,
        prompt_tokens=3, completion_tokens=2, finish_reason='stop')
    error = RuntimeError('secret must not be logged')
    def invoke(env, prompt):
        saved = list(tmp_path.glob('*/request.json'))
        assert len(saved) == 1
        assert json.loads(saved[0].read_text())['messages'][0]['content'] == ' exact\n'
        if fail:
            raise error
        return response
    if fail:
        with pytest.raises(RuntimeError) as caught:
            record_inference(tmp_path, envelope, ' exact\n', invoke)
        assert caught.value is error
        result = json.loads(next(tmp_path.glob('*/failure.json')).read_text())
        assert result == {'status': 'failed', 'error_type': 'RuntimeError'}
        assert not list(tmp_path.glob('*/response.json'))
    else:
        assert record_inference(tmp_path, envelope, ' exact\n', invoke) is response
        result = json.loads(next(tmp_path.glob('*/response.json')).read_text())
        assert result['prompt_tokens'] == 3
        assert result['cache_hit'] is False
