"""Tests for the M5 vision captioning helper used by the WhatsApp zip import."""

from __future__ import annotations

import pytest

from lct_python_backend.services import vision_caption
from lct_python_backend.services.local_llm_client import ProviderResult


def _fake_result(text: str) -> ProviderResult:
    return ProviderResult(
        data=text,
        provider_id="whatsapp-vision",
        provider_name="whatsapp vision (test)",
        model="test-model",
        base_url="http://100.83.228.35:11434",
        provider_type="openai_compatible",
    )


@pytest.mark.asyncio
async def test_caption_image_success(monkeypatch):
    async def fake_chat(messages, providers=None, require_json=True):
        # A multimodal message array must have passed through unmodified.
        assert isinstance(messages[0]["content"], list)
        assert messages[0]["content"][1]["type"] == "image_url"
        assert require_json is False
        return _fake_result("A cat sitting on a windowsill.")

    monkeypatch.setattr(
        "lct_python_backend.services.local_llm_client.chat_with_provider_fallback",
        fake_chat,
    )

    caption = await vision_caption.caption_image(b"fake-bytes", mime_type="image/jpeg", filename="cat.jpg")
    assert caption == "A cat sitting on a windowsill."


@pytest.mark.asyncio
async def test_caption_image_failure_returns_placeholder_not_raise(monkeypatch):
    async def fake_chat_boom(*args, **kwargs):
        raise RuntimeError("M5 unreachable")

    monkeypatch.setattr(
        "lct_python_backend.services.local_llm_client.chat_with_provider_fallback",
        fake_chat_boom,
    )

    caption = await vision_caption.caption_image(b"fake-bytes", mime_type="image/jpeg", filename="cat.jpg")
    assert "cat.jpg" in caption
    assert "captioning unavailable" in caption
