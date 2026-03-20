"""Tests for ADR-018 edit history response models and annotation parsing."""

import pytest
from datetime import datetime
from unittest.mock import MagicMock
import uuid

from lct_python_backend.schemas_edit_history import (
    EditResponse,
    EditStatisticsResponse,
    FeedbackEntry,
)


def _make_mock_edit(**overrides):
    """Create a mock EditsLog ORM row."""
    defaults = {
        "id": uuid.uuid4(),
        "target_type": "node",
        "target_id": uuid.uuid4(),
        "field_name": "summary",
        "old_value": "old",
        "new_value": "new",
        "edit_type": "correction",
        "user_id": "default",
        "actor_type": "human",
        "user_comment": None,
        "annotations": None,
        "user_confidence": 1.0,
        "exported_for_training": False,
        "training_dataset_id": None,
        "created_at": datetime(2026, 3, 19, 12, 0, 0),
    }
    defaults.update(overrides)
    mock = MagicMock()
    for key, value in defaults.items():
        setattr(mock, key, value)
    return mock


class TestEditResponseFromOrm:
    def test_basic_fields(self):
        edit = _make_mock_edit()
        resp = EditResponse.from_orm_row(edit)
        assert resp.target_type == "node"
        assert resp.edit_type == "correction"
        assert resp.actor_type == "human"
        assert resp.exported is False
        assert resp.feedback == []

    def test_exported_alias(self):
        edit = _make_mock_edit(exported_for_training=True)
        resp = EditResponse.from_orm_row(edit)
        assert resp.exported is True

    def test_timestamp_alias(self):
        edit = _make_mock_edit(created_at=datetime(2026, 3, 19, 14, 30, 0))
        resp = EditResponse.from_orm_row(edit)
        assert "2026-03-19" in resp.timestamp

    def test_feedback_parsed_from_annotations(self):
        annotations = (
            "[2026-03-19T14:30:00Z] First annotation\n"
            "[2026-03-19T15:45:00Z] Second annotation"
        )
        edit = _make_mock_edit(annotations=annotations)
        resp = EditResponse.from_orm_row(edit)
        assert len(resp.feedback) == 2
        assert resp.feedback[0].text == "First annotation"
        assert resp.feedback[0].timestamp == "2026-03-19T14:30:00Z"
        assert resp.feedback[1].text == "Second annotation"

    def test_feedback_empty_when_no_annotations(self):
        edit = _make_mock_edit(annotations=None)
        resp = EditResponse.from_orm_row(edit)
        assert resp.feedback == []

    def test_feedback_malformed_annotations_skipped(self):
        edit = _make_mock_edit(annotations="not a valid annotation format")
        resp = EditResponse.from_orm_row(edit)
        assert resp.feedback == []

    def test_actor_type_defaults_to_human(self):
        edit = _make_mock_edit(actor_type=None)
        resp = EditResponse.from_orm_row(edit)
        assert resp.actor_type == "human"

    def test_user_comment_preserved(self):
        edit = _make_mock_edit(user_comment="Fixed typo in summary")
        resp = EditResponse.from_orm_row(edit)
        assert resp.user_comment == "Fixed typo in summary"


class TestEditStatisticsFromRawStats:
    def test_basic(self):
        stats = {
            "total_edits": 10,
            "edits_by_target_type": {"node": 8, "relationship": 2},
            "edits_by_edit_type": {"correction": 10},
            "exported_count": 3,
            "unexported_count": 7,
            "export_percentage": 30.0,
            "feedback_count": 2,
        }
        resp = EditStatisticsResponse.from_raw_stats(stats)
        assert resp.total_edits == 10
        assert resp.by_target_type == {"node": 8, "relationship": 2}
        assert resp.feedback_count == 2

    def test_empty_stats(self):
        resp = EditStatisticsResponse.from_raw_stats({})
        assert resp.total_edits == 0
        assert resp.feedback_count == 0

    def test_field_aliases(self):
        """by_target_type aliases edits_by_target_type from backend."""
        stats = {"edits_by_target_type": {"node": 5}}
        resp = EditStatisticsResponse.from_raw_stats(stats)
        assert resp.by_target_type == {"node": 5}
