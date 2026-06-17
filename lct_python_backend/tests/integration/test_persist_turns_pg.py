"""Integration test: persist_turns + the P1 dedup indexes against real Postgres.

Skipped unless DATABASE_URL is set. Creates and then DELETES its own test
conversation (a unique ITEST-* group_id, cascade-cleaned), so it's safe to run
against a dev DB. This is the runtime verification the fake-session unit tests
can't give: real FK/cascade, JSONB source_metadata, the partial unique indexes,
and that valid dense RawTurns are NOT rejected.
"""

import asyncio
import os
import uuid

import pytest
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

DATABASE_URL = os.getenv("DATABASE_URL")

pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set")


def _async_url(url: str) -> str:
    if url.startswith("postgresql+asyncpg://"):
        return url
    return url.replace("postgresql://", "postgresql+asyncpg://", 1)


def _turn(seq: int):
    return {
        "seq": seq,
        "source_identifier": f"itest:{seq}",
        "speaker_id": "S0",
        "text": f"turn {seq}",
    }


def _payload(group_id: str, turns):
    from lct_python_backend.raw_turn_contract import RawTurnsPayloadV1

    return RawTurnsPayloadV1(
        group_id=group_id,
        conversation_name="P1A integration test",
        source_type="google_meet",
        owner_id="usr_aditya",
        privacy={"redaction_applied": True},
        turns=turns,
    )


async def _engine_session():
    engine = create_async_engine(_async_url(DATABASE_URL))
    # Match the backend's session config (db_session.py): without
    # expire_on_commit=False, attribute access after persist_turns' commit
    # triggers a lazy refresh outside the async greenlet → MissingGreenlet.
    return engine, AsyncSession(engine, expire_on_commit=False)


def test_p1_indexes_exist():
    async def scenario():
        engine, session = await _engine_session()
        try:
            rows = (
                await session.execute(
                    text(
                        "SELECT indexname FROM pg_indexes "
                        "WHERE indexname IN ("
                        "'uq_utterances_conv_seq','uq_utterances_conv_srcid',"
                        "'uq_conversations_owner_group')"
                    )
                )
            ).scalars().all()
            assert set(rows) == {
                "uq_utterances_conv_seq",
                "uq_utterances_conv_srcid",
                "uq_conversations_owner_group",
            }
        finally:
            await session.close()
            await engine.dispose()

    asyncio.run(scenario())


def test_persist_turns_roundtrip_and_replace():
    from lct_python_backend.models import Conversation, Utterance
    from lct_python_backend.services.graph_persistence import persist_turns

    group_id = f"ITEST-{uuid.uuid4().hex[:12]}"

    async def scenario():
        engine, session = await _engine_session()
        conv_id = None
        try:
            # 1. Ingest 3 turns; every Utterance must carry its source_identifier.
            res = await persist_turns(db=session, payload=_payload(group_id, [_turn(0), _turn(1), _turn(2)]))
            conv_id = uuid.UUID(res["conversation_id"])
            assert res["utterance_count"] == 3

            utts = (
                await session.execute(select(Utterance).where(Utterance.conversation_id == conv_id))
            ).scalars().all()
            assert len(utts) == 3
            assert {u.source_identifier for u in utts} == {"itest:0", "itest:1", "itest:2"}

            conv = (
                await session.execute(select(Conversation).where(Conversation.id == conv_id))
            ).scalar_one()
            assert conv.indrasnet_group_id == group_id
            assert conv.source_metadata["privacy"]["redaction_applied"] is True

            # 2. Re-ingest the same group_id with 2 turns → same id, fully replaced.
            res2 = await persist_turns(db=session, payload=_payload(group_id, [_turn(0), _turn(1)]))
            assert res2["conversation_id"] == str(conv_id)
            utts2 = (
                await session.execute(select(Utterance).where(Utterance.conversation_id == conv_id))
            ).scalars().all()
            assert len(utts2) == 2
            assert {u.source_identifier for u in utts2} == {"itest:0", "itest:1"}
        finally:
            if conv_id is not None:
                await session.execute(delete(Conversation).where(Conversation.id == conv_id))  # cascades
                await session.commit()
            await session.close()
            await engine.dispose()

    asyncio.run(scenario())
