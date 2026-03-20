"""Tests for shared coercion helpers."""

import pytest

from lct_python_backend.services.coercion_helpers import (
    coerce_float,
    coerce_int,
    coerce_str,
    coerce_url,
    safe_float,
    safe_int,
    to_bool,
)


# ---------------------------------------------------------------------------
# to_bool
# ---------------------------------------------------------------------------


class TestToBool:
    @pytest.mark.parametrize("value", [True, "1", "true", "True", "TRUE", "yes", "on"])
    def test_truthy(self, value):
        assert to_bool(value) is True

    @pytest.mark.parametrize("value", [False, "0", "false", "False", "FALSE", "no", "off"])
    def test_falsy(self, value):
        assert to_bool(value) is False

    def test_none_uses_default(self):
        assert to_bool(None) is False
        assert to_bool(None, default=True) is True

    def test_empty_string_uses_default(self):
        assert to_bool("") is False
        assert to_bool("", default=True) is True

    def test_unrecognised_uses_default(self):
        assert to_bool("maybe") is False
        assert to_bool("maybe", default=True) is True

    def test_whitespace_stripped(self):
        assert to_bool("  true  ") is True
        assert to_bool("  false  ") is False

    def test_bool_passthrough(self):
        assert to_bool(True) is True
        assert to_bool(False) is False


# ---------------------------------------------------------------------------
# coerce_str
# ---------------------------------------------------------------------------


class TestCoerceStr:
    def test_none(self):
        assert coerce_str(None) == ""

    def test_string(self):
        assert coerce_str("hello") == "hello"

    def test_strips_whitespace(self):
        assert coerce_str("  hello  ") == "hello"

    def test_int(self):
        assert coerce_str(42) == "42"

    def test_bool(self):
        assert coerce_str(True) == "True"


# ---------------------------------------------------------------------------
# coerce_float / safe_float
# ---------------------------------------------------------------------------


class TestCoerceFloat:
    def test_none(self):
        assert coerce_float(None) is None

    def test_valid_string(self):
        assert coerce_float("3.14") == pytest.approx(3.14)

    def test_int(self):
        assert coerce_float(42) == 42.0

    def test_invalid(self):
        assert coerce_float("not_a_number") is None

    def test_empty_string(self):
        assert coerce_float("") is None


class TestSafeFloat:
    def test_valid(self):
        assert safe_float("3.14") == pytest.approx(3.14)

    def test_invalid_returns_default(self):
        assert safe_float("bad", default=1.5) == 1.5

    def test_none_returns_default(self):
        assert safe_float(None, default=0.0) == 0.0


# ---------------------------------------------------------------------------
# coerce_int / safe_int
# ---------------------------------------------------------------------------


class TestCoerceInt:
    def test_none(self):
        assert coerce_int(None) is None

    def test_valid_string(self):
        assert coerce_int("42") == 42

    def test_float_truncates(self):
        assert coerce_int(3.9) == 3

    def test_invalid(self):
        assert coerce_int("abc") is None


class TestSafeInt:
    def test_valid(self):
        assert safe_int("42") == 42

    def test_invalid_returns_default(self):
        assert safe_int("bad", default=10) == 10


# ---------------------------------------------------------------------------
# coerce_url
# ---------------------------------------------------------------------------


class TestCoerceUrl:
    def test_none(self):
        assert coerce_url(None) == ""

    def test_strips_trailing_slash(self):
        assert coerce_url("http://example.com/") == "http://example.com"

    def test_strips_whitespace(self):
        assert coerce_url("  http://example.com  ") == "http://example.com"

    def test_empty(self):
        assert coerce_url("") == ""

    def test_preserves_path(self):
        assert coerce_url("http://host:8080/v1/api") == "http://host:8080/v1/api"
