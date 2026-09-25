"""Behavioral intent: tests/intent/transcript-review.md. Synthetic SQLite only."""

import asyncio
from datetime import datetime
from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import (
    Column,
    DateTime,
    Integer,
    JSON,
    MetaData,
    Table,
    Text,
    Float,
    Uuid,
    create_engine,
    select,
    text,
)
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from lct_python_backend import auth_policy, transcript_review_api
from lct_python_backend.models import EditsLog
from lct_python_backend.services.transcript_review import (
    correct_utterance,
    read_transcript,
)

CID, UID = UUID(int=50), UUID(int=51)


@pytest.fixture
def database():
    engine = create_engine(
        "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )
    metadata = MetaData()
    conversations = Table(
        "conversations",
        metadata,
        Column("id", Uuid, primary_key=True),
        Column("owner_id", Text),
        Column("source_metadata", JSON),
        Column("deleted_at", DateTime),
        Column("updated_at", DateTime),
    )
    utterances = Table(
        "utterances",
        metadata,
        Column("id", Uuid, primary_key=True),
        Column("conversation_id", Uuid),
        Column("sequence_number", Integer),
        Column("text", Text),
        Column("text_cleaned", Text),
        Column("speaker_id", Text),
        Column("speaker_name", Text),
        Column("timestamp_start", Float),
        Column("timestamp_end", Float),
        Column("word_timings", JSON),
    )
    events = Table(
        "transcript_events",
        metadata,
        Column("id", Uuid, primary_key=True),
        Column("text", Text),
    )
    edit_table = EditsLog.__table__.to_metadata(metadata)
    for column in edit_table.columns:
        if column.name in {"id", "conversation_id", "target_id"}:
            column.type = Uuid()
    metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(
            conversations.insert().values(
                id=CID,
                owner_id="synthetic-owner",
                source_metadata={"audio_identity": "original-recording"},
            )
        )
        conn.execute(
            utterances.insert().values(
                id=UID,
                conversation_id=CID,
                sequence_number=1,
                text="Original words",
                text_cleaned="Original words",
                speaker_id="speaker",
                speaker_name="Synthetic",
                timestamp_start=2,
                timestamp_end=5,
                word_timings=[
                    {"word": "Original", "start": 2, "end": 3},
                    {"word": "words", "start": 3, "end": 5},
                ],
            )
        )
        conn.execute(events.insert().values(id=UUID(int=52), text="Original words"))
    session = Session(engine)

    class AsyncFacade:
        async def execute(self, query):
            return session.execute(query)

        async def commit(self):
            session.commit()

        async def rollback(self):
            session.rollback()

        async def refresh(self, row):
            session.refresh(row)

        def add(self, row):
            session.add(row)

    yield AsyncFacade(), session, conversations, utterances, events
    session.close()
    engine.dispose()


def correct(db, expected="Original words", value="Corrected words", **kwargs):
    return asyncio.run(
        correct_utterance(
            db,
            conversation_id=CID,
            utterance_id=UID,
            expected_text=expected,
            text=value,
            owner_id=kwargs.get("owner_id", "synthetic-owner"),
        )
    )


def test_correction_atomic_audit_alignment_clear_and_original_preserved(database):
    db, session, conversations, utterances, events = database
    result = correct(db)
    row = session.execute(select(utterances)).mappings().one()
    assert row["text"] == "Corrected words" and row["word_timings"] is None
    assert (row["timestamp_start"], row["timestamp_end"]) == (2, 5)
    assert session.execute(select(events.c.text)).scalar_one() == "Original words"
    entry = session.execute(select(EditsLog)).scalar_one()
    assert (entry.target_type, entry.old_value, entry.new_value) == (
        "utterance",
        "Original words",
        "Corrected words",
    )
    assert str(entry.id) == result["edit_id"]
    metadata = session.execute(select(conversations.c.source_metadata)).scalar_one()
    assert metadata == {
        "audio_identity": "original-recording",
        "transcript_corrections_pending_graph_refresh": True,
    }
    reread = asyncio.run(
        read_transcript(db, conversation_id=CID, owner_id="synthetic-owner")
    )
    assert (
        reread["utterances"][0]["text"] == "Corrected words"
        and reread["graph_refresh_required"]
    )
    correct(db, expected="Corrected words", value="Original words")
    assert len(session.execute(select(EditsLog)).scalars().all()) == 2
    assert session.execute(select(utterances.c.word_timings)).scalar_one() is None


def test_stale_text_never_overwrites_or_logs(database):
    db, session, _, utterances, _ = database
    correct(db)
    with pytest.raises(HTTPException) as exc:
        correct(db, value="Stale replacement")
    assert exc.value.status_code == 409
    assert session.execute(select(utterances.c.text)).scalar_one() == "Corrected words"
    assert len(session.execute(select(EditsLog)).scalars().all()) == 1


def test_audit_failure_rolls_back_edit_and_metadata(database):
    db, session, conversations, utterances, _ = database
    session.execute(
        text(
            "CREATE TRIGGER reject_edit BEFORE INSERT ON edits_log BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END"
        )
    )
    session.commit()
    with pytest.raises(Exception, match="synthetic audit failure"):
        correct(db)
    assert session.execute(select(utterances.c.text)).scalar_one() == "Original words"
    assert session.execute(select(conversations.c.source_metadata)).scalar_one() == {
        "audio_identity": "original-recording"
    }


@pytest.mark.parametrize("deleted", [False, True])
def test_owner_or_deleted_denied_without_mutation(database, deleted):
    db, session, conversations, utterances, _ = database
    if deleted:
        session.execute(conversations.update().values(deleted_at=datetime(2026, 9, 25)))
        session.commit()
    owner = "synthetic-owner" if deleted else "other-owner"
    with pytest.raises(HTTPException) as exc:
        correct(db, owner_id=owner)
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException):
        asyncio.run(read_transcript(db, conversation_id=CID, owner_id=owner))
    assert session.execute(select(utterances.c.text)).scalar_one() == "Original words"


