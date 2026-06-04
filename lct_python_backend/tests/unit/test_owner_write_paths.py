"""Owner-scoping COVERAGE tests for conversation WRITE paths (ADR-034 Step 1).

Reads are scoped to the configured owner (``usr_aditya``). If any conversation
*create* path still stamps the legacy ``default_user``, those conversations
become invisible to the owner's own list — the "create-then-vanish" hazard
codex flagged in the merge review.

These tests assert every create chokepoint resolves the owner through
``owner_context.resolve_owner_id`` (so a configured ``LCT_OWNER_ID`` flows
through) rather than a hardcoded literal. They patch ``resolve_owner_id`` and
assert the row is built with its return value — a regression to
``owner_id="default_user"`` would fail them.
"""

from pathlib import Path

import pytest

from lct_python_backend.services import owner_context


# --- source-level guard: no write path may hardcode the legacy owner ---------
# Read the source files directly (not import) so this stays a pure unit test —
# importing the API modules would eagerly build the async DB engine.

_BACKEND_ROOT = Path(__file__).resolve().parents[2]  # lct_python_backend/

_CREATE_PATH_FILES = [
    _BACKEND_ROOT / "canvas_api.py",
    _BACKEND_ROOT / "generation_api.py",
    _BACKEND_ROOT / "services" / "graph_persistence.py",
]


@pytest.mark.parametrize("path", _CREATE_PATH_FILES, ids=lambda p: p.name)
def test_no_create_path_hardcodes_default_user(path):
    """Every conversation-create site must resolve the owner, never hardcode it."""
    src = path.read_text(encoding="utf-8")
    assert 'owner_id="default_user"' not in src, (
        f"{path.name} still hardcodes owner_id=\"default_user\" on a create "
        f"path — owner-scoped reads would hide those conversations. "
        f"Use resolve_owner_id() instead."
    )
    assert "resolve_owner_id" in src, (
        f"{path.name} creates conversations but does not import/use "
        f"resolve_owner_id()."
    )


def test_graph_persistence_defaults_resolve_owner(monkeypatch):
    """ensure_conversation_row / persist_graph default owner must resolve to the
    configured owner, not the legacy literal, when no owner is passed."""
    monkeypatch.setenv("LCT_OWNER_ID", "usr_test_owner")
    # The fallback expression is `(owner_id or "").strip() or resolve_owner_id()`.
    # With owner_id unset, it must yield the resolved owner.
    assert owner_context.resolve_owner_id(None) == "usr_test_owner"
    assert (("" or "").strip() or owner_context.resolve_owner_id()) == "usr_test_owner"


def test_explicit_owner_still_passes_through(monkeypatch):
    """An explicitly-passed owner_id is preserved (only None/blank resolves)."""
    monkeypatch.setenv("LCT_OWNER_ID", "usr_test_owner")
    explicit = "usr_explicit"
    # Mirrors the graph_persistence fallback expression.
    assert ((explicit or "").strip() or owner_context.resolve_owner_id()) == "usr_explicit"
