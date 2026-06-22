"""Unit tests for the Attendee meeting-bot bridge + webhook receiver.

No DB / network: exercises the pure mapping, signing, dedupe and registry logic.
Async bits run inside a single asyncio.run() per test so the Locks/Events bind
to one loop.
"""

import asyncio
import base64
import hashlib
import hmac
import json

import pytest

from lct_python_backend import attendee_api
from lct_python_backend.services import attendee_bridge


class _FakeWS:
    """Captures frames the bridge sends over the loopback producer."""

    def __init__(self):
        self.sent = []

    async def send(self, payload):
        self.sent.append(json.loads(payload))

    async def close(self):
        pass


class _FakeRequest:
    def __init__(self, payload, headers=None):
        self._payload = json.dumps(payload).encode("utf-8")
        self.headers = headers or {}

    async def body(self):
        return self._payload


# --- transcript mapping -----------------------------------------------------

def test_inject_utterance_maps_to_transcript_final():
    async def _run():
        sess = attendee_bridge.MeetingSession(
            conversation_id="c1",
            meeting_url="https://meet.google.com/abc-defg-hij",
            bot_name="LCT",
        )
        sess._ws = _FakeWS()
        # Anchor the recording at epoch 0; Attendee sends ABSOLUTE epoch-ms, so an
        # utterance at ts=12000ms persists as 12.0s relative to the anchor.
        sess._rec_anchor_epoch_ms = 0.0
        await sess.inject_utterance(
            text="  Hello world  ",
            speaker_name="Jane Doe",
            speaker_uuid="user1",
            speaker_is_host=True,
            timestamp_ms=12000,
            duration_ms=800,
        )
        return sess._ws.sent

    sent = asyncio.run(_run())
    assert len(sent) == 1
    frame = sent[0]
    assert frame["type"] == "transcript_final"
    assert frame["text"] == "Hello world"  # trimmed
    assert frame["metadata"]["speaker_name"] == "Jane Doe"
    assert frame["metadata"]["speaker_uuid"] == "user1"
    assert frame["metadata"]["speaker_source"] == "attendee"
    # Raw absolute epoch-ms preserved verbatim (A3).
    assert frame["metadata"]["source_timestamp_ms"] == 12000
    # epoch-ms anchored on recording start (epoch 0) -> 12.0s; end = start + dur
    assert frame["timestamps"]["start"] == pytest.approx(12.0)
    assert frame["timestamps"]["end"] == pytest.approx(12.8)


def test_inject_utterance_skips_empty_and_when_finalizing():
    async def _run():
        sess = attendee_bridge.MeetingSession(conversation_id="c1", meeting_url="u", bot_name="b")
        sess._ws = _FakeWS()
        await sess.inject_utterance(text="   ", speaker_name="x")  # empty -> skipped
        sess._finalizing = True
        await sess.inject_utterance(text="real", speaker_name="x")  # finalizing -> skipped
        return sess._ws.sent

    assert asyncio.run(_run()) == []


def test_inject_utterance_without_timestamps():
    async def _run():
        sess = attendee_bridge.MeetingSession(conversation_id="c1", meeting_url="u", bot_name="b")
        sess._ws = _FakeWS()
        await sess.inject_utterance(text="hi", speaker_name=None)
        return sess._ws.sent

    sent = asyncio.run(_run())
    assert sent[0]["timestamps"] == {}
    assert sent[0]["metadata"]["speaker_name"] is None