@pytest.mark.parametrize(
    "metadata",
    [
        {"provider": "attendee"},
        {"meeting_url": "synthetic-room", "bot_name": "synthetic-bot"},
    ],
)
def test_captions_do_not_claim_recording_alignment(database, metadata):
    db, session, conversations, _, _ = database
    session.execute(conversations.update().values(source_metadata=metadata))
    session.commit()
    assert (
        asyncio.run(
            read_transcript(db, conversation_id=CID, owner_id="synthetic-owner")
        )["timing_basis"]
        == "caption_relative"
    )


def test_private_routes_reject_share_token_and_preserve_existing_owner_scope(
    database, monkeypatch
):
    db, _, _, _, _ = database
    monkeypatch.setattr(auth_policy, "AUTH_TOKEN", "synthetic-private-token")
    monkeypatch.setattr(auth_policy, "ADMIN_AUTH_TOKEN", None)
    monkeypatch.setenv("LCT_OWNER_ID", "synthetic-owner")

    async def dependency():
        yield db

    app = FastAPI()
    app.include_router(transcript_review_api.router)
    app.dependency_overrides[transcript_review_api.get_async_session] = dependency
    root = f"/api/conversations/{CID}"
    with TestClient(app) as client:
        assert (
            client.get(root + "/transcript-review?share_token=synthetic").status_code
            == 401
        )
        assert (
            client.patch(
                root + f"/utterances/{UID}/text",
                json={"expected_text": "Original words", "text": "Bad"},
            ).status_code
            == 401
        )
        headers = {"Authorization": "Bearer synthetic-private-token"}
        read = client.get(root + "/transcript-review", headers=headers)
        assert read.status_code == 200 and read.json()["utterances"][0]["word_timings"]
        patched = client.patch(
            root + f"/utterances/{UID}/text",
            headers=headers,
            json={"expected_text": "Original words", "text": "Saved through API"},
        )
        assert (
            patched.status_code == 200
            and patched.json()["utterance"]["text"] == "Saved through API"
        )
        assert (
            client.patch(
                root + f"/utterances/{UID}/text",
                headers=headers,
                json={"expected_text": "Original words", "text": "Stale"},
            ).status_code
            == 409
        )
