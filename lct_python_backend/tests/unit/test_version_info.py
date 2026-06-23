"""Unit tests for version_info: payload shape, canonical-python detection, and
the warn-by-default / enforce-under-flag startup guard."""

import logging
import sys

import pytest

from lct_python_backend import version_info


def test_get_version_info_shape():
    info = version_info.get_version_info()
    for key in (
        "service", "git_sha", "git_dirty", "python_executable", "python_version",
        "canonical_python", "canonical_marker", "pid", "cwd", "repo_root", "started_at",
    ):
        assert key in info
    assert info["service"] == "lct_backend"
    assert isinstance(info["pid"], int)
    assert isinstance(info["canonical_python"], bool)
    # git_sha is captured eagerly at import: a real sha (>=7 hex) or "unknown".
    assert info["git_sha"] == "unknown" or len(info["git_sha"]) >= 7
    # git_dirty is a bool when git is available, else None (paired with "unknown").
    assert info["git_dirty"] in (True, False, None)


def test_is_canonical_python_marker_match(monkeypatch):
    monkeypatch.setattr(version_info, "CANONICAL_PYTHON_MARKER", ".venv")
    monkeypatch.setattr(sys, "executable", r"C:/repo/.venv/Scripts/python.exe")
    assert version_info.is_canonical_python() is True
    monkeypatch.setattr(sys, "executable", r"C:/Users/x/anaconda3/python.exe")
    assert version_info.is_canonical_python() is False


def test_check_canonical_python_canonical_is_noop(monkeypatch):
    monkeypatch.setattr(version_info, "CANONICAL_PYTHON_MARKER", ".venv")
    monkeypatch.setattr(sys, "executable", r"C:/repo/.venv/Scripts/python.exe")
    assert version_info.check_canonical_python() is None  # no warn, no exit


def test_check_canonical_python_warns_by_default(monkeypatch, caplog):
    monkeypatch.setattr(version_info, "CANONICAL_PYTHON_MARKER", ".venv")
    monkeypatch.setattr(sys, "executable", r"C:/Users/x/anaconda3/python.exe")
    monkeypatch.delenv("LCT_REQUIRE_CANONICAL_PYTHON", raising=False)
    with caplog.at_level(logging.WARNING, logger="lct_backend"):
        result = version_info.check_canonical_python()  # MUST NOT raise
    assert result is None
    assert any("non-canonical python" in r.message for r in caplog.records)


def test_check_canonical_python_enforced_exits(monkeypatch):
    monkeypatch.setattr(version_info, "CANONICAL_PYTHON_MARKER", ".venv")
    monkeypatch.setattr(sys, "executable", r"C:/Users/x/anaconda3/python.exe")
    monkeypatch.setenv("LCT_REQUIRE_CANONICAL_PYTHON", "1")
    with pytest.raises(SystemExit):
        version_info.check_canonical_python()


@pytest.mark.parametrize("val", ["1", "true", "YES", "on"])
def test_enforce_flag_truthy_variants_exit(monkeypatch, val):
    monkeypatch.setattr(version_info, "CANONICAL_PYTHON_MARKER", ".venv")
    monkeypatch.setattr(sys, "executable", r"C:/anaconda3/python.exe")
    monkeypatch.setenv("LCT_REQUIRE_CANONICAL_PYTHON", val)
    with pytest.raises(SystemExit):
        version_info.check_canonical_python()
