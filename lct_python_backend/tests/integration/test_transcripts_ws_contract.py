"""Contract-level tests for the /ws/transcripts WebSocket protocol.

These tests verify the external message contract (types, shapes, error
conditions) without depending on internal implementation details. They
should survive ADR-017 decomposition as long as the /ws/transcripts
endpoint preserves its message protocol.

Test intent:
- A quota denial is a terminal protocol result, never a warning followed by
  ``session_ack``.
- Ordinary allowed sessions retain the established acknowledgement contract.

Complements the existing test_transcripts_websocket.py happy-path tests.
"""

import time
import uuid

import pytest
from starlette.websockets import WebSocketDisconnect

from lct_python_backend.tests.integration.transcripts_test_support import (
    build_processor_class,
    build_test_client,
    pcm_audio_base64,
    receive_session_ack,
    receive_until_type,
)


# ---------------------------------------------------------------------------
# 1. Missing conversation_id → error
# ---------------------------------------------------------------------------


def test_session_meta_missing_conversation_id_returns_error(monkeypatch):
    """session_meta without conversation_id must return an error message."""
    client = build_test_client(monkeypatch)

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json({"type": "session_meta", "session_id": "no-conv"})
        msg = ws.receive_json()

    assert msg["type"] == "error"
    assert "conversation_id" in msg["detail"].lower()


# ---------------------------------------------------------------------------
# 2. audio_chunk before session_meta → error
# ---------------------------------------------------------------------------


def test_audio_chunk_before_session_meta_returns_error(monkeypatch):
    """Sending audio_chunk without prior session_meta must return an error."""
    client = build_test_client(monkeypatch)

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {"type": "audio_chunk", "audio_base64": pcm_audio_base64(0.1)}
        )
        msg = ws.receive_json()

    assert msg["type"] == "error"
    assert "session_meta" in msg["detail"].lower()


# ---------------------------------------------------------------------------
# 3. transcript_final before session_meta → error
# ---------------------------------------------------------------------------


def test_transcript_final_before_session_meta_returns_error(monkeypatch):
    """Sending transcript_final without prior session_meta must return error."""
    client = build_test_client(monkeypatch)

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json({"type": "transcript_final", "text": "hello"})
        msg = ws.receive_json()

    assert msg["type"] == "error"
    assert "session_meta" in msg["detail"].lower()


# ---------------------------------------------------------------------------
# 4. audio_chunk after final_flush → warning (not error)
# ---------------------------------------------------------------------------


def test_audio_chunk_after_final_flush_returns_warning(monkeypatch):
    """Audio arriving after final_flush should produce a warning, not error.

    The connection must stay open (not crash), and the warning should be
    a processing_status with level=warning.
    """
    processor_calls = {"final": [], "flush": 0}
    client = build_test_client(
        monkeypatch,
        processor_cls=build_processor_class(processor_calls),
    )

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = receive_session_ack(ws)
        assert ack["type"] == "session_ack"

        ws.send_json({"type": "final_flush"})
        flush_ack = ws.receive_json()
        assert flush_ack["type"] == "flush_ack"

        # Send audio after flush — should get warning
        ws.send_json(
            {"type": "audio_chunk", "audio_base64": pcm_audio_base64(0.1)}
        )
        msg = receive_until_type(ws, "processing_status")

    assert msg["type"] == "processing_status"
    assert msg["level"] == "warning"
    assert "final_flush" in msg["message"].lower() or "ignore" in msg["message"].lower()


# ---------------------------------------------------------------------------
# 5. stt_provider_error when STT not ready
# ---------------------------------------------------------------------------


