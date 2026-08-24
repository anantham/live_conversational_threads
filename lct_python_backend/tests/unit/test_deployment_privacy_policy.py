"""Behavioral contract for deployment-aware transcript and LLM privacy policy.

Test Intent:
- Personal-private installs retain explicitly owner-local raw transcripts by default.
- Hosted/shared installs refuse raw retention even if the retired escape hatch is set.
- Conversation consent filters enabled providers by explicit trust scope and fails closed.
- Missing or invalid provider trust metadata is never inferred from its URL.
"""

import pytest

from lct_python_backend.services.deployment_privacy_policy import (
    DeploymentPrivacyError,
    assert_raw_transcript_retention_allowed,
    constrain_llm_config_for_privacy,
    select_providers_for_privacy,
)


def _provider(provider_id, trust_scope=None, *, enabled=True):
    provider = {
        "id": provider_id,
        "name": provider_id,
        "enabled": enabled,
        "base_url": "http://127.0.0.1:1234",
        "model": "test-model",
    }
    if trust_scope is not None:
        provider["trust_scope"] = trust_scope
    return provider


def test_personal_private_is_the_single_owner_default(monkeypatch):
    monkeypatch.delenv("LCT_DEPLOYMENT_PROFILE", raising=False)
    monkeypatch.delenv("LCT_MIRROR_RAW", raising=False)

    assert_raw_transcript_retention_allowed()


def test_hosted_shared_refuses_raw_even_with_legacy_escape_hatch(monkeypatch):
    monkeypatch.setenv("LCT_DEPLOYMENT_PROFILE", "hosted_shared")
    monkeypatch.setenv("LCT_MIRROR_RAW", "1")

    with pytest.raises(DeploymentPrivacyError, match="hosted_shared"):
        assert_raw_transcript_retention_allowed()


def test_unknown_deployment_profile_fails_closed(monkeypatch):
    monkeypatch.setenv("LCT_DEPLOYMENT_PROFILE", "typo-profile")

    with pytest.raises(DeploymentPrivacyError, match="Unsupported LCT_DEPLOYMENT_PROFILE"):
        assert_raw_transcript_retention_allowed()


def test_private_conversation_uses_only_enabled_owner_private_provider():
    providers = [
        _provider("m5", "owner_private"),
        _provider("cloud", "external"),
        _provider("sleeping-private", "owner_private", enabled=False),
    ]

    selected = select_providers_for_privacy(
        providers,
        {"local_llm_ok": True, "external_llm_ok": False},
    )

    assert [provider["id"] for provider in selected] == ["m5"]


def test_external_only_conversation_excludes_owner_private_provider():
    providers = [
        _provider("m5", "owner_private"),
        _provider("cloud", "external"),
    ]

    selected = select_providers_for_privacy(
        providers,
        {"local_llm_ok": False, "external_llm_ok": True},
    )

    assert [provider["id"] for provider in selected] == ["cloud"]


@pytest.mark.parametrize("trust_scope", [None, "", "private-ish"])
def test_missing_or_invalid_trust_scope_is_external_not_url_inferred(trust_scope):
    providers = [_provider("looks-local", trust_scope)]

    with pytest.raises(DeploymentPrivacyError, match="No enabled LLM provider"):
        select_providers_for_privacy(
            providers,
            {"local_llm_ok": True, "external_llm_ok": False},
        )


def test_missing_conversation_privacy_fails_closed():
    with pytest.raises(DeploymentPrivacyError, match="No enabled LLM provider"):
        select_providers_for_privacy([_provider("m5", "owner_private")], None)


def test_external_denial_forces_direct_online_mode_to_local():
    constrained = constrain_llm_config_for_privacy(
        {"mode": "online", "chat_model": "gemini-test"},
        {"local_llm_ok": True, "external_llm_ok": False},
    )

    assert constrained == {"mode": "local", "chat_model": "gemini-test"}
