"""Tests for import validation helpers — SSRF guard, filename, URL checks."""

import pytest
from fastapi import HTTPException

from lct_python_backend.services.import_pipeline.import_validation import (
    _is_disallowed_import_host,
    get_supported_import_formats,
    validate_import_url,
    validate_transcript_filename,
)


# ---------------------------------------------------------------------------
# _is_disallowed_import_host
# ---------------------------------------------------------------------------


class TestIsDisallowedImportHost:
    @pytest.mark.parametrize(
        "host",
        [
            "localhost",
            "127.0.0.1",
            "::1",
            "10.0.0.1",
            "192.168.1.1",
            "172.16.0.1",
            "[::1]",
            "host.local",
            "server.internal",
            "something.localhost",
        ],
    )
    def test_blocked_hosts(self, host):
        assert _is_disallowed_import_host(host) is True

    @pytest.mark.parametrize(
        "host",
        [
            "example.com",
            "api.openai.com",
            "8.8.8.8",
            "github.com",
        ],
    )
    def test_allowed_hosts(self, host):
        assert _is_disallowed_import_host(host) is False

    def test_empty_host_blocked(self):
        assert _is_disallowed_import_host("") is True

    def test_ipv4_mapped_loopback(self):
        """IPv4-mapped IPv6 loopback should be blocked."""
        assert _is_disallowed_import_host("::ffff:127.0.0.1") is True

    def test_link_local_ipv6(self):
        assert _is_disallowed_import_host("fe80::1") is True

    def test_multicast(self):
        assert _is_disallowed_import_host("224.0.0.1") is True


# ---------------------------------------------------------------------------
# validate_import_url
# ---------------------------------------------------------------------------


class TestValidateImportUrl:
    def test_valid_https_url(self):
        result = validate_import_url("https://example.com/transcript.txt")
        assert "example.com" in result

    def test_valid_http_url(self):
        result = validate_import_url("http://example.com/file.txt")
        assert "example.com" in result

    def test_ftp_rejected(self):
        with pytest.raises(HTTPException) as exc_info:
            validate_import_url("ftp://example.com/file.txt")
        assert exc_info.value.status_code == 400

    def test_no_scheme_rejected(self):
        with pytest.raises(HTTPException) as exc_info:
            validate_import_url("example.com/file.txt")
        assert exc_info.value.status_code == 400

    def test_localhost_rejected(self):
        with pytest.raises(HTTPException) as exc_info:
            validate_import_url("http://localhost:8000/file.txt")
        assert exc_info.value.status_code == 400

    def test_private_ip_rejected(self):
        with pytest.raises(HTTPException) as exc_info:
            validate_import_url("http://192.168.1.1/file.txt")
        assert exc_info.value.status_code == 400

    def test_empty_url_rejected(self):
        with pytest.raises(HTTPException):
            validate_import_url("")

    def test_none_rejected(self):
        with pytest.raises(HTTPException):
            validate_import_url(None)


# ---------------------------------------------------------------------------
# validate_transcript_filename
# ---------------------------------------------------------------------------


class TestValidateTranscriptFilename:
    @pytest.mark.parametrize("filename", ["meeting.pdf", "notes.txt", "log.text"])
    def test_valid_extensions(self, filename):
        ext = validate_transcript_filename(filename)
        assert ext in {".pdf", ".txt", ".text"}

    def test_case_insensitive(self):
        ext = validate_transcript_filename("meeting.PDF")
        assert ext == ".pdf"

    def test_unsupported_extension(self):
        with pytest.raises(HTTPException) as exc_info:
            validate_transcript_filename("meeting.docx")
        assert exc_info.value.status_code == 400

    def test_no_extension(self):
        with pytest.raises(HTTPException):
            validate_transcript_filename("meeting")

    def test_empty_filename(self):
        with pytest.raises(HTTPException):
            validate_transcript_filename("")

    def test_none_filename(self):
        with pytest.raises(HTTPException):
            validate_transcript_filename(None)


# ---------------------------------------------------------------------------
# get_supported_import_formats
# ---------------------------------------------------------------------------


class TestGetSupportedImportFormats:
    def test_without_url_import(self):
        formats = get_supported_import_formats(url_import_enabled=False)
        assert "url" not in formats
        assert "pdf" in formats
        assert "txt" in formats

    def test_with_url_import(self):
        formats = get_supported_import_formats(url_import_enabled=True)
        assert "url" in formats