def test_audio_chunk_with_no_stt_url_returns_provider_error(monkeypatch):
    """When no STT HTTP URL is configured, audio_chunk should return
    stt_provider_error (at most once per session).
    """
    processor_calls = {"final": [], "flush": 0}
    client = build_test_client(
        monkeypatch,
        stt_settings={
            "provider": "whisper",
            "provider_http_urls": {},
            "http_url": "",
        },
        processor_cls=build_processor_class(processor_calls),
    )

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = receive_session_ack(ws)
        assert ack["type"] == "session_ack"
        assert ack["stt_ready"] is False

        # First audio chunk → should get provider error
        ws.send_json(
            {"type": "audio_chunk", "audio_base64": pcm_audio_base64(0.1)}
        )
        msg = ws.receive_json()
        assert msg["type"] == "stt_provider_error"

        # Second audio chunk → error should NOT repeat (stt_unready_notified flag)
        ws.send_json(
            {"type": "audio_chunk", "audio_base64": pcm_audio_base64(0.1)}
        )

        # Send ping to verify connection is still alive and no error queued
        ws.send_json({"type": "ping", "client_ts_ms": 42})
        pong = ws.receive_json()
        assert pong["type"] == "pong"


# ---------------------------------------------------------------------------
# 6. session_meta re-send resets session
# ---------------------------------------------------------------------------


def test_session_meta_resend_resets_state(monkeypatch):
    """Sending session_meta a second time should reset session state and
    produce a new session_ack. The new conversation_id should be used.
    """
    processor_calls = {"final": [], "flush": 0}
    client = build_test_client(
        monkeypatch,
        processor_cls=build_processor_class(processor_calls),
    )

    conv1 = str(uuid.uuid4())
    conv2 = str(uuid.uuid4())

    with client.websocket_connect("/ws/transcripts") as ws:
        # First session
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": conv1,
                "session_id": "s1",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack1 = receive_session_ack(ws)
        assert ack1["type"] == "session_ack"
        assert ack1["conversation_id"] == conv1
        assert ack1["session_id"] == "s1"

        # Second session on same connection
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": conv2,
                "session_id": "s2",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack2 = receive_session_ack(ws)
        assert ack2["type"] == "session_ack"
        assert ack2["conversation_id"] == conv2
        assert ack2["session_id"] == "s2"


# ---------------------------------------------------------------------------
# 7. client_log → no response
# ---------------------------------------------------------------------------


def test_client_log_produces_no_response(monkeypatch):
    """client_log should be accepted silently — no message sent back.

    We verify by sending a ping after and confirming the next message
    received is the pong (not a response to client_log).
    """
    client = build_test_client(monkeypatch)

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = receive_session_ack(ws)
        assert ack["type"] == "session_ack"

        ws.send_json({"type": "client_log", "message": "test log entry"})
        ws.send_json({"type": "ping", "client_ts_ms": 99})
        msg = ws.receive_json()

    assert msg["type"] == "pong"
    assert msg["client_ts_ms"] == 99


# ---------------------------------------------------------------------------
# 8. ping works without session_meta
# ---------------------------------------------------------------------------


def test_ping_works_without_session_meta(monkeypatch):
    """ping/pong should work even before session_meta is sent."""
    client = build_test_client(monkeypatch)

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json({"type": "ping", "client_ts_ms": 777})
        pong = ws.receive_json()

    assert pong["type"] == "pong"
    assert pong["client_ts_ms"] == 777
    assert isinstance(pong["server_ts_ms"], int)


# ---------------------------------------------------------------------------
# 9. Unknown message type → structured error, connection remains usable
# ---------------------------------------------------------------------------


def test_unknown_message_type_returns_structured_error_and_session_stays_alive(monkeypatch):
    """Unknown message types fail explicitly without killing the session."""
    client = build_test_client(monkeypatch)

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = receive_session_ack(ws)
        assert ack["type"] == "session_ack"

        ws.send_json({"type": "nonexistent_type", "data": "hello"})
        error = ws.receive_json()
        assert error["type"] == "error"
        assert error["code"] == "unsupported_message_type"
        assert error["context"]["received_message_type"] == "nonexistent_type"

        ws.send_json({"type": "ping", "client_ts_ms": 1})
        msg = receive_until_type(ws, "pong")

    assert msg["type"] == "pong"