def test_attendee_webhook_transcript_update_routes_to_session(monkeypatch):
    async def _run():
        monkeypatch.setattr(attendee_api, "ATTENDEE_WEBHOOK_SECRET", None)
        # Webhook fails closed without a configured secret (PR #71 hardening).
        # This test exercises webhook->session routing/dedup, not signing, so opt
        # into the explicit unsigned dev path rather than coupling to a signature.
        monkeypatch.setattr(attendee_api, "ATTENDEE_ALLOW_UNSIGNED_WEBHOOK", True)
        sess = attendee_bridge.MeetingSession(
            conversation_id="c-webhook",
            meeting_url="https://meet.google.com/abc-defg-hij",
            bot_name="LCT",
        )
        sess._ws = _FakeWS()
        # Pin the recording anchor so the absolute-epoch ts (4200ms) maps to 4.2s.
        # inject_utterance subtracts a per-session recording-start anchor (PR #70);
        # the first utterance would otherwise anchor to itself and start at 0.0.
        sess._rec_anchor_epoch_ms = 0.0
        await attendee_bridge.register(sess)
        await attendee_bridge.bind_bot(sess, "bot_webhook")
        try:
            response = await attendee_api.attendee_webhook(
                _FakeRequest({
                    "trigger": "transcript.update",
                    "bot_id": "bot_webhook",
                    "idempotency_key": "evt-1",
                    "data": {
                        "speaker_name": "Aditya",
                        "speaker_uuid": "speaker-a",
                        "speaker_is_host": True,
                        "timestamp_ms": 4200,
                        "duration_ms": 1000,
                        "transcription": {
                            "transcript": "the live caption should be visible first",
                        },
                    },
                })
            )
            return response, sess._ws.sent
        finally:
            attendee_bridge._unregister(sess)

    response, sent = asyncio.run(_run())
    assert response == {"ok": True}
    assert len(sent) == 1
    frame = sent[0]
    assert frame["type"] == "transcript_final"
    assert frame["text"] == "the live caption should be visible first"
    assert frame["metadata"]["speaker_name"] == "Aditya"
    assert frame["metadata"]["speaker_uuid"] == "speaker-a"
    assert frame["timestamps"]["start"] == pytest.approx(4.2)
    assert frame["timestamps"]["end"] == pytest.approx(5.2)


def test_attendee_webhook_dedupes_transcript_update_by_idempotency_key(monkeypatch):
    async def _run():
        monkeypatch.setattr(attendee_api, "ATTENDEE_WEBHOOK_SECRET", None)
        # Webhook fails closed without a configured secret (PR #71 hardening).
        # This test exercises webhook->session routing/dedup, not signing, so opt
        # into the explicit unsigned dev path rather than coupling to a signature.
        monkeypatch.setattr(attendee_api, "ATTENDEE_ALLOW_UNSIGNED_WEBHOOK", True)
        sess = attendee_bridge.MeetingSession(
            conversation_id="c-dedupe",
            meeting_url="https://meet.google.com/abc-defg-hij",
            bot_name="LCT",
        )
        sess._ws = _FakeWS()
        await attendee_bridge.register(sess)
        await attendee_bridge.bind_bot(sess, "bot_dedupe")
        payload = {
            "trigger": "transcript.update",
            "bot_id": "bot_dedupe",
            "idempotency_key": "evt-same",
            "data": {
                "speaker_name": "Aditya",
                "transcription": {"transcript": "only once"},
            },
        }
        try:
            first = await attendee_api.attendee_webhook(_FakeRequest(payload))
            second = await attendee_api.attendee_webhook(_FakeRequest(payload))
            return first, second, sess._ws.sent
        finally:
            attendee_bridge._unregister(sess)

    first, second, sent = asyncio.run(_run())
    assert first == {"ok": True}
    assert second == {"ok": True, "deduped": True}
    assert len(sent) == 1
    assert sent[0]["text"] == "only once"


# --- idempotency dedupe -----------------------------------------------------

def test_idempotency_dedupe():
    sess = attendee_bridge.MeetingSession(conversation_id="c1", meeting_url="u", bot_name="b")
    assert sess.already_seen("k1") is False
    assert sess.already_seen("k1") is True
    assert sess.already_seen("k2") is False
    assert sess.already_seen(None) is False  # missing key never deduped
    assert sess.already_seen(None) is False


# --- terminal-state detection ----------------------------------------------

@pytest.mark.parametrize("state,expected", [
    ("ended", True),
    ("fatal_error", True),
    ("data_deleted", True),
    ("joined_recording", False),
    ("waiting_room", False),
    (9, True),
    (7, True),
    (4, False),
    (True, False),
    (None, False),
])
def test_is_terminal_state(state, expected):
    assert attendee_bridge._is_terminal_state(state) is expected


