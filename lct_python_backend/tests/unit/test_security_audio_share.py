"""Regression tests for two security fixes (2026-05-30):

1. Path traversal via audio-chunk upload — `conversation_id` reaching the
   filesystem must not escape the recordings directory.
2. `DELETE /api/share/{token}` auth bypass — only GET under /api/share/ is public.
"""

import asyncio
import tempfile
from pathlib import Path

import pytest

from lct_python_backend.services.audio_storage import AudioStorageManager
from lct_python_backend import middleware


def _mgr():
    d = tempfile.mkdtemp()
    return AudioStorageManager(d), Path(d).resolve()


# ── 1. path traversal ────────────────────────────────────────────────────────

def test_conversation_path_accepts_normal():
    mgr, root = _mgr()
    p = mgr._conversation_path("550e8400-e29b-41d4-a716-446655440000", ".pcm")
    assert p.parent == root
    assert p.name.endswith(".pcm")


# Note: a bare ".." with a suffix becomes the harmless filename "...pcm" at this
# layer (no separator → stays a direct child); traversal needs a separator. The
# route-level regex blocks ".." too. These are the real escape vectors:
@pytest.mark.parametrize("bad", ["../evil", "../../../../tmp/evil", "a/b", "foo/../../bar"])
def test_conversation_path_rejects_traversal(bad):
    mgr, _ = _mgr()
    with pytest.raises(ValueError):
        mgr._conversation_path(bad, ".pcm")


def test_append_chunk_traversal_writes_nothing_outside(tmp_path):
    mgr = AudioStorageManager(str(tmp_path / "recordings"))
    escaped = tmp_path / "evil.pcm"  # where "../evil" would land
    with pytest.raises(ValueError):
        asyncio.run(mgr.append_chunk("../evil", b"x" * 16))
    assert not escaped.exists()


def test_append_chunk_normal_writes_inside():
    mgr, root = _mgr()
    asyncio.run(mgr.append_chunk("conv1", b"x" * 16))
    assert (root / "conv1.pcm").exists()


def test_persist_source_audio_refuses_traversal():
    mgr, root = _mgr()
    # even with a valid suffix, a traversal id is refused (returns None, no copy)
    assert mgr.persist_source_audio("../../evil", "/etc/hosts", ".wav") is None


def test_validate_conversation_id_rejects_traversal():
    from fastapi import HTTPException
    try:
        # importing stt_api inits the DB engine; skip when DATABASE_URL isn't set
        from lct_python_backend.stt_api import _validate_conversation_id
    except Exception:  # noqa: BLE001
        pytest.skip("stt_api requires DATABASE_URL; route guard covered by audio_storage layer")

    _validate_conversation_id("550e8400-e29b-41d4-a716-446655440000")  # uuid OK
    _validate_conversation_id("conv_123-abc")  # plain id OK
    for bad in ["../x", "a/b", "", "..", "x" * 201]:
        with pytest.raises(HTTPException):
            _validate_conversation_id(bad)


# ── 2. share DELETE auth bypass ──────────────────────────────────────────────

def test_public_share_is_get_only():
    assert middleware._is_public_share("/api/share/tok", "GET") is True
    assert middleware._is_public_share("/api/share/tok/audio", "GET") is True
    # the bug: DELETE / POST / PUT under /api/share/ must NOT be public
    assert middleware._is_public_share("/api/share/tok", "DELETE") is False
    assert middleware._is_public_share("/api/share/tok", "POST") is False
    assert middleware._is_public_share("/api/share/tok", "PUT") is False
    # non-share paths are never public-share
    assert middleware._is_public_share("/api/conversations/x", "GET") is False
