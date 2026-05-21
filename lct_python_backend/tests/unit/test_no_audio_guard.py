"""Tests for the live-STT no-audio guard."""

from __future__ import annotations

import struct

from lct_python_backend.services.no_audio_guard import NoAudioGuard, chunk_rms

SAMPLE_RATE = 16000


def _silence(seconds: float) -> bytes:
    """A PCM16 buffer of pure digital silence."""
    return b"\x00\x00" * int(SAMPLE_RATE * seconds)


def _speech(seconds: float, amplitude: int = 6000) -> bytes:
    """A PCM16 buffer at a constant amplitude — RMS == amplitude, well above
    any plausible silence threshold."""
    return struct.pack("<h", amplitude) * int(SAMPLE_RATE * seconds)


def test_chunk_rms_is_zero_for_silence():
    assert chunk_rms(_silence(0.5)) == 0.0
    assert chunk_rms(b"") == 0.0
    assert chunk_rms(b"\x00") == 0.0  # odd / too-short input


def test_chunk_rms_matches_constant_amplitude():
    assert abs(chunk_rms(_speech(0.5, amplitude=4000)) - 4000.0) < 1.0


def test_guard_warns_then_halts_on_a_silent_session():
    guard = NoAudioGuard(warn_after_s=20.0, stop_after_s=60.0)
    # 20 chunks x 5s = 100s of pure silence.
    decisions = [guard.observe(_silence(5.0), SAMPLE_RATE) for _ in range(20)]

    warns = [d for d in decisions if d["warn"]]
    stops = [d for d in decisions if d["stop"]]
    assert len(warns) == 1, "warn fires exactly once"
    assert len(stops) == 1, "stop fires exactly once"
    assert warns[0]["silent_run_s"] >= 20.0
    assert stops[0]["silent_run_s"] >= 60.0
    # Early chunks are still forwarded (slow-start grace); forwarding then
    # halts once the session is clearly dead, and stays halted.
    assert decisions[0]["forward"] is True
    assert decisions[-1]["forward"] is False


def test_guard_is_dormant_once_speech_is_heard():
    guard = NoAudioGuard(warn_after_s=2.0, stop_after_s=4.0)
    first = guard.observe(_speech(1.0), SAMPLE_RATE)
    assert first["forward"] is True
    assert guard.heard_speech is True
    # A real recording with long pauses must never trip the guard.
    for _ in range(20):  # 100s of silence after speech
        d = guard.observe(_silence(5.0), SAMPLE_RATE)
        assert d["forward"] is True
        assert d["warn"] is False
        assert d["stop"] is False


def test_guard_recovers_if_audio_appears_after_silence():
    guard = NoAudioGuard(warn_after_s=2.0, stop_after_s=4.0)
    for _ in range(3):  # 6s of silence > 4s stop threshold
        guard.observe(_silence(2.0), SAMPLE_RATE)
    assert guard.observe(_silence(2.0), SAMPLE_RATE)["forward"] is False
    # Mic comes back — the guard disengages and stays dormant.
    assert guard.observe(_speech(1.0), SAMPLE_RATE)["forward"] is True
    assert guard.observe(_silence(10.0), SAMPLE_RATE)["forward"] is True


def test_disabled_guard_always_forwards():
    guard = NoAudioGuard(enabled=False, warn_after_s=1.0, stop_after_s=2.0)
    for _ in range(20):
        d = guard.observe(_silence(5.0), SAMPLE_RATE)
        assert d["forward"] is True
        assert d["warn"] is False
        assert d["stop"] is False
