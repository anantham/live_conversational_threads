"""Tests for the current-owner resolution seam (ADR-034 Step 1).

The seam is the single chokepoint for "who owns this request's data" during
the single-user phase, and the fix for the client-controlled-owner hazard
(§F #2): client-supplied owner values must be ignored.
"""

import importlib

import pytest

from lct_python_backend.services import owner_context


@pytest.fixture(autouse=True)
def _clear_owner_env(monkeypatch):
    monkeypatch.delenv("LCT_OWNER_ID", raising=False)


def test_default_owner_id():
    assert owner_context.get_current_owner_id() == owner_context.DEFAULT_OWNER_ID
    assert owner_context.DEFAULT_OWNER_ID == "usr_aditya"


def test_owner_id_env_override(monkeypatch):
    monkeypatch.setenv("LCT_OWNER_ID", "usr_someone_else")
    assert owner_context.get_current_owner_id() == "usr_someone_else"


def test_blank_env_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("LCT_OWNER_ID", "   ")
    assert owner_context.get_current_owner_id() == owner_context.DEFAULT_OWNER_ID


def test_resolve_owner_id_ignores_client_supplied_value():
    """§F hazard #2: a spoofed owner_id from client metadata must NOT win."""
    assert owner_context.resolve_owner_id("victim@example.com") == "usr_aditya"
    assert owner_context.resolve_owner_id("default_user") == "usr_aditya"
    assert owner_context.resolve_owner_id(None) == "usr_aditya"


def test_resolve_owner_id_honors_env_owner(monkeypatch):
    monkeypatch.setenv("LCT_OWNER_ID", "usr_real")
    # Even a client claiming a different owner gets the configured owner.
    assert owner_context.resolve_owner_id("usr_attacker") == "usr_real"