# --- registry ---------------------------------------------------------------

def test_registry_register_bind_unregister():
    async def _run():
        sess = attendee_bridge.MeetingSession(conversation_id="c-reg", meeting_url="u", bot_name="b")
        await attendee_bridge.register(sess)
        await attendee_bridge.bind_bot(sess, "bot_abc")
        assert attendee_bridge.get_by_conversation("c-reg") is sess
        assert attendee_bridge.get_by_bot("bot_abc") is sess
        attendee_bridge._unregister(sess)
        assert attendee_bridge.get_by_conversation("c-reg") is None
        assert attendee_bridge.get_by_bot("bot_abc") is None

    asyncio.run(_run())


# --- webhook signature verification -----------------------------------------

def _sign(secret_raw: bytes, payload: dict) -> str:
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(hmac.new(secret_raw, canonical, hashlib.sha256).digest()).decode()


def test_verify_signature_valid(monkeypatch):
    secret_raw = b"super-secret-bytes"
    monkeypatch.setattr(attendee_api, "ATTENDEE_WEBHOOK_SECRET", base64.b64encode(secret_raw).decode())
    payload = {"trigger": "transcript.update", "bot_id": "bot_1", "data": {"speaker_name": "José", "n": 1}}
    sig = _sign(secret_raw, payload)
    # raw body can be any JSON encoding; _verify re-canonicalizes before HMAC.
    raw = json.dumps(payload).encode("utf-8")
    assert attendee_api._verify_signature(raw, sig) is True


def test_verify_signature_rejects_tampered(monkeypatch):
    secret_raw = b"super-secret-bytes"
    monkeypatch.setattr(attendee_api, "ATTENDEE_WEBHOOK_SECRET", base64.b64encode(secret_raw).decode())
    payload = {"trigger": "transcript.update", "bot_id": "bot_1", "data": {"n": 1}}
    sig = _sign(secret_raw, payload)
    tampered = dict(payload, data={"n": 999})
    raw = json.dumps(tampered).encode("utf-8")
    assert attendee_api._verify_signature(raw, sig) is False
    assert attendee_api._verify_signature(raw, None) is False
    assert attendee_api._verify_signature(raw, "garbage") is False


def test_verify_signature_fails_closed_when_no_secret(monkeypatch):
    """No secret + no explicit dev opt-in => REJECT (the route bypasses
    bearer-auth/rate-limiting, so accepting here = unauthenticated injection)."""
    monkeypatch.setattr(attendee_api, "ATTENDEE_WEBHOOK_SECRET", None)
    monkeypatch.setattr(attendee_api, "ATTENDEE_ALLOW_UNSIGNED_WEBHOOK", False)
    raw = json.dumps({"any": "thing"}).encode("utf-8")
    assert attendee_api._verify_signature(raw, None) is False
    assert attendee_api._verify_signature(raw, "anything") is False


def test_verify_signature_unsigned_allowed_with_explicit_dev_optin(monkeypatch):
    """ATTENDEE_ALLOW_UNSIGNED_WEBHOOK=1 restores the unsigned dev path."""
    monkeypatch.setattr(attendee_api, "ATTENDEE_WEBHOOK_SECRET", None)
    monkeypatch.setattr(attendee_api, "ATTENDEE_ALLOW_UNSIGNED_WEBHOOK", True)
    raw = json.dumps({"any": "thing"}).encode("utf-8")
    assert attendee_api._verify_signature(raw, None) is True


# --- create-bot settings builder -------------------------------------------

def test_build_bot_settings_custom_async(monkeypatch):
    monkeypatch.setattr(attendee_api, "ATTENDEE_TRANSCRIPTION_MODE", "custom_async")
    monkeypatch.setattr(attendee_api, "ATTENDEE_STT_LANGUAGE", "en")
    monkeypatch.setattr(attendee_api, "ATTENDEE_RECORDING_FORMAT", "mp3")
    s = attendee_api._build_bot_settings()
    assert "custom_async_v2" in s["transcription_settings"]
    assert s["transcription_settings"]["custom_async_v2"]["form_data"]["language"] == "en"
    assert s["recording_settings"]["format"] == "mp3"


