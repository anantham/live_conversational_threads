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


def test_short_lull_after_speech_does_not_trip_the_guard():
    """A real conversation's pauses (short trailing silence) never trip guard B."""
    guard = NoAudioGuard(warn_after_s=2.0, stop_after_s=4.0, pause_after_s=60.0)
    first = guard.observe(_speech(1.0), SAMPLE_RATE)
    assert first["forward"] is True
    assert guard.heard_speech is True
    for _ in range(10):  # 50s of trailing silence — under the 60s pause threshold
        d = guard.observe(_silence(5.0), SAMPLE_RATE)
        assert d["forward"] is True
        assert d["auto_pause"] is False
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
    guard = NoAudioGuard(enabled=False, warn_after_s=1.0, stop_after_s=2.0, pause_after_s=2.0)
    for _ in range(20):
        d = guard.observe(_silence(5.0), SAMPLE_RATE)
        assert d["forward"] is True
        assert d["warn"] is False
        assert d["stop"] is False
        assert d["auto_pause"] is False


def test_trailing_silence_after_speech_triggers_auto_pause():
    """Guard B: speech, then sustained silence -> a one-shot auto-pause signal."""
    guard = NoAudioGuard(pause_after_s=60.0)
    guard.observe(_speech(1.0), SAMPLE_RATE)
    decisions = [guard.observe(_silence(5.0), SAMPLE_RATE) for _ in range(20)]  # 100s

    auto_pauses = [d for d in decisions if d["auto_pause"]]
    assert len(auto_pauses) == 1, "auto_pause fires exactly once"
    assert auto_pauses[0]["silent_run_s"] >= 60.0
    assert decisions[-1]["forward"] is False  # forwarding halts past the pause point
    # Guard A's signals never fire once speech has been heard.
    assert all(d["warn"] is False and d["stop"] is False for d in decisions)


def test_silence_run_resets_when_speech_resumes():
    """Guard B's trailing-silence run restarts whenever real audio returns —
    intermittent speech never accumulates toward a false auto-pause."""
    guard = NoAudioGuard(pause_after_s=60.0)
    guard.observe(_speech(1.0), SAMPLE_RATE)
    for _ in range(10):  # 50s silence — just under the threshold
        assert guard.observe(_silence(5.0), SAMPLE_RATE)["auto_pause"] is False
    # A burst of speech resets the run...
    reset = guard.observe(_speech(1.0), SAMPLE_RATE)
    assert reset["silent_run_s"] == 0.0
    # ...so another 50s of silence still doesn't trip it.
    for _ in range(10):
        assert guard.observe(_silence(5.0), SAMPLE_RATE)["auto_pause"] is False
