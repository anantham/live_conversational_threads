from dataclasses import dataclass
import uuid
from typing import Optional

from lct_python_backend.services.speaker_materialization import (
    assign_speakers_to_utterances,
    build_speaker_segment_rows,
)


@dataclass
class _FakeUtterance:
    id: str
    timestamp_start: Optional[float]
    timestamp_end: Optional[float]


def test_build_speaker_segment_rows_converts_relative_to_global_timestamps():
    rows = build_speaker_segment_rows(
        [
            {"speaker": "SPEAKER_00", "text": "hello", "start": 0.2, "end": 0.8},
            {"speaker": "SPEAKER_01", "text": "hi", "start": 0.8, "end": 1.1},
        ],
        window_timestamps={"start": 12.0, "end": 13.5},
        source_text="hello hi",
        provider="openai_audio",
        model="gpt-4o-transcribe-diarize",
        transport="openai_audio",
        source_utterance_id=str(uuid.uuid4()),
    )

    assert len(rows) == 2
    assert rows[0]["timestamp_start"] == 12.2
    assert rows[0]["timestamp_end"] == 12.8
    assert rows[1]["timestamp_start"] == 12.8
    assert rows[1]["timestamp_end"] == 13.1


def test_assign_speakers_to_utterances_uses_dominant_overlap():
    utterances = [
        _FakeUtterance(id=str(uuid.uuid4()), timestamp_start=0.0, timestamp_end=1.0),
        _FakeUtterance(id=str(uuid.uuid4()), timestamp_start=1.0, timestamp_end=2.0),
    ]
    rows = [
        {
            "speaker_id": "SPEAKER_00",
            "timestamp_start": 0.0,
            "timestamp_end": 1.0,
        },
        {
            "speaker_id": "SPEAKER_01",
            "timestamp_start": 1.0,
            "timestamp_end": 2.0,
        },
    ]

    result = assign_speakers_to_utterances(utterances, rows)

    assert [assignment["speaker_id"] for assignment in result["assignments"]] == [
        "SPEAKER_00",
        "SPEAKER_01",
    ]
    assert result["ambiguous_utterance_ids"] == []


def test_assign_speakers_to_utterances_leaves_ambiguous_overlap_unresolved():
    utterance = _FakeUtterance(id=str(uuid.uuid4()), timestamp_start=0.0, timestamp_end=1.0)
    rows = [
        {
            "speaker_id": "SPEAKER_00",
            "timestamp_start": 0.0,
            "timestamp_end": 0.5,
        },
        {
            "speaker_id": "SPEAKER_01",
            "timestamp_start": 0.5,
            "timestamp_end": 1.0,
        },
    ]

    result = assign_speakers_to_utterances([utterance], rows)

    assert result["assignments"] == []
    assert result["ambiguous_utterance_ids"] == [utterance.id]
