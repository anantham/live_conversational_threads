"""Live setup must restore before reading backlog, under the session lock."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from lct_python_backend.services.stt import interleaved_live as mod


@pytest.mark.asyncio
async def test_live_setup_uses_stored_privacy_committed_cursor_and_processor_lock(monkeypatch):
    lock = asyncio.Lock()
    seen = []
    async def handle(text, **kwargs):
        assert lock.locked()
        seen.append(kwargs["utterance_id"])
    processor = SimpleNamespace(
        _passage_commit=SimpleNamespace(recover=AsyncMock(), journal=SimpleNamespace(recover=AsyncMock(return_value={"committed_through": 7}))),
        handle_final_text=handle, flush=AsyncMock(),
    )
    config = SimpleNamespace(build=Mock(return_value=processor), session_factory=object())
    conversation = SimpleNamespace(id="conversation", owner_id="owner", deleted_at=None,
                                   source_metadata={"privacy": {"local_llm_ok": True}})
    async def read(factory, **kwargs):
        assert factory is config.session_factory
        assert kwargs["owner_id"] == "owner"
        return [{"id": "u8", "sequence_number": 8, "text": "persisted", "speaker_id": "S0"}] if kwargs["after_sequence"] == 7 else []
    monkeypatch.setattr(mod, "read_owned_source_page", read)
    restored, pump = await mod.prepare_live_passages(config=config, conversation=conversation, owner_id="owner",
        providers=[], send_update=None, send_status=None, processor_lock=lock)
    assert restored is processor
    processor._passage_commit.recover.assert_awaited_once()
    assert config.build.call_args.kwargs["privacy"] == {"local_llm_ok": True}
    pump.notify()
    await pump.drain()
    assert seen == ["u8"]


@pytest.mark.asyncio
async def test_foreign_or_deleted_conversation_fails_before_runtime_build():
    config = SimpleNamespace(build=Mock(side_effect=AssertionError("must not construct")))
    for owner, deleted in [("other", None), ("owner", "deleted")]:
        with pytest.raises(PermissionError):
            await mod.prepare_live_passages(config=config,
                conversation=SimpleNamespace(owner_id=owner, deleted_at=deleted), owner_id="owner",
                providers=[], send_update=None, send_status=None, processor_lock=asyncio.Lock())
