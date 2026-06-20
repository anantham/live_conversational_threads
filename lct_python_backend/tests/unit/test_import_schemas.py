"""Smoke tests for import API pydantic schemas."""

from lct_python_backend.import_schemas import ImportStatusResponse, ValidationResponse


def test_import_status_response_accepts_optional_conversation_id():
    payload = ImportStatusResponse(
        success=True,
        conversation_id=None,
        message="ok",
        utterance_count=0,
        participant_count=0,
    )
    assert payload.success is True


def test_validation_response_round_trip():
    payload = ValidationResponse(
        is_valid=False,
        errors=["bad format"],
        warnings=[],
        stats={"lines": 1},
    )
    dumped = payload.model_dump()
    assert dumped["errors"] == ["bad format"]