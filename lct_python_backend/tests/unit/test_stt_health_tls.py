"""Regression tests for the STT health probe's TLS verification.

The probe must verify TLS against certifi's modern CA bundle, not the host
trust store. On Windows the system certificate store still carries an EXPIRED
Let's Encrypt cross-signed root (the old DST Root CA X3 path); OpenSSL 3.0
builds the chain through it and rejects an otherwise-valid Let's Encrypt leaf
with "certificate has expired". That made a healthy Tailscale-served STT route
(the M5 parakeet shim) show as a dead route on the home status pill, even
though curl / the browser / the live STT transport (all certifi) accept it.
"""
import ssl

from lct_python_backend.services.stt import stt_health_service
from lct_python_backend.services.stt.stt_health_service import probe_health_url


def test_https_context_is_certifi_backed():
    """The module pins a real SSL context (built from certifi), not None
    (which would let urlopen fall back to the OS trust store)."""
    ctx = stt_health_service._HTTPS_CONTEXT
    assert isinstance(ctx, ssl.SSLContext), (
        "probe must pin a certifi SSL context; falling back to the OS store "
        "reintroduces the expired-LE-cross-sign false negative on Windows"
    )


def test_probe_passes_certifi_context_to_urlopen(monkeypatch):
    """Guard that probe_health_url always hands urlopen the certifi-pinned
    context. A bare urlopen (context=None) trusts the OS store and its expired
    LE cross-sign on Windows -> false 'certificate has expired'."""
    captured = {}

    class _FakeResp:
        status = 200
        headers = {"Content-Type": "application/json"}

        def getcode(self):
            # probe does getattr(resp, "status", resp.getcode()); Python
            # evaluates the default eagerly, so the fake must define it.
            return 200

        def read(self, _n=None):
            return b'{"status":"ok"}'

        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

    def _fake_urlopen(req, timeout=None, context=None):
        captured["context"] = context
        return _FakeResp()

    monkeypatch.setattr(stt_health_service, "urlopen", _fake_urlopen)
    # Loopback URL passes the local-egress guard, then hits our fake urlopen.
    result = probe_health_url("http://127.0.0.1:59999/health", timeout_seconds=1.0)

    assert result["ok"] is True
    assert captured["context"] is stt_health_service._HTTPS_CONTEXT
    assert isinstance(captured["context"], ssl.SSLContext)
