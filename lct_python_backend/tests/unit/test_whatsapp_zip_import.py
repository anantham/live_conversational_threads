"""Tests for the WhatsApp zip pre-processing step (unzip -> parse -> caption ->
join), used by /api/import/process-file before a .zip re-enters the normal
text upload pipeline as a plain "Speaker: text" transcript."""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from lct_python_backend.services.import_pipeline import whatsapp_zip_import as wzi


def _make_zip(tmp_path: Path, *, chat_text: str, files: dict[str, bytes]) -> Path:
    zip_path = tmp_path / "export.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("_chat.txt", chat_text)
        for name, content in files.items():
            zf.writestr(name, content)
    return zip_path


@pytest.mark.asyncio
async def test_build_transcript_text_happy_path(tmp_path, monkeypatch):
    async def fake_caption(image_bytes, *, mime_type, filename, providers=None):
        return f"stub caption for {filename}"

    monkeypatch.setattr(wzi, "caption_image", fake_caption)

    chat_text = (
        "[01/02/2026, 09:15:03] Alice: Hey everyone\n"
        "[01/02/2026, 09:15:40] Bob: <attached: IMG-0001.jpg>\n"
        "[01/02/2026, 09:16:00] Alice: nice pic\n"
    )
    zip_path = _make_zip(tmp_path, chat_text=chat_text, files={"IMG-0001.jpg": b"\xff\xd8\xff\xe0fakejpeg"})

    events = []

    async def emit(event_type, payload):
        events.append((event_type, payload))

    result = await wzi.build_whatsapp_transcript_text(zip_path, emit=emit)

    assert "Alice: Hey everyone" in result
    assert "Bob: [Image: stub caption for IMG-0001.jpg]" in result
    assert "<attached:" not in result
    assert any(e == "status" for e, _ in events)


@pytest.mark.asyncio
async def test_build_transcript_text_no_images_skips_captioning(tmp_path, monkeypatch):
    called = False

    async def fake_caption(*args, **kwargs):
        nonlocal called
        called = True
        return "should not be called"

    monkeypatch.setattr(wzi, "caption_image", fake_caption)

    chat_text = "[01/02/2026, 09:15:03] Alice: hello\n"
    zip_path = _make_zip(tmp_path, chat_text=chat_text, files={})

    result = await wzi.build_whatsapp_transcript_text(zip_path)

    assert result == "Alice: hello"
    assert called is False


def test_safe_extract_rejects_zip_slip(tmp_path):
    zip_path = tmp_path / "evil.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("../../evil.txt", "pwned")

    dest = tmp_path / "extract_dest"
    dest.mkdir()
    with pytest.raises(ValueError, match="unsafe path"):
        wzi._safe_extract(zip_path, dest)


def test_safe_extract_rejects_too_many_files(tmp_path, monkeypatch):
    monkeypatch.setattr(wzi, "MAX_FILE_COUNT", 2)
    zip_path = tmp_path / "many.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("a.txt", "a")
        zf.writestr("b.txt", "b")
        zf.writestr("c.txt", "c")

    dest = tmp_path / "extract_dest2"
    dest.mkdir()
    with pytest.raises(ValueError, match="too many files"):
        wzi._safe_extract(zip_path, dest)


def test_safe_extract_rejects_oversized_zip(tmp_path, monkeypatch):
    monkeypatch.setattr(wzi, "MAX_EXTRACTED_BYTES", 10)
    zip_path = tmp_path / "big.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("big.txt", "x" * 1000)

    dest = tmp_path / "extract_dest3"
    dest.mkdir()
    with pytest.raises(ValueError, match="too large"):
        wzi._safe_extract(zip_path, dest)


def test_find_chat_text_file_prefers_chat_named(tmp_path):
    extract_dir = tmp_path / "extracted"
    extract_dir.mkdir()
    (extract_dir / "README.txt").write_text("not the chat")
    (extract_dir / "_chat.txt").write_text("the real chat")

    found = wzi._find_chat_text_file(extract_dir)
    assert found.name == "_chat.txt"


def test_find_chat_text_file_raises_when_none(tmp_path):
    extract_dir = tmp_path / "extracted_empty"
    extract_dir.mkdir()
    with pytest.raises(ValueError, match="no .txt chat transcript"):
        wzi._find_chat_text_file(extract_dir)
