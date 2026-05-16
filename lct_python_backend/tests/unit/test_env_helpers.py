"""Tests for env_str / env_bool / env_int / env_float helpers."""

from __future__ import annotations

import pytest

from lct_python_backend.services.env_helpers import (
    env_bool,
    env_float,
    env_int,
    env_str,
    env_str_or_none,
)


# ---------------------------------------------------------------------------
# env_str
# ---------------------------------------------------------------------------


def test_env_str_returns_default_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LCT_TEST_STR", raising=False)
    assert env_str("LCT_TEST_STR", "fallback") == "fallback"


def test_env_str_returns_value_when_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LCT_TEST_STR", "hello")
    assert env_str("LCT_TEST_STR", "fallback") == "hello"


def test_env_str_strips_whitespace(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LCT_TEST_STR", "  spaced  ")
    assert env_str("LCT_TEST_STR", "fallback") == "spaced"


def test_env_str_empty_after_strip_returns_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LCT_TEST_STR", "   ")
    assert env_str("LCT_TEST_STR", "fallback") == "fallback"


def test_env_str_no_default_returns_empty_string(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LCT_TEST_STR", raising=False)
    assert env_str("LCT_TEST_STR") == ""


# ---------------------------------------------------------------------------
# env_bool
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("value", ["1", "true", "True", "TRUE", "yes", "YES", "on", "y", "t"])
def test_env_bool_truthy(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("LCT_TEST_BOOL", value)
    assert env_bool("LCT_TEST_BOOL", default=False) is True


@pytest.mark.parametrize("value", ["0", "false", "False", "FALSE", "no", "off", "n", "f", "", "   "])
def test_env_bool_falsy(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("LCT_TEST_BOOL", value)
    assert env_bool("LCT_TEST_BOOL", default=True) is False


def test_env_bool_unrecognized_returns_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LCT_TEST_BOOL", "maybe")
    assert env_bool("LCT_TEST_BOOL", default=True) is True
    assert env_bool("LCT_TEST_BOOL", default=False) is False


def test_env_bool_unset_returns_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LCT_TEST_BOOL", raising=False)
    assert env_bool("LCT_TEST_BOOL", default=True) is True
    assert env_bool("LCT_TEST_BOOL", default=False) is False


# ---------------------------------------------------------------------------
# env_int / env_float
# ---------------------------------------------------------------------------


def test_env_int_parses_valid(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LCT_TEST_INT", "42")
    assert env_int("LCT_TEST_INT", 0) == 42


def test_env_int_negative(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LCT_TEST_INT", "-7")
    assert env_int("LCT_TEST_INT", 0) == -7


def test_env_int_invalid_returns_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LCT_TEST_INT", "not a number")
    assert env_int("LCT_TEST_INT", 99) == 99


def test_env_int_empty_returns_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LCT_TEST_INT", "   ")
    assert env_int("LCT_TEST_INT", 5) == 5


def test_env_float_parses_valid(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LCT_TEST_FLOAT", "3.14")
    assert env_float("LCT_TEST_FLOAT", 0.0) == pytest.approx(3.14)


def test_env_float_int_string_works(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LCT_TEST_FLOAT", "5")
    assert env_float("LCT_TEST_FLOAT", 0.0) == pytest.approx(5.0)


def test_env_float_invalid_returns_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LCT_TEST_FLOAT", "not a number")
    assert env_float("LCT_TEST_FLOAT", 1.5) == pytest.approx(1.5)


# ---------------------------------------------------------------------------
# env_str_or_none
# ---------------------------------------------------------------------------


def test_env_str_or_none_returns_none_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LCT_TEST_OPT", raising=False)
    assert env_str_or_none("LCT_TEST_OPT") is None


def test_env_str_or_none_returns_none_when_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LCT_TEST_OPT", "   ")
    assert env_str_or_none("LCT_TEST_OPT") is None


def test_env_str_or_none_returns_stripped_value(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LCT_TEST_OPT", "  hello  ")
    assert env_str_or_none("LCT_TEST_OPT") == "hello"
