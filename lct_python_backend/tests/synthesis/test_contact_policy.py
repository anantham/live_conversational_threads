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


class TestStrictLoopback:
    def test_predicate(self):
        from lct_python_backend.services.synthesis.contact_policy import _is_strict_loopback
        assert _is_strict_loopback("127.0.0.1") is True
        assert _is_strict_loopback("localhost") is True
        assert _is_strict_loopback("::1") is True
        # NOT loopback — Tailscale / LAN are a different trust boundary (finding #2).
        assert _is_strict_loopback("100.83.228.35") is False
        assert _is_strict_loopback("192.168.1.10") is False
        assert _is_strict_loopback("") is False


class TestMalformedNormsFailClosed:
    def test_malformed_norms_denies_external(self):
        from lct_python_backend.services.synthesis.contact_policy import _parse_policy
        p = _parse_policy("c1", {
            "contact_id": "c1", "enabled": True, "local_llm_ok": True,
            "external_llm_ok": True, "privacy_norms": "{not valid json",
        })
        assert p.external_llm_ok is False  # fail-closed
        assert p.privacy_norms == {}


class TestContactIdValidation:
    def test_mismatched_contact_id_fails_closed(self, monkeypatch):
        monkeypatch.setenv("ENABLE_INDRASNET", "1")
        monkeypatch.setenv("INDRASNET_BASE_URL", "http://127.0.0.1:7777")

        class _Resp:
            status_code = 200

            def json(self):
                return {"contact_id": "SOMEONE_ELSE", "external_llm_ok": True, "local_llm_ok": True}

        class _Client:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def get(self, *a, **k):
                return _Resp()

        monkeypatch.setattr(contact_policy.httpx, "Client", lambda *a, **k: _Client())
        assert fetch_policy("c1").is_default is True


class TestSignatureRoundTrip:
    def _signed(self, key, **over):
        from eth_account import Account
        from eth_account.messages import encode_defunct
        from lct_python_backend.services.synthesis.contact_policy import _canonical_policy_body
        acct = Account.from_key(key)
        p = ContactPrivacyPolicy("c1", enabled=True, local_llm_ok=True, external_llm_ok=True,
                                 privacy_norms={"x": 1}, redaction_map_id="tc-canonical-v1",
                                 contract_version="1.0.0", **over)
        signed = Account.sign_message(encode_defunct(text=_canonical_policy_body(p)), private_key=key)
        p.signature = signed.signature.hex()
        p.signer_pubkey = acct.address
        return p, acct.address

    def test_valid_with_trusted_pin_passes_mandatory(self, monkeypatch):
        pytest.importorskip("eth_account")
        p, addr = self._signed("0x" + "11" * 32)
        monkeypatch.setenv("SYNTHESIS_TRUSTED_POLICY_SIGNERS", addr)
        assert verify_signature(p, require=True) is True

    def test_unpinned_advisory_allows_but_mandatory_rejects(self, monkeypatch):
        pytest.importorskip("eth_account")
        monkeypatch.delenv("SYNTHESIS_TRUSTED_POLICY_SIGNERS", raising=False)
        p, addr = self._signed("0x" + "11" * 32)
        assert verify_signature(p, require=False) is True   # loopback advisory
        assert verify_signature(p, require=True) is False    # federation needs a pin

    def test_untrusted_signer_rejected_even_self_consistent(self, monkeypatch):
        # codex finding #1: attacker self-signs + sets signer_pubkey to their own addr.
        # With a pin configured, their address isn't trusted → rejected.
        pytest.importorskip("eth_account")
        p, addr = self._signed("0x" + "11" * 32)
        monkeypatch.setenv("SYNTHESIS_TRUSTED_POLICY_SIGNERS", "0x" + "22" * 20)
        assert verify_signature(p, require=True) is False
        assert verify_signature(p, require=False) is False

    def test_tamper_rejected(self, monkeypatch):
        pytest.importorskip("eth_account")
        p, addr = self._signed("0x" + "11" * 32)
        monkeypatch.setenv("SYNTHESIS_TRUSTED_POLICY_SIGNERS", addr)
        p.external_llm_ok = False  # body changed after signing → recovered != signer
        assert verify_signature(p, require=False) is False


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
