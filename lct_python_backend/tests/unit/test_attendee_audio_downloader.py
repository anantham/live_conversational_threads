"""Unit tests for the Attendee post-call slow-pass (attendee_audio_downloader.py).

No real MinIO/boto3/network/DB — everything is faked. Covers:
- _get_minio_client: soft-skip without boto3, soft-skip without credentials,
  builds a real client when both are present.
- _find_recording_key: finds immediately, retries then finds, gives up on timeout.
- fetch_and_transcribe: full happy path proposes a revision via
  reconcile_and_patch_utterances (decision-B, never patches directly); skips
  cleanly when MinIO is unavailable, no recording is found, or STT returns no
  segments; never raises past its own boundary even on an unexpected error.
"""

from __future__ import annotations

import asyncio
import os
import sys
import types
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

# db_session.py builds its async engine at import time and requires a
# well-formed DATABASE_URL even though these tests never touch a real DB —
# every db call here goes through a fake session context (see _FakeDbCtx).
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost:5432/lct_test")

from lct_python_backend.services import attendee_audio_downloader as downloader


# ---------------------------------------------------------------------------
# _get_minio_client
# ---------------------------------------------------------------------------

def test_get_minio_client_returns_none_without_boto3(monkeypatch):
    """boto3 not installed -> soft-skip, never raises ImportError past this point."""
    monkeypatch.setitem(sys.modules, "boto3", None)  # forces `import boto3` to raise ImportError
    monkeypatch.setenv("MINIO_ACCESS_KEY", "key")
    monkeypatch.setenv("MINIO_SECRET_KEY", "secret")
    assert downloader._get_minio_client() is None


def _inject_fake_boto3(monkeypatch):
    """A minimal fake boto3 module so tests can exercise the credentials-gate
    and client-construction paths without the real package installed."""
    fake_client = MagicMock(name="s3_client")
    fake_boto3 = types.ModuleType("boto3")
    fake_boto3.client = MagicMock(return_value=fake_client)
    fake_botocore_config = types.ModuleType("botocore.config")
    fake_botocore_config.Config = MagicMock(side_effect=lambda **kw: SimpleNamespace(**kw))
    monkeypatch.setitem(sys.modules, "boto3", fake_boto3)
    monkeypatch.setitem(sys.modules, "botocore.config", fake_botocore_config)
    return fake_boto3, fake_client


def test_get_minio_client_returns_none_without_credentials(monkeypatch):
    _inject_fake_boto3(monkeypatch)
    monkeypatch.delenv("MINIO_ACCESS_KEY", raising=False)
    monkeypatch.delenv("MINIO_SECRET_KEY", raising=False)
    assert downloader._get_minio_client() is None


def test_get_minio_client_builds_client_with_credentials(monkeypatch):
    fake_boto3, fake_client = _inject_fake_boto3(monkeypatch)
    monkeypatch.setenv("MINIO_ACCESS_KEY", "key")
    monkeypatch.setenv("MINIO_SECRET_KEY", "secret")
    monkeypatch.setenv("MINIO_ENDPOINT_URL", "http://minio.local:9000")

    client = downloader._get_minio_client()

    assert client is fake_client
    fake_boto3.client.assert_called_once()
    _, kwargs = fake_boto3.client.call_args
    assert kwargs["endpoint_url"] == "http://minio.local:9000"
    assert kwargs["aws_access_key_id"] == "key"
    assert kwargs["aws_secret_access_key"] == "secret"


# ---------------------------------------------------------------------------
# _find_recording_key
# ---------------------------------------------------------------------------

