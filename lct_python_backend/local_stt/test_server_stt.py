"""Regression tests for the STT anti-hallucination fix (#1).

Two failure modes this guards:
  1. The repeat-loop attractor (endless "thank you"/"excuse me") — broken by
     condition_on_previous_text=False in ANTI_HALLUCINATION_OPTS.
  2. Hallucinated filler on silence/ambient — caught by the silero-vad no-speech
     gate (_has_speech returns False -> the handler returns empty instead of
     transcribing).

Run: lct_python_backend/local_stt/.venv/bin/python -m pytest test_server_stt.py -q
(Set STT_SPEECH_FIXTURE=/path/to/speech.wav to also exercise the speech-passes case;
skipped by default so CI needs no private audio.)
"""
import os
import sys
import tempfile
import wave

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import server  # noqa: E402


def _write_silence_wav(path, seconds=5.0, sr=16000):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"\x00\x00" * int(seconds * sr))


def test_anti_hallucination_opts_break_the_repeat_loop():
    # condition_on_previous_text=False is THE fix for the endless-repeat attractor;
    # if a future change flips it back on, the loop bug returns — fail here first.
    assert server.ANTI_HALLUCINATION_OPTS["condition_on_previous_text"] is False
    assert server.ANTI_HALLUCINATION_OPTS["no_speech_threshold"] >= 0.5


def test_vad_gate_finds_no_speech_in_silence():
    if server._get_vad() is None:
        pytest.skip("silero-vad unavailable in this env")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        path = f.name
    try:
        _write_silence_wav(path, seconds=5.0)
        # No voice activity -> the handler's gate returns empty instead of letting
        # the model hallucinate. _has_speech must be exactly False (not None).
        assert server._has_speech(path) is False
    finally:
        os.unlink(path)


def test_vad_gate_passes_real_speech():
    fixture = os.getenv("STT_SPEECH_FIXTURE")
    if not fixture or not os.path.exists(fixture):
        pytest.skip("set STT_SPEECH_FIXTURE to a speech wav to run this")
    if server._get_vad() is None:
        pytest.skip("silero-vad unavailable in this env")
    assert server._has_speech(fixture) is True