# ---------------------------------------------------------------------------
# 10. session_ack shape validation
# ---------------------------------------------------------------------------


def test_session_ack_has_required_fields(monkeypatch):
    """session_ack must include all contract-required fields."""
    client = build_test_client(monkeypatch)

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "session_id": "shape-test",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = receive_session_ack(ws)

    assert ack["type"] == "session_ack"
    required_fields = [
        "conversation_id",
        "session_id",
        "store_audio",
        "provider",
        "transport",
        "model",
        "model_source",
        "supports_diarization",
        "degraded",
        "stt_mode",
        "stt_ready",
        "fallback_candidates",
    ]
    for field in required_fields:
        assert field in ack, f"session_ack missing required field: {field}"

    assert isinstance(ack["fallback_candidates"], list)
    assert isinstance(ack["stt_ready"], bool)
    assert isinstance(ack["store_audio"], bool)


def test_session_meta_quota_denial_returns_terminal_error_without_ack(monkeypatch):
    """A denied free-tier session must close before accepting live audio."""
    denied = type(
        "DeniedQuota",
        (),
        {
            "allowed": False,
            "remaining_minutes": 0.0,
            "limit_minutes": 10.0,
            "percent_used": 100.0,
            "warning": True,
            "message": "Daily quota exceeded (10 min limit).",
        },
    )()
    client = build_test_client(monkeypatch, quota_result=denied)

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "session_id": "quota-denied",
                "provider": "whisper",
                "store_audio": False,
            }
        )
        rejection = ws.receive_json()
        assert rejection["type"] == "quota_exceeded"
        assert rejection["code"] == "daily_stt_quota_exceeded"
        assert rejection["fatal"] is True
        assert rejection["context"]["quota"]["quota_allowed"] is False

        with pytest.raises(WebSocketDisconnect) as disconnect:
            ws.receive_json()

    assert disconnect.value.code == 1008


# ---------------------------------------------------------------------------
# 11. flush_ack shape validation
# ---------------------------------------------------------------------------


def test_flush_ack_has_telemetry(monkeypatch):
    """flush_ack must include telemetry dict with timing info."""
    processor_calls = {"final": [], "flush": 0}
    client = build_test_client(
        monkeypatch,
        processor_cls=build_processor_class(processor_calls),
    )

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = receive_session_ack(ws)
        assert ack["type"] == "session_ack"

        ws.send_json({"type": "final_flush"})
        flush_ack = receive_until_type(ws, "flush_ack")

    assert flush_ack["type"] == "flush_ack"
    assert "telemetry" in flush_ack
    assert isinstance(flush_ack["telemetry"], dict)


# ---------------------------------------------------------------------------
# 12. Empty text in transcript_partial → silently skipped
# ---------------------------------------------------------------------------


def test_transcript_partial_empty_text_skipped(monkeypatch):
    """transcript_partial with empty text should be silently skipped,
    not persisted, and not produce an error.
    """
    persisted = []

    async def fake_persist(_session, _state, payload, event_type, text):
        persisted.append((event_type, text))

    processor_calls = {"final": [], "flush": 0}
    client = build_test_client(
        monkeypatch,
        processor_cls=build_processor_class(processor_calls),
        persist_side_effect=fake_persist,
    )

    with client.websocket_connect("/ws/transcripts") as ws:
        ws.send_json(
            {
                "type": "session_meta",
                "conversation_id": str(uuid.uuid4()),
                "provider": "whisper",
                "store_audio": False,
            }
        )
        ack = receive_session_ack(ws)
        assert ack["type"] == "session_ack"

        ws.send_json({"type": "transcript_partial", "text": ""})
        ws.send_json({"type": "transcript_partial", "text": "real text"})
        ws.send_json({"type": "final_flush"})
        flush_ack = receive_until_type(ws, "flush_ack")
        assert flush_ack["type"] == "flush_ack"

    time.sleep(0.05)
    # Only "real text" should have been persisted
    assert len(persisted) == 1
    assert persisted[0] == ("partial", "real text")