def test_build_bot_settings_closed_captions(monkeypatch):
    monkeypatch.setattr(attendee_api, "ATTENDEE_TRANSCRIPTION_MODE", "closed_captions")
    monkeypatch.setattr(attendee_api, "ATTENDEE_STT_LANGUAGE", "en")
    s = attendee_api._build_bot_settings()
    assert "meeting_closed_captions" in s["transcription_settings"]
    assert s["recording_settings"]["format"] == "none"


# --- meeting_url dedup ------------------------------------------------------

def test_normalize_meeting_url_strips_params():
    n = attendee_bridge._normalize_meeting_url
    assert n("https://meet.google.com/abc-defg-hij?ijlm=1&adhoc=1") == "https://meet.google.com/abc-defg-hij"
    assert n("https://meet.google.com/abc-defg-hij/") == "https://meet.google.com/abc-defg-hij"


def test_get_by_meeting_url_dedup():
    async def _run():
        url = "https://meet.google.com/dedup-test?x=1"
        s = attendee_bridge.MeetingSession(conversation_id="c-dedup", meeting_url=url, bot_name="b")
        await attendee_bridge.register(s)
        # same meeting, different session params -> same live session
        assert attendee_bridge.get_by_meeting_url("https://meet.google.com/dedup-test?y=2") is s
        # finalizing -> not eligible for dedup reuse
        s._finalizing = True
        assert attendee_bridge.get_by_meeting_url(url) is None
        attendee_bridge._unregister(s)
        assert attendee_bridge.get_by_meeting_url(url) is None

    asyncio.run(_run())


# --- auto-leave settings ----------------------------------------------------

def test_auto_leave_settings_shape(monkeypatch):
    monkeypatch.setattr(attendee_api, "ATTENDEE_ONLY_PARTICIPANT_TIMEOUT_S", 30)
    monkeypatch.setattr(attendee_api, "ATTENDEE_WAIT_FOR_HOST_TIMEOUT_S", 120)
    monkeypatch.setattr(attendee_api, "ATTENDEE_SILENCE_TIMEOUT_S", 600)
    s = attendee_api._auto_leave_settings()
    assert s["only_participant_in_meeting_timeout_seconds"] == 30
    assert s["wait_for_host_to_start_meeting_timeout_seconds"] == 120
    assert s["silence_timeout_seconds"] == 600


# --- latency: epoch-aware ---------------------------------------------------

def test_inject_utterance_latency_epoch():
    import time as _t

    async def _run():
        sess = attendee_bridge.MeetingSession(conversation_id="c-lat", meeting_url="u", bot_name="b")
        sess._ws = _FakeWS()
        now_ms = int(_t.time() * 1000)  # absolute Unix-epoch ms (speech ~0.5s ago)
        await sess.inject_utterance(text="hi", speaker_name="X",
                                    timestamp_ms=now_ms - 1000, duration_ms=500, recv_wall=_t.time())
        return sess._ws.sent

    sent = asyncio.run(_run())
    lat = sent[0]["metadata"]["latency"]
    assert lat["pipeline_ms"] is not None
    assert lat["e2e_ms"] is not None  # epoch-magnitude ts -> e2e computed
    assert -2000 < lat["e2e_ms"] < 10000  # sane sub-10s window


def test_inject_utterance_latency_none_without_epoch_ts():
    async def _run():
        sess = attendee_bridge.MeetingSession(conversation_id="c-lat2", meeting_url="u", bot_name="b")
        sess._ws = _FakeWS()
        # small (relative-looking) ts -> e2e not computed, only pipeline
        await sess.inject_utterance(text="hi", speaker_name="X", timestamp_ms=1000, duration_ms=500)
        return sess._ws.sent

    sent = asyncio.run(_run())
    lat = sent[0]["metadata"]["latency"]
    assert lat["e2e_ms"] is None and lat["attendee_lag_ms"] is None
    assert lat["pipeline_ms"] is not None
