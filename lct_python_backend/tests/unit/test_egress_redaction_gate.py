"""Chokepoint byte-boundary tests (ADR-038 move 1 + finding 1.8).

Proves the NEW contract the redesign requires: a redaction-required (E3/E4) send
carrying a forbidden real name is blocked on its ACTUAL request body BEFORE the
socket opens — even when ``LCT_LOCAL_ONLY=0`` (the host gate no-ops then). Clean
(redacted) bodies are unaffected, and local/E1 traffic is never byte-scanned.

The boundary is purely ADDITIVE: it does not relax any existing host-locality
behavior (those tests stay green in test_egress_chokepoint.py); it only newly
blocks forbidden-name bodies that previously leaked at LCT_LOCAL_ONLY=0.
"""

import httpx
import pytest

from lct_python_backend.services.egress_chokepoint import (
    install_egress_chokepoint,
    uninstall_egress_chokepoint,
)
from lct_python_backend.services.privacy_boundary import UnverifiedEgressBlocked

E4_URL = "https://api.openai.com/v1/chat/completions"
DIRTY = b'{"messages":[{"role":"user","content":"notes about Vatsal Mehra"}]}'
CLEAN = b'{"messages":[{"role":"user","content":"notes about [Friend A]"}]}'


@pytest.fixture(autouse=True)
def _chokepoint_on(monkeypatch):
    monkeypatch.delenv("LCT_LOCAL_ONLY_ALLOW_HOSTS", raising=False)
    install_egress_chokepoint()
    try:
        yield
    finally:
        uninstall_egress_chokepoint()


# --- finding 1.8: the new contract at LCT_LOCAL_ONLY=0 -----------------------

def test_dirty_body_blocked_when_local_only_off(monkeypatch):
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    with pytest.raises(UnverifiedEgressBlocked):
        httpx.Client(timeout=0.3).post(E4_URL, content=DIRTY)


def test_clean_body_passes_boundary_when_local_only_off(monkeypatch):
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    with pytest.raises(Exception) as exc_info:
        httpx.Client(timeout=0.1).post(E4_URL, content=CLEAN)
    # It passes the redaction boundary and fails later on the network — NOT a block.
    assert not isinstance(exc_info.value, UnverifiedEgressBlocked)


def test_dirty_body_blocked_even_when_local_only_on(monkeypatch):
    # Under LOCAL_ONLY=1 the host gate would block anyway, but the byte check
    # fires first — and UnverifiedEgressBlocked is a CloudEgressBlocked subclass.
    monkeypatch.setenv("LCT_LOCAL_ONLY", "1")
    with pytest.raises(UnverifiedEgressBlocked):
        httpx.Client(timeout=0.3).post(E4_URL, content=DIRTY)


# --- local traffic is never byte-scanned -------------------------------------

def test_local_e1_body_not_scanned(monkeypatch):
    # A forbidden name in a LOCAL (E1) request body is NOT a leak — owner hardware.
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    with pytest.raises(Exception) as exc_info:
        httpx.Client(timeout=0.2).post("http://127.0.0.1:59999/x", content=DIRTY)
    assert not isinstance(exc_info.value, UnverifiedEgressBlocked)


# --- streamed bodies are materialized + scanned (codex blocker 1) ------------

def test_streamed_body_is_materialized_and_scanned(monkeypatch):
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")

    def _gen():
        yield b'{"messages":[{"content":"about Vatsal"}]}'

    with pytest.raises(UnverifiedEgressBlocked):
        httpx.Client(timeout=0.3).post(E4_URL, content=_gen())


def test_unmaterializable_body_fails_closed():
    from lct_python_backend.services.egress_chokepoint import _materialize_body_sync

    class _OneShot:
        url = httpx.URL(E4_URL)

        @property
        def content(self):
            raise httpx.RequestNotRead()

        def read(self):
            raise RuntimeError("one-shot stream, cannot replay")

    with pytest.raises(UnverifiedEgressBlocked):
        _materialize_body_sync(_OneShot(), E4_URL)


# --- SDK coverage via MRO (google-genai / OpenAI shape) ----------------------

def test_httpx_subclass_covered_by_mro(monkeypatch):
    # google-genai / OpenAI SDKs subclass httpx.Client and override only __init__,
    # so client.send resolves to the patched class method via MRO.
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")

    class FakeSdkClient(httpx.Client):
        pass

    with pytest.raises(UnverifiedEgressBlocked):
        FakeSdkClient(timeout=0.3).post("https://api.anthropic.com/v1/messages", content=DIRTY)


@pytest.mark.asyncio
async def test_async_dirty_body_blocked(monkeypatch):
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    async with httpx.AsyncClient(timeout=0.3) as client:
        with pytest.raises(UnverifiedEgressBlocked):
            await client.post(E4_URL, content=DIRTY)
