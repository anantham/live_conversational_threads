"""Unit tests for import_checkpoint.py — checkpoint save/find/clear cycle."""

import os
import tempfile
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://lct_user:lct_password@localhost:5432/lct_dev")

from lct_python_backend.models import PipelineArtifact
from lct_python_backend.services.import_checkpoint import (
    STAGE_CHUNK,
    STAGE_MANIFEST,
    clear_checkpoint,
    compute_file_hash,
    find_checkpoint,
    save_chunk_checkpoint,
)


CONVERSATION_ID = str(uuid.uuid4())
FILE_HASH = "abc123def456" * 4  # 48 chars, fake but consistent


# ---------------------------------------------------------------------------
# compute_file_hash
# ---------------------------------------------------------------------------

def test_compute_file_hash_deterministic():
    """Same content → same hash, every time."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(b"hello world audio bytes")
        path = f.name

    from pathlib import Path

    h1 = compute_file_hash(Path(path))
    h2 = compute_file_hash(Path(path))
    assert h1 == h2
    assert len(h1) == 64  # SHA-256 hex digest
    os.unlink(path)


def test_compute_file_hash_different_content():
    """Different files → different hashes."""
    from pathlib import Path

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f1:
        f1.write(b"content A")
        path1 = f1.name
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f2:
        f2.write(b"content B")
        path2 = f2.name

    assert compute_file_hash(Path(path1)) != compute_file_hash(Path(path2))
    os.unlink(path1)
    os.unlink(path2)


# ---------------------------------------------------------------------------
# DB mock helpers
# ---------------------------------------------------------------------------

class FakeArtifactStore:
    """In-memory store that simulates PipelineArtifact queries for checkpoint tests.

    Routes queries by extracting bound parameter values from compiled SQLAlchemy
    statements, avoiding brittle string matching on SQL text.
    """

    def __init__(self):
        self.rows: list[PipelineArtifact] = []

    def add(self, obj):
        if isinstance(obj, PipelineArtifact):
            self.rows.append(obj)

    async def commit(self):
        pass

    async def flush(self):
        pass

    def _extract_params(self, stmt) -> dict:
        """Extract bound parameter values from a compiled statement."""
        try:
            compiled = stmt.compile(compile_kwargs={"literal_binds": False})
            return dict(compiled.params) if compiled.params else {}
        except Exception:
            return {}

    def _match_rows(self, params: dict) -> list[PipelineArtifact]:
        """Find rows matching the given parameter filters."""
        matches = list(self.rows)
        for key, value in params.items():
            if "content_hash" in key:
                matches = [r for r in matches if r.content_hash == value]
            elif "stage" in key and "index" not in key:
                if isinstance(value, (list, tuple)):
                    matches = [r for r in matches if r.stage in value]
                else:
                    matches = [r for r in matches if r.stage == value]
            elif "stage_index" in key:
                matches = [r for r in matches if r.stage_index == value]
        return matches

    async def execute(self, stmt):
        """Route SELECT/DELETE statements to the in-memory store."""
        is_delete = hasattr(stmt, "is_delete") and stmt.is_delete
        if not is_delete:
            # Heuristic: check if the statement string starts with DELETE
            try:
                is_delete = str(stmt).strip().upper().startswith("DELETE")
            except Exception:
                pass

        params = self._extract_params(stmt)

        if is_delete:
            matched = self._match_rows(params)
            matched_ids = {id(r) for r in matched}
            self.rows = [r for r in self.rows if id(r) not in matched_ids]
            result = MagicMock()
            result.rowcount = len(matched)
            return result

        # SELECT queries
        matched = self._match_rows(params)
        result = MagicMock()

        # Detect if this is a "list chunks" query (no stage_index param)
        # vs a "find one" query (has stage_index or is manifest lookup)
        has_stage_index = any("stage_index" in k for k in params)
        is_chunk_list = (
            not has_stage_index
            and any(v == STAGE_CHUNK for v in params.values())
        )

        if is_chunk_list:
            sorted_matches = sorted(matched, key=lambda r: r.stage_index)
            scalars_mock = MagicMock()
            scalars_mock.all = MagicMock(return_value=sorted_matches)
            result.scalars = MagicMock(return_value=scalars_mock)
        else:
            row = matched[-1] if matched else None
            result.scalar_one_or_none = MagicMock(return_value=row)

        return result


def _make_store():
    """Create a FakeArtifactStore that acts as an async DB session."""
    return FakeArtifactStore()


# ---------------------------------------------------------------------------
# find_checkpoint — empty DB
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_find_checkpoint_returns_none_when_empty():
    db = _make_store()
    result = await find_checkpoint(db, FILE_HASH)
    assert result is None


# ---------------------------------------------------------------------------
# save_chunk_checkpoint + find_checkpoint round-trip
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_save_and_find_single_chunk():
    db = _make_store()

    await save_chunk_checkpoint(
        db,
        conversation_id=CONVERSATION_ID,
        file_hash=FILE_HASH,
        chunk_index=1,
        total_chunks=10,
        chunk_text="Hello from chunk 1",
        accumulated_transcript="Hello from chunk 1",
        stt_backend="cloud_whisper",
        elapsed_ms=1500.0,
        file_name="test.wav",
        file_size_bytes=1024,
    )

    # Should have created 2 rows: one chunk + one manifest
    assert len(db.rows) == 2
    stages = {r.stage for r in db.rows}
    assert stages == {STAGE_CHUNK, STAGE_MANIFEST}

    # Find should return checkpoint
    checkpoint = await find_checkpoint(db, FILE_HASH)
    assert checkpoint is not None
    assert checkpoint["conversation_id"] == CONVERSATION_ID
    assert checkpoint["completed_chunks"] == 1
    assert checkpoint["total_chunks"] == 10
    assert checkpoint["stt_backend"] == "cloud_whisper"
    assert len(checkpoint["completed_chunk_texts"]) == 1
    assert checkpoint["completed_chunk_texts"][0]["text"] == "Hello from chunk 1"


@pytest.mark.asyncio
async def test_save_multiple_chunks_accumulates():
    db = _make_store()

    for i in range(1, 4):
        await save_chunk_checkpoint(
            db,
            conversation_id=CONVERSATION_ID,
            file_hash=FILE_HASH,
            chunk_index=i,
            total_chunks=10,
            chunk_text=f"Chunk {i} text",
            accumulated_transcript="\n".join(f"Chunk {j} text" for j in range(1, i + 1)),
            stt_backend="cloud_whisper",
        )

    # 3 chunk rows + 1 manifest (manifest is created once, then updated)
    chunk_rows = [r for r in db.rows if r.stage == STAGE_CHUNK]
    manifest_rows = [r for r in db.rows if r.stage == STAGE_MANIFEST]
    assert len(chunk_rows) == 3
    # Manifest may have multiple rows due to insert-not-update in mock — that's fine
    assert len(manifest_rows) >= 1

    checkpoint = await find_checkpoint(db, FILE_HASH)
    assert checkpoint is not None
    assert checkpoint["completed_chunks"] == 3
    assert len(checkpoint["completed_chunk_texts"]) == 3


# ---------------------------------------------------------------------------
# clear_checkpoint
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_clear_checkpoint_removes_all_rows():
    db = _make_store()

    # Save 2 chunks
    for i in range(1, 3):
        await save_chunk_checkpoint(
            db,
            conversation_id=CONVERSATION_ID,
            file_hash=FILE_HASH,
            chunk_index=i,
            total_chunks=5,
            chunk_text=f"Chunk {i}",
            accumulated_transcript=f"Chunk {i}",
        )

    assert len(db.rows) > 0

    deleted = await clear_checkpoint(db, FILE_HASH)
    assert deleted > 0
    assert len(db.rows) == 0


@pytest.mark.asyncio
async def test_clear_checkpoint_on_empty_db():
    db = _make_store()
    deleted = await clear_checkpoint(db, FILE_HASH)
    assert deleted == 0


# ---------------------------------------------------------------------------
# find_checkpoint returns correct transcript text from manifest
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_find_checkpoint_transcript_text():
    db = _make_store()

    accumulated = "Line one\nLine two\nLine three"
    await save_chunk_checkpoint(
        db,
        conversation_id=CONVERSATION_ID,
        file_hash=FILE_HASH,
        chunk_index=3,
        total_chunks=10,
        chunk_text="Line three",
        accumulated_transcript=accumulated,
    )

    checkpoint = await find_checkpoint(db, FILE_HASH)
    assert checkpoint["transcript_text"] == accumulated


# ---------------------------------------------------------------------------
# find_checkpoint with wrong hash returns None
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_find_checkpoint_wrong_hash():
    db = _make_store()

    await save_chunk_checkpoint(
        db,
        conversation_id=CONVERSATION_ID,
        file_hash=FILE_HASH,
        chunk_index=1,
        total_chunks=5,
        chunk_text="text",
        accumulated_transcript="text",
    )

    # Different hash → no match
    result = await find_checkpoint(db, "completely_different_hash_value_here")
    assert result is None
