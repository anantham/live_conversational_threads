"""Tests for per-contact privacy policy resolution (fail-closed, most-restrictive)."""

import pytest

from lct_python_backend.services.synthesis import contact_policy
from lct_python_backend.services.synthesis.contact_policy import (
    ContactPrivacyPolicy,
    default_policy,
    fetch_policy,
    resolve_engine,
    verify_signature,
)


def _consenting(cid: str) -> ContactPrivacyPolicy:
    return ContactPrivacyPolicy(cid, enabled=True, local_llm_ok=True, external_llm_ok=True)


def _local_only(cid: str) -> ContactPrivacyPolicy:
    return ContactPrivacyPolicy(cid, enabled=True, local_llm_ok=True, external_llm_ok=False)


class TestDefaultPolicy:
    def test_default_is_fail_closed_for_external(self):
        p = default_policy("x")
        assert p.local_llm_ok is True
        assert p.external_llm_ok is False
        assert p.is_default is True


class TestResolveEngine:
    def test_local_requested_always_local(self, monkeypatch):
        monkeypatch.setenv("LCT_LOCAL_ONLY", "1")
        d = resolve_engine([_local_only("a")], "local")
        assert d.engine == "local"
        assert d.downgraded is False

    def test_external_refused_under_local_only(self, monkeypatch):
        monkeypatch.setenv("LCT_LOCAL_ONLY", "1")
        d = resolve_engine([_consenting("a"), _consenting("b")], "codex")
        assert d.engine == "local"
        assert d.downgraded is True
        assert "LCT_LOCAL_ONLY" in d.reason

    def test_external_allowed_when_all_consent_and_not_local_only(self, monkeypatch):
        monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
        d = resolve_engine([_consenting("a"), _consenting("b")], "claude")
        assert d.engine == "claude"
        assert d.downgraded is False

    def test_most_restrictive_one_objector_downgrades(self, monkeypatch):
        monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
        d = resolve_engine([_consenting("a"), _local_only("b")], "codex")
        assert d.engine == "local"
        assert d.downgraded is True
        assert "b" in d.reason

    def test_no_policies_fails_closed(self, monkeypatch):
        monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
        d = resolve_engine([], "codex")
        assert d.engine == "local"
        assert d.downgraded is True

    def test_disabled_contact_downgrades(self, monkeypatch):
        monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
        p = ContactPrivacyPolicy("a", enabled=False, local_llm_ok=True, external_llm_ok=True)
        d = resolve_engine([p], "codex")
        assert d.engine == "local"

    def test_mandatory_signature_downgrades_unsigned(self, monkeypatch):
        monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
        d = resolve_engine([_consenting("a")], "codex", require_signature=True)
        assert d.engine == "local"  # no verifiable signature yet → fail closed


class TestVerifySignature:
    def test_advisory_allows_unsigned(self):
        assert verify_signature(_consenting("a"), require=False) is True

    def test_advisory_allows_present_but_unverified(self):
        p = _consenting("a")
        p.signature = "deadbeef"
        assert verify_signature(p, require=False) is True

    def test_mandatory_rejects_unsigned(self):
        assert verify_signature(_consenting("a"), require=True) is False

    def test_mandatory_rejects_unverifiable(self):
        # Real verification lands in PR#2; until then mandatory mode fails closed.
        p = _consenting("a")
        p.signature = "deadbeef"
        assert verify_signature(p, require=True) is False


class TestFetchPolicy:
    def test_disabled_indrasnet_returns_fail_closed_default(self, monkeypatch):
        monkeypatch.setenv("ENABLE_INDRASNET", "0")
        monkeypatch.delenv("INDRASNET_BASE_URL", raising=False)
        p = fetch_policy("some-contact")
        assert p.is_default is True
        assert p.external_llm_ok is False

    def test_empty_contact_id_returns_default(self):
        assert fetch_policy("").is_default is True

    def test_http_error_fails_closed(self, monkeypatch):
        monkeypatch.setenv("ENABLE_INDRASNET", "1")
        monkeypatch.setenv("INDRASNET_BASE_URL", "http://127.0.0.1:7777")

        class _Boom:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def get(self, *a, **k):
                raise RuntimeError("connection refused")

        monkeypatch.setattr(contact_policy.httpx, "Client", lambda *a, **k: _Boom())
        p = fetch_policy("c1")
        assert p.is_default is True
