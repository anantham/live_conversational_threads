"""Tests for per-contact privacy policy resolution (fail-closed, most-restrictive)."""

import pytest

from lct_python_backend.services.synthesis import contact_policy
from lct_python_backend.services.synthesis.contact_policy import (
    ContactPrivacyPolicy,
    _as_bool,
    _parse_policy,
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

    def test_disabled_contact_refuses_entirely(self, monkeypatch):
        monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
        p = ContactPrivacyPolicy("a", enabled=False, local_llm_ok=True, external_llm_ok=True)
        d = resolve_engine([p], "codex")
        assert d.engine == "none"  # not even local — data must not be processed

    def test_local_denied_refuses_even_local(self, monkeypatch):
        monkeypatch.setenv("LCT_LOCAL_ONLY", "1")
        p = ContactPrivacyPolicy("a", enabled=True, local_llm_ok=False, external_llm_ok=False)
        d = resolve_engine([p], "local")
        assert d.engine == "none"  # local_llm_ok=0 → refuse even local processing

    def test_remote_source_auto_requires_signature(self, monkeypatch):
        monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
        p = _consenting("a")
        p.source_is_local = False  # policy came from a remote/federated IndrasNet
        d = resolve_engine([p], "codex")
        assert d.engine == "local"  # no valid signature → fail closed
        assert d.downgraded is True

    def test_mandatory_signature_downgrades_unsigned(self, monkeypatch):
        monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
        d = resolve_engine([_consenting("a")], "codex", require_signature=True)
        assert d.engine == "local"  # no verifiable signature yet → fail closed


class TestVerifySignature:
    def test_advisory_allows_unsigned(self):
        assert verify_signature(_consenting("a"), require=False) is True

    def test_mandatory_rejects_unsigned(self):
        assert verify_signature(_consenting("a"), require=True) is False

    def test_mandatory_rejects_signed_but_unverifiable(self):
        # Whether eth_account is absent (unavailable) or the sig is bogus (invalid),
        # mandatory mode fails closed. Holds in every environment.
        p = _consenting("a")
        p.signature = "0xdeadbeef"
        p.signer_pubkey = "0x0000000000000000000000000000000000000000"
        assert verify_signature(p, require=True) is False

    def test_invalid_signature_rejected_even_advisory_when_verifiable(self):
        # Only meaningful with the crypto lib present: a bogus sig recovers to the
        # wrong address → "invalid" → rejected even in advisory (tamper).
        pytest.importorskip("eth_account")
        p = _consenting("a")
        p.signature = "0xdeadbeef"
        p.signer_pubkey = "0x0000000000000000000000000000000000000000"
        assert verify_signature(p, require=False) is False


class TestCanonicalBodyGolden:
    def test_matches_cross_repo_golden(self):
        # MUST equal IndrasNet's canonical_policy_body for the same policy (the
        # cross-repo signing contract). Pinned identically in both test suites.
        from lct_python_backend.services.synthesis.contact_policy import _canonical_policy_body
        p = ContactPrivacyPolicy("c1", enabled=True, local_llm_ok=True, external_llm_ok=False,
                                 privacy_norms={}, redaction_map_id="tc-canonical-v1",
                                 contract_version="1.0.0")
        golden = ('{"contact_id":"c1","contract_version":"1.0.0","enabled":true,'
                  '"external_llm_ok":false,"local_llm_ok":true,"privacy_norms":{},'
                  '"redaction_map_id":"tc-canonical-v1"}')
        assert _canonical_policy_body(p) == golden


class TestSignatureRoundTrip:
    def test_valid_accepted_and_tamper_rejected(self):
        pytest.importorskip("eth_account")
        from eth_account import Account
        from eth_account.messages import encode_defunct
        from lct_python_backend.services.synthesis.contact_policy import _canonical_policy_body

        key = "0x" + "11" * 32
        acct = Account.from_key(key)
        p = ContactPrivacyPolicy("c1", enabled=True, local_llm_ok=True, external_llm_ok=True,
                                 privacy_norms={"x": 1}, redaction_map_id="tc-canonical-v1",
                                 contract_version="1.0.0")
        signed = Account.sign_message(encode_defunct(text=_canonical_policy_body(p)), private_key=key)
        p.signature = signed.signature.hex()
        p.signer_pubkey = acct.address
        assert verify_signature(p, require=True) is True  # valid passes mandatory

        p.external_llm_ok = False  # tamper a field → signature no longer matches
        assert verify_signature(p, require=False) is False  # rejected even advisory


class TestStrictBoolParsing:
    def test_as_bool_truth_table(self):
        assert _as_bool(True) is True
        assert _as_bool(1) is True
        assert _as_bool("yes") is True
        assert _as_bool("TRUE") is True
        # Fail-closed: anything odd → False, never accidental consent.
        assert _as_bool("false") is False
        assert _as_bool("0") is False
        assert _as_bool(None) is False
        assert _as_bool({"x": 1}) is False

    def test_string_false_does_not_grant_consent(self):
        # The codex finding: bool("false") was True → would wrongly grant external.
        p = _parse_policy("a", {"enabled": "true", "external_llm_ok": "false", "local_llm_ok": "0"})
        assert p.enabled is True
        assert p.external_llm_ok is False
        assert p.local_llm_ok is False


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
