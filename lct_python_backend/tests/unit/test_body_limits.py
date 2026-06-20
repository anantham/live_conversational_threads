"""Tests for body_limits helpers."""

import lct_python_backend.body_limits as body_limits


def test_resolve_body_byte_limit_json():
    assert body_limits.resolve_body_byte_limit(
        path="/api/settings/llm",
        content_type="application/json",
    ) == body_limits.MAX_JSON_BYTES


def test_resolve_body_byte_limit_upload_route(monkeypatch):
    monkeypatch.setattr(body_limits, "MAX_UPLOAD_BYTES", 999)
    monkeypatch.setattr(body_limits, "MAX_BODY_BYTES", 100)
    assert body_limits.resolve_body_byte_limit(
        path="/api/import/process-file",
        content_type="multipart/form-data",
    ) == 999


def test_resolve_body_byte_limit_default():
    assert body_limits.resolve_body_byte_limit(
        path="/api/other",
        content_type="application/octet-stream",
    ) == body_limits.MAX_BODY_BYTES