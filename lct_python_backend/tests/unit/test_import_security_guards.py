"""Tests for the upload content-type whitelist and the SSRF URL guard."""

from __future__ import annotations

import importlib
import sys
import types

import pytest
from fastapi import HTTPException

from lct_python_backend.services.import_validation import (
    assert_url_resolves_to_public_host,
)


def _load_import_api_with_db_stub():
    """Import import_api with db_session stubbed out, so module-level
    create_async_engine doesn't blow up without DATABASE_URL."""

    async def dummy_get_async_session():
        yield object()

    dummy_db_session = types.ModuleType("lct_python_backend.db_session")
    dummy_db_session.get_async_session = dummy_get_async_session
    sys.modules["lct_python_backend.db_session"] = dummy_db_session
    sys.modules.pop("lct_python_backend.import_api", None)
    return importlib.import_module("lct_python_backend.import_api")


_import_api = _load_import_api_with_db_stub()
_validate_upload_file = _import_api._validate_upload_file
_ALLOWED_AUDIO_SUFFIXES = _import_api._ALLOWED_AUDIO_SUFFIXES
_ALLOWED_TEXT_SUFFIXES = _import_api._ALLOWED_TEXT_SUFFIXES


class _FakeUpload:
    def __init__(self, filename: str, content_type: str) -> None:
        self.filename = filename
        self.content_type = content_type


# ---------------------------------------------------------------------------
# Content-type whitelist
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("suffix", sorted(_ALLOWED_AUDIO_SUFFIXES))
def test_allowed_audio_suffix_is_accepted(suffix: str) -> None:
    _validate_upload_file(_FakeUpload(f"clip{suffix}", "application/octet-stream"))


@pytest.mark.parametrize("suffix", sorted(_ALLOWED_TEXT_SUFFIXES))
def test_allowed_text_suffix_is_accepted(suffix: str) -> None:
    _validate_upload_file(_FakeUpload(f"transcript{suffix}", ""))


def test_audio_content_type_accepted_even_with_no_suffix() -> None:
    _validate_upload_file(_FakeUpload("recording", "audio/wav"))
    _validate_upload_file(_FakeUpload("recording", "audio/x-wav"))


def test_charset_parameter_stripped() -> None:
    _validate_upload_file(_FakeUpload("notes.txt", "text/plain; charset=utf-8"))


def test_unknown_suffix_with_unknown_ct_rejected() -> None:
    with pytest.raises(HTTPException) as info:
        _validate_upload_file(_FakeUpload("malware.exe", "application/x-msdownload"))
    assert info.value.status_code == 400


def test_no_filename_no_ct_rejected() -> None:
    with pytest.raises(HTTPException):
        _validate_upload_file(_FakeUpload("", ""))


def test_audio_wildcard_ct_accepted() -> None:
    _validate_upload_file(_FakeUpload("clip", "audio/x-vendor-format"))


# ---------------------------------------------------------------------------
# SSRF guard (DNS-resolved)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("blocked_url", [
    "http://127.0.0.1/x",
    "http://127.0.0.1:7777/api/transcribe",
    "http://[::1]/x",
    "http://10.0.0.5/x",
    "http://192.168.1.1/x",
    "http://172.16.0.1/x",
    "http://169.254.169.254/latest/meta-data",
    "http://0.0.0.0/x",
    "http://[fe80::1]/x",
])
def test_blocks_internal_addresses(blocked_url: str) -> None:
    with pytest.raises(HTTPException) as info:
        assert_url_resolves_to_public_host(blocked_url)
    assert info.value.status_code == 400


@pytest.mark.parametrize("bad_scheme", [
    "file:///etc/passwd",
    "ftp://example.com/x",
    "gopher://example.com/x",
])
def test_blocks_non_http_schemes(bad_scheme: str) -> None:
    with pytest.raises(HTTPException) as info:
        assert_url_resolves_to_public_host(bad_scheme)
    assert info.value.status_code == 400


def test_empty_host_rejected() -> None:
    with pytest.raises(HTTPException):
        assert_url_resolves_to_public_host("http:///path")
