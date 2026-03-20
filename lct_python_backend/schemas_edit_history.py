"""Pydantic response models for edit history endpoints (ADR-018)."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, validator


# Pattern for parsing annotations: [2026-03-19T14:30:00Z] text here
_ANNOTATION_RE = re.compile(
    r"\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\]\s*(.*)"
)


class FeedbackEntry(BaseModel):
    text: str
    timestamp: str


class EditResponse(BaseModel):
    id: str
    target_type: str
    target_id: str
    field_name: str
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    edit_type: str
    user_id: str
    actor_type: str = "human"
    user_comment: Optional[str] = None
    annotations: Optional[str] = None
    user_confidence: float = 1.0
    exported: bool = Field(False, description="Alias for exported_for_training")
    training_dataset_id: Optional[str] = None
    timestamp: str = Field(..., description="Alias for created_at (ISO 8601)")
    feedback: List[FeedbackEntry] = Field(
        default_factory=list,
        description="Parsed from annotations column",
    )

    @classmethod
    def from_orm_row(cls, edit) -> "EditResponse":
        """Build from an EditsLog ORM instance."""
        feedback = []
        if edit.annotations:
            for line in edit.annotations.strip().split("\n"):
                m = _ANNOTATION_RE.match(line.strip())
                if m:
                    feedback.append(FeedbackEntry(
                        timestamp=m.group(1),
                        text=m.group(2),
                    ))

        return cls(
            id=str(edit.id),
            target_type=edit.target_type,
            target_id=str(edit.target_id),
            field_name=edit.field_name,
            old_value=edit.old_value,
            new_value=edit.new_value,
            edit_type=edit.edit_type,
            user_id=edit.user_id,
            actor_type=getattr(edit, "actor_type", "human") or "human",
            user_comment=edit.user_comment,
            annotations=edit.annotations,
            user_confidence=edit.user_confidence or 1.0,
            exported=bool(edit.exported_for_training),
            training_dataset_id=edit.training_dataset_id,
            timestamp=edit.created_at.isoformat() if edit.created_at else "",
            feedback=feedback,
        )


class EditListResponse(BaseModel):
    conversation_id: str
    edits: List[EditResponse]
    count: int


class EditStatisticsResponse(BaseModel):
    total_edits: int = 0
    by_target_type: Dict[str, int] = Field(default_factory=dict)
    by_edit_type: Dict[str, int] = Field(default_factory=dict)
    exported_count: int = 0
    unexported_count: int = 0
    export_percentage: float = 0.0
    feedback_count: int = 0

    @classmethod
    def from_raw_stats(cls, stats: Dict[str, Any]) -> "EditStatisticsResponse":
        return cls(
            total_edits=stats.get("total_edits", 0),
            by_target_type=stats.get("edits_by_target_type", {}),
            by_edit_type=stats.get("edits_by_edit_type", {}),
            exported_count=stats.get("exported_count", 0),
            unexported_count=stats.get("unexported_count", 0),
            export_percentage=stats.get("export_percentage", 0.0),
            feedback_count=stats.get("feedback_count", 0),
        )
