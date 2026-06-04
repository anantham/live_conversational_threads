"""Tests for the local-only egress guard (the single trustworthy switch).

The guard is the thing that makes "run the same audio many times with zero
cloud spend" provable rather than hopeful: when local-only is on, every
egress funnel calls assert_local_egress(url), and any non-local host raises.
"""

import pytest

from lct_python_backend.services.egress_guard import (
    CloudEgressBlocked,
    assert_local_egress,
    is_local_host,
    is_local_url,
    local_only_enabled,
)


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    for var in ("LCT_LOCAL_ONLY", "LCT_LOCAL_ONLY_ALLOW_HOSTS"):
        monkeypatch.delenv(var, raising=False)


# --- master switch: default ON (fail-closed) --------------------------------

def test_default_is_local_only_on():
    assert local_only_enabled() is True


@pytest.mark.parametrize("val,expected", [
    ("0", False), ("false", False), ("no", False), ("off", False),
    ("1", True), ("true", True), ("on", True), ("", True),  # blank -> default on
])
def test_switch_env(monkeypatch, val, expected):
    monkeypatch.setenv("LCT_LOCAL_ONLY", val)
    assert local_only_enabled() is expected


# --- host classification: loopback / Tailscale / LAN are local --------------

@pytest.mark.parametrize("host", [
    "localhost", "127.0.0.1", "127.0.0.5", "::1",
    "100.81.65.74",      # asus Tailscale (CGNAT 100.64/10)
    "100.83.228.35",     # M5 Pro Tailscale
    "asus-strix-scar.tail4741ad.ts.net",
    "10.0.0.5", "172.16.4.4", "192.168.1.50",  # RFC1918 LAN
    "mybox.local",
])
def test_local_hosts(host):
    assert is_local_host(host) is True


@pytest.mark.parametrize("host", [
    "api.openai.com", "openrouter.ai", "api.anthropic.com",
    "api.perplexity.ai", "generativelanguage.googleapis.com",
    "adityaarpitha--llm-server-serve.modal.run",  # Modal blocked (strict)
    "8.8.8.8", "1.1.1.1",
])
def test_nonlocal_hosts(host):
    assert is_local_host(host) is False


def test_host_with_port():
    assert is_local_host("100.81.65.74:1234") is True
    assert is_local_host("api.openai.com:443") is False


def test_is_local_url():
    assert is_local_url("http://100.81.65.74:1234/v1/chat/completions") is True
    assert is_local_url("http://localhost:11434/v1/chat/completions") is True  # Ollama
    assert is_local_url("https://api.openai.com/v1/chat/completions") is False
    assert is_local_url("https://x.modal.run/v1/chat/completions") is False


# --- assert_local_egress: the enforcement point -----------------------------

def test_blocks_cloud_when_on():
    with pytest.raises(CloudEgressBlocked):
        assert_local_egress("https://api.openai.com/v1/chat/completions")


def test_blocks_modal_when_on():
    with pytest.raises(CloudEgressBlocked):
        assert_local_egress("https://x.modal.run/v1/chat/completions")


def test_allows_local_when_on():
    assert_local_egress("http://100.81.65.74:1234/v1/chat/completions")  # no raise
    assert_local_egress("http://localhost:11434/v1/chat/completions")    # Ollama, no raise


def test_noop_when_off(monkeypatch):
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    # Off -> even cloud is allowed (the ADR-034 public profile).
    assert_local_egress("https://api.openai.com/v1/chat/completions")


def test_allowlist_escape_hatch(monkeypatch):
    monkeypatch.setenv("LCT_LOCAL_ONLY_ALLOW_HOSTS", "*.modal.run")
    assert is_local_host("x.modal.run") is True
    assert_local_egress("https://x.modal.run/v1/chat/completions")  # now allowed
    # but an un-listed cloud host still blocked
    with pytest.raises(CloudEgressBlocked):
        assert_local_egress("https://api.openai.com/v1/chat/completions")
