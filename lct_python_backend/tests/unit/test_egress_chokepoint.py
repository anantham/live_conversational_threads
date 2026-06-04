"""Tests for the network-layer egress chokepoint.

Proves that once ``install_egress_chokepoint()`` is called, a NON-local
outbound call via ANY transport (httpx sync/async, the OpenAI SDK which rides
httpx, websockets, urllib) is refused under ``LCT_LOCAL_ONLY`` — even though
the call site has NO per-site guard. This is the property the per-site approach
could not provide.

Network-free: the guard raises ``CloudEgressBlocked`` before the socket opens,
so no real request is ever made. Local hosts pass the guard (and then fail on
connection, which we treat as "guard allowed it").
"""

import urllib.request

import httpx
import pytest

from lct_python_backend.services.egress_chokepoint import (
    install_egress_chokepoint,
    is_installed,
    uninstall_egress_chokepoint,
)
from lct_python_backend.services.egress_guard import CloudEgressBlocked


@pytest.fixture(autouse=True)
def _chokepoint_on(monkeypatch):
    """Install the chokepoint for each test and ALWAYS uninstall on teardown,
    so the global httpx/websockets/urllib patches never leak into other test
    modules (which use TestClient / MockTransport against non-local hosts)."""
    monkeypatch.setenv("LCT_LOCAL_ONLY", "1")
    monkeypatch.delenv("LCT_LOCAL_ONLY_ALLOW_HOSTS", raising=False)
    install_egress_chokepoint()
    try:
        yield
    finally:
        uninstall_egress_chokepoint()


def test_installer_is_idempotent():
    install_egress_chokepoint()
    install_egress_chokepoint()
    assert is_installed() is True
    # send must not be double-wrapped: the wrapped marker is stable.
    assert getattr(httpx.Client.send, "_lct_egress_wrapped", False) is True


def test_httpx_sync_blocks_cloud():
    with pytest.raises(CloudEgressBlocked):
        httpx.Client().get("https://api.openai.com/v1/models")


@pytest.mark.asyncio
async def test_httpx_async_blocks_cloud():
    async with httpx.AsyncClient() as client:
        with pytest.raises(CloudEgressBlocked):
            await client.get("https://generativelanguage.googleapis.com/v1/models")


def _has_cause(exc: BaseException, exc_type: type) -> bool:
    """True if exc_type appears anywhere in the __cause__/__context__ chain."""
    seen = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if isinstance(cur, exc_type):
            return True
        cur = cur.__cause__ or cur.__context__
    return False


def test_openai_sdk_blocks_cloud_via_httpx():
    """The OpenAI SDK rides httpx.send, so the chokepoint covers it with no
    SDK-specific guard. The SDK rewraps the block as APIConnectionError, but
    the underlying cause is our CloudEgressBlocked — i.e. the call never left
    the process."""
    openai = pytest.importorskip("openai")
    client = openai.OpenAI(api_key="sk-test-not-real", max_retries=0)
    with pytest.raises(Exception) as exc_info:
        client.models.list()
    assert _has_cause(exc_info.value, CloudEgressBlocked), (
        f"expected CloudEgressBlocked in the cause chain, got "
        f"{type(exc_info.value).__name__}: {exc_info.value}"
    )


def test_urllib_blocks_cloud():
    with pytest.raises(CloudEgressBlocked):
        urllib.request.urlopen("https://api.openai.com/v1/models", timeout=1)


@pytest.mark.asyncio
async def test_websockets_blocks_cloud():
    import websockets

    with pytest.raises(CloudEgressBlocked):
        await websockets.connect("wss://api.openai.com/v1/realtime")


def test_local_hosts_pass_the_guard():
    """A local target passes the guard — proving the chokepoint does not block
    legitimate local traffic (IndrasNet :7777, LM Studio, local STT, etc.).

    Whether the host happens to be up is irrelevant: the only thing under test
    is that the GUARD did not raise. Use a closed port so the call returns
    quickly either way; any non-CloudEgressBlocked outcome (connection refused,
    or even success) means the guard allowed it."""
    try:
        httpx.Client(timeout=0.2).get("http://127.0.0.1:59999/health")
    except CloudEgressBlocked:  # pragma: no cover - would be a guard bug
        pytest.fail("guard wrongly blocked a loopback host")
    except Exception:
        pass  # connection refused / timeout — fine, the guard let it through


def test_tailscale_host_passes_the_guard():
    """A Tailscale CGNAT (100.64/10) host must pass the guard. The box may or
    may not be reachable; we only assert the guard did not block it."""
    try:
        httpx.Client(timeout=0.2).get("http://100.81.65.74:7777/health")
    except CloudEgressBlocked:  # pragma: no cover - would be a guard bug
        pytest.fail("guard wrongly blocked a Tailscale host")
    except Exception:
        pass  # unreachable / timeout — fine, the guard let it through


@pytest.mark.asyncio
async def test_cloud_allowed_when_local_only_off(monkeypatch):
    """With LCT_LOCAL_ONLY=0 the chokepoint is a no-op: cloud calls pass the
    guard (and fail later on auth/network, NOT on egress)."""
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    async with httpx.AsyncClient(timeout=0.1) as client:
        with pytest.raises(Exception) as exc_info:
            await client.get("https://api.openai.com/v1/models")
        assert not isinstance(exc_info.value, CloudEgressBlocked)
