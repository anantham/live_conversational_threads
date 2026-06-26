"""Unit tests for transcript revision service and reconciliation stub."""
from __future__ import annotations

import sys
import types
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Stubs for reconciliation module
# ---------------------------------------------------------------------------

def _make_db_session():
    db = MagicMock()
    db.execute = AsyncMock()
    db.flush = AsyncMock()
    db.commit = AsyncMock()
    return db


def _make_execute_result(rows=None):
    result = MagicMock()
    result.fetchall.return_value = rows or []
    result.fetchone.return_value = (rows or [None])[0] if rows else None
    return result


# ---------------------------------------------------------------------------
# transcript_revision_service tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_propose_revision_returns_uuid_string():
    from lct_python_backend.services.transcript_revision_service import propose_revision
    db = _make_db_session()
    db.execute.return_value = _make_execute_result()

    revision_id = await propose_revision(
        db,
        conversation_id="conv-1",
        proposed_segments=[{"speaker": "A", "start": 0.0, "end": 1.0, "text": "Hello"}],
        source="slow_pass",
    )

    assert isinstance(revision_id, str)
    assert len(revision_id) == 36  # UUID4 string
    # execute called twice: supersede + insert
    assert db.execute.call_count == 2
    assert db.flush.called


@pytest.mark.asyncio
async def test_reject_revision_returns_true_when_found():
    from lct_python_backend.services.transcript_revision_service import reject_revision
    db = _make_db_session()
    db.execute.return_value = _make_execute_result(rows=[MagicMock()])

    found = await reject_revision(db, revision_id="rev-1", conversation_id="conv-1")

    assert found is True
    assert db.flush.called


@pytest.mark.asyncio
async def test_reject_revision_returns_false_when_not_found():
    from lct_python_backend.services.transcript_revision_service import reject_revision
    db = _make_db_session()
    db.execute.return_value = _make_execute_result(rows=[])

    found = await reject_revision(db, revision_id="missing", conversation_id="conv-1")

    assert found is False


@pytest.mark.asyncio
async def test_mark_revision_approved_returns_segments():
    from lct_python_backend.services.transcript_revision_service import mark_revision_approved
    db = _make_db_session()

    fake_segments = [{"speaker": "B", "start": 0.0, "end": 2.0, "text": "World"}]

    # First execute (get_revision_segments): returns segments row
    seg_row = MagicMock()
    seg_row.proposed_segments = fake_segments
    # Second execute (UPDATE to 'approved'): returns a row (found)
    approved_row = MagicMock()

    db.execute.side_effect = [
        _make_execute_result(rows=[seg_row]),
        _make_execute_result(rows=[approved_row]),
    ]

    result = await mark_revision_approved(db, revision_id="rev-1", conversation_id="conv-1")

    assert result == fake_segments
    assert db.flush.called


@pytest.mark.asyncio
async def test_mark_revision_approved_returns_none_when_not_found():
    from lct_python_backend.services.transcript_revision_service import mark_revision_approved
    db = _make_db_session()
    db.execute.return_value = _make_execute_result(rows=[])

    result = await mark_revision_approved(db, revision_id="missing", conversation_id="conv-1")

    assert result is None


# ---------------------------------------------------------------------------
# transcript_reconciliation tests (the decision-B stub)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_reconciliation_proposes_revision_when_db_provided():
    from lct_python_backend.services.transcript_reconciliation import reconcile_and_patch_utterances

    segments = [{"speaker": "A", "start": 0.0, "end": 1.5, "text": "Testing."}]
    db = _make_db_session()

    with patch(
        "lct_python_backend.services.transcript_reconciliation.propose_revision",
        new=AsyncMock(return_value="new-rev-uuid"),
    ) as mock_propose:
        await reconcile_and_patch_utterances(
            "conv-xyz", utterances=[], asr_segments=segments, db=db
        )

    mock_propose.assert_called_once()
    call_kwargs = mock_propose.call_args.kwargs
    assert call_kwargs["conversation_id"] == "conv-xyz"
    assert call_kwargs["proposed_segments"] == segments
    assert call_kwargs["source"] == "slow_pass"
    assert db.commit.called


@pytest.mark.asyncio
async def test_reconciliation_is_noop_when_no_db():
    """Legacy callers that don't pass db= get a warning, not a crash."""
    from lct_python_backend.services.transcript_reconciliation import reconcile_and_patch_utterances

    segments = [{"speaker": "A", "start": 0.0, "end": 1.0, "text": "Hi."}]
    # Should not raise
    await reconcile_and_patch_utterances("conv-1", utterances=[], asr_segments=segments, db=None)


@pytest.mark.asyncio
async def test_reconciliation_is_noop_when_no_segments():
    from lct_python_backend.services.transcript_reconciliation import reconcile_and_patch_utterances

    db = _make_db_session()
    await reconcile_and_patch_utterances("conv-1", utterances=[], asr_segments=[], db=db)

    # propose_revision should NOT have been called
    db.execute.assert_not_called()


@pytest.mark.asyncio
async def test_reconciliation_does_not_raise_on_propose_failure():
    from lct_python_backend.services.transcript_reconciliation import reconcile_and_patch_utterances

    segments = [{"speaker": "A", "start": 0.0, "end": 1.0, "text": "Hi."}]
    db = _make_db_session()

    with patch(
        "lct_python_backend.services.transcript_reconciliation.propose_revision",
        new=AsyncMock(side_effect=RuntimeError("DB down")),
    ):
        # Should warn but not raise — never blocks the caller
        await reconcile_and_patch_utterances("conv-1", utterances=[], asr_segments=segments, db=db)
