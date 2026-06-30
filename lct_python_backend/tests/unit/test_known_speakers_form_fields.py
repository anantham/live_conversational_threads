"""Tests for build_known_speakers_form_fields — the OpenAI form-data
construction that supports name-only entries (no voice clip)."""

import os
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test_db")

from lct_python_backend.services.stt.stt_provider_transports import (
    build_known_speakers_form_fields,
)


def test_empty_input_returns_empty_dict():
    assert build_known_speakers_form_fields(None) == {}
    assert build_known_speakers_form_fields([]) == {}


def test_entries_with_only_names_send_names_no_refs():
    """Name-only entries (no voice clip) — participants picked from picker
    but lacking a stored audio reference, or contacts with external_llm_ok
    blocking their clip."""
    entries = [
        {"name": "Aditya", "audio_base64": None},
        {"name": "Sahil"},  # missing key
    ]
    fields = build_known_speakers_form_fields(entries)
    assert fields == {"known_speaker_names[]": ["Aditya", "Sahil"]}
    assert "known_speaker_references[]" not in fields


def test_entries_with_names_and_refs_emit_both_arrays():
    entries = [
        {"name": "Aditya", "audio_base64": "AAA="},
        {"name": "Sahil", "audio_base64": "BBB="},
    ]
    fields = build_known_speakers_form_fields(entries)
    assert fields["known_speaker_names[]"] == ["Aditya", "Sahil"]
    assert fields["known_speaker_references[]"] == [
        "data:audio/wav;base64,AAA=",
        "data:audio/wav;base64,BBB=",
    ]


def test_mixed_entries_name_only_and_with_clip():
    """Picker selected 3 contacts; only Aditya has a voice clip on file.
    OpenAI sees all 3 names but only 1 reference."""
    entries = [
        {"name": "Aditya", "audio_base64": "AAA="},
        {"name": "Sahil", "audio_base64": None},
        {"name": "Vinay"},
    ]
    fields = build_known_speakers_form_fields(entries)
    assert fields["known_speaker_names[]"] == ["Aditya", "Sahil", "Vinay"]
    assert fields["known_speaker_references[]"] == [
        "data:audio/wav;base64,AAA=",
    ]


def test_data_uri_prefix_passed_through_unchanged():
    entries = [
        {"name": "Aditya", "audio_base64": "data:audio/wav;base64,RAWCLIP"},
    ]
    fields = build_known_speakers_form_fields(entries)
    assert fields["known_speaker_references[]"] == [
        "data:audio/wav;base64,RAWCLIP",
    ]


def test_empty_or_blank_names_are_dropped():
    entries = [
        {"name": "", "audio_base64": "AAA="},
        {"name": "   ", "audio_base64": "BBB="},
        {"name": "Sahil", "audio_base64": "CCC="},
    ]
    fields = build_known_speakers_form_fields(entries)
    assert fields["known_speaker_names[]"] == ["Sahil"]


def test_non_dict_entries_skipped():
    entries = ["string-not-a-dict", None, {"name": "Aditya"}]
    fields = build_known_speakers_form_fields(entries)
    assert fields["known_speaker_names[]"] == ["Aditya"]


def test_returns_empty_when_no_usable_names():
    entries = [{"audio_base64": "AAA="}, {"name": ""}]
    assert build_known_speakers_form_fields(entries) == {}