class _FakeS3:
    """Fakes list_objects_v2 with a scripted sequence of responses, one per call.
    A response that is an Exception instance is raised instead of returned
    (transient-failure simulation). Records the kwargs of every call so tests
    can assert pagination tokens were passed through."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0
        self.call_kwargs = []

    def list_objects_v2(self, **kwargs):
        self.calls += 1
        self.call_kwargs.append(kwargs)
        resp = self._responses[min(self.calls, len(self._responses)) - 1]
        if isinstance(resp, Exception):
            raise resp
        return resp


def test_find_recording_key_finds_on_first_poll():
    s3 = _FakeS3([{"Contents": [{"Key": "abc/bot123.mp3"}]}])

    key = asyncio.run(downloader._find_recording_key(s3, "bot123"))

    assert key == "abc/bot123.mp3"
    assert s3.calls == 1


def test_find_recording_key_retries_then_finds(monkeypatch):
    monkeypatch.setattr(downloader, "MINIO_POLL_INTERVAL_S", 0.001)
    monkeypatch.setattr(downloader, "MINIO_POLL_TIMEOUT_S", 1.0)
    s3 = _FakeS3([
        {"Contents": []},
        {"Contents": [{"Key": "other-bot.mp3"}]},
        {"Contents": [{"Key": "bot123.mp3"}]},
    ])

    key = asyncio.run(downloader._find_recording_key(s3, "bot123"))

    assert key == "bot123.mp3"
    assert s3.calls == 3


def test_find_recording_key_gives_up_after_timeout(monkeypatch):
    monkeypatch.setattr(downloader, "MINIO_POLL_INTERVAL_S", 0.001)
    monkeypatch.setattr(downloader, "MINIO_POLL_TIMEOUT_S", 0.01)
    s3 = _FakeS3([{"Contents": []}])  # never has the recording

    key = asyncio.run(downloader._find_recording_key(s3, "bot123"))

    assert key is None
    assert s3.calls >= 1


def test_find_recording_key_walks_paginated_bucket():
    """The recording can be on a later page of a full bucket (codex review #4)."""
    s3 = _FakeS3([
        {"Contents": [{"Key": "unrelated-1.mp3"}], "IsTruncated": True,
         "NextContinuationToken": "tok-2"},
        {"Contents": [{"Key": "bot123.mp3", "LastModified": 1}]},
    ])

    key = asyncio.run(downloader._find_recording_key(s3, "bot123"))

    assert key == "bot123.mp3"
    assert s3.call_kwargs[0] == {"Bucket": downloader.MINIO_BUCKET}
    assert s3.call_kwargs[1]["ContinuationToken"] == "tok-2"


def test_find_recording_key_prefers_most_recent_of_multiple_matches():
    """Re-uploads/partials for the same bot: newest LastModified wins (codex review #3)."""
    from datetime import datetime, timezone
    old = datetime(2026, 7, 1, tzinfo=timezone.utc)
    new = datetime(2026, 7, 2, tzinfo=timezone.utc)
    s3 = _FakeS3([
        {"Contents": [
            {"Key": "bot123-partial.mp3", "LastModified": old},
            {"Key": "bot123-final.mp3", "LastModified": new},
        ]},
    ])

    key = asyncio.run(downloader._find_recording_key(s3, "bot123"))

    assert key == "bot123-final.mp3"


def test_find_recording_key_survives_transient_listing_error(monkeypatch):
    """A transient MinIO failure counts as not-ready-yet, not a fatal abort (codex review #5)."""
    monkeypatch.setattr(downloader, "MINIO_POLL_INTERVAL_S", 0.001)
    monkeypatch.setattr(downloader, "MINIO_POLL_TIMEOUT_S", 1.0)
    s3 = _FakeS3([
        ConnectionError("minio hiccup"),
        {"Contents": [{"Key": "bot123.mp3", "LastModified": 1}]},
    ])

    key = asyncio.run(downloader._find_recording_key(s3, "bot123"))

    assert key == "bot123.mp3"
    assert s3.calls == 2


# ---------------------------------------------------------------------------
# fetch_and_transcribe
# ---------------------------------------------------------------------------

class _FakeUtterance:
    def __init__(self, speaker_name):
        self.speaker_name = speaker_name


class _FakeScalars:
    def __init__(self, items):
        self._items = items

    def all(self):
        return self._items


class _FakeResult:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return _FakeScalars(self._items)


class _FakeDb:
    """Fakes the one db.execute(select(...)) call fetch_and_transcribe makes."""

    def __init__(self, utterances):
        self._utterances = utterances
        self.executed = []

    async def execute(self, stmt):
        self.executed.append(stmt)
        return _FakeResult(self._utterances)


class _FakeDbCtx:
    """Fakes `async with get_async_session_context() as db:`."""

    def __init__(self, db):
        self._db = db

    async def __aenter__(self):
        return self._db

    async def __aexit__(self, *exc):
        return False


@pytest.fixture
def patched_downloader(monkeypatch, tmp_path):
    """Common patch set for fetch_and_transcribe: MinIO found+downloaded,
    a DB session with two utterances, and a spy on reconcile_and_patch_utterances.
    Individual tests override pieces (e.g. no recording found, no ASR segments)."""
    # A plain MagicMock's .download_file(...) is a harmless no-op call, so the
    # real run_in_executor(None, download_obj) path runs unmocked here — no
    # actual network I/O happens since fake_s3 isn't a real boto3 client.
    fake_s3 = MagicMock(name="s3")
    monkeypatch.setattr(downloader, "_get_minio_client", lambda: fake_s3)

    async def _fake_find_key(s3, bot_id):
        return "found/bot123.mp3"
    monkeypatch.setattr(downloader, "_find_recording_key", _fake_find_key)

    monkeypatch.setattr(downloader, "AUDIO_RECORDINGS_DIR", str(tmp_path))

    utterances = [_FakeUtterance("Aditya"), _FakeUtterance("Vatsal")]
    fake_db = _FakeDb(utterances)
    monkeypatch.setattr(downloader, "get_async_session_context", lambda: _FakeDbCtx(fake_db))

    reconcile_calls = []
    async def _fake_reconcile(conversation_id, utts, asr_segments, db=None):
        reconcile_calls.append((conversation_id, utts, asr_segments, db))
    monkeypatch.setattr(downloader, "reconcile_and_patch_utterances", _fake_reconcile)

    return SimpleNamespace(fake_s3=fake_s3, fake_db=fake_db, reconcile_calls=reconcile_calls)


def test_fetch_and_transcribe_happy_path_proposes_revision(monkeypatch, patched_downloader):
    segments = [{"start": 0.0, "end": 1.2, "text": "hello"}]

    async def _fake_transcribe(**kwargs):
        # Confirms the vocabulary prompt was built from the fetched utterances.
        assert "Aditya" in kwargs["initial_prompt"]
        assert "Vatsal" in kwargs["initial_prompt"]
        return SimpleNamespace(asr_segments=segments)
    monkeypatch.setattr(downloader, "transcribe_audio_file_detailed", _fake_transcribe)

    asyncio.run(downloader.fetch_and_transcribe("bot123", "conv-1"))

    assert len(patched_downloader.reconcile_calls) == 1
    conversation_id, utts, asr_segments, db = patched_downloader.reconcile_calls[0]
    assert conversation_id == "conv-1"
    assert utts == [u for u in patched_downloader.fake_db._utterances]
    assert asr_segments == segments
    assert db is patched_downloader.fake_db


def test_fetch_and_transcribe_skips_when_minio_unavailable(monkeypatch, patched_downloader):
    monkeypatch.setattr(downloader, "_get_minio_client", lambda: None)

    asyncio.run(downloader.fetch_and_transcribe("bot123", "conv-1"))

    assert patched_downloader.reconcile_calls == []


def test_fetch_and_transcribe_skips_when_no_recording_found(monkeypatch, patched_downloader):
    async def _no_key(s3, bot_id):
        return None
    monkeypatch.setattr(downloader, "_find_recording_key", _no_key)

    asyncio.run(downloader.fetch_and_transcribe("bot123", "conv-1"))

    assert patched_downloader.reconcile_calls == []


def test_fetch_and_transcribe_skips_when_no_asr_segments(monkeypatch, patched_downloader):
    async def _empty_transcribe(**kwargs):
        return SimpleNamespace(asr_segments=[])
    monkeypatch.setattr(downloader, "transcribe_audio_file_detailed", _empty_transcribe)

    asyncio.run(downloader.fetch_and_transcribe("bot123", "conv-1"))

    assert patched_downloader.reconcile_calls == []


def test_fetch_and_transcribe_never_raises_on_unexpected_error(monkeypatch, patched_downloader):
    async def _boom(**kwargs):
        raise RuntimeError("STT service unreachable")
    monkeypatch.setattr(downloader, "transcribe_audio_file_detailed", _boom)

    # Must not raise — this runs detached from the webhook response.
    asyncio.run(downloader.fetch_and_transcribe("bot123", "conv-1"))

    assert patched_downloader.reconcile_calls == []


def test_fetch_and_transcribe_dedupes_concurrent_triggers(monkeypatch, patched_downloader):
    """Attendee webhook retries / repeated terminal states must not race two
    slow-passes for the same bot (codex review #1)."""
    segments = [{"start": 0.0, "end": 1.2, "text": "hello"}]

    async def _fake_transcribe(**kwargs):
        await asyncio.sleep(0.01)  # hold the first run in flight while the second fires
        return SimpleNamespace(asr_segments=segments)
    monkeypatch.setattr(downloader, "transcribe_audio_file_detailed", _fake_transcribe)

    async def _run_both():
        await asyncio.gather(
            downloader.fetch_and_transcribe("bot123", "conv-1"),
            downloader.fetch_and_transcribe("bot123", "conv-1"),
        )
    asyncio.run(_run_both())

    assert len(patched_downloader.reconcile_calls) == 1  # second trigger skipped
    # Guard must clear afterwards so a genuinely later re-trigger still works.
    assert "bot123" not in downloader._inflight_bots


def test_fetch_and_transcribe_inflight_guard_clears_after_failure(monkeypatch, patched_downloader):
    async def _boom(**kwargs):
        raise RuntimeError("STT service unreachable")
    monkeypatch.setattr(downloader, "transcribe_audio_file_detailed", _boom)

    asyncio.run(downloader.fetch_and_transcribe("bot123", "conv-1"))

    assert "bot123" not in downloader._inflight_bots
