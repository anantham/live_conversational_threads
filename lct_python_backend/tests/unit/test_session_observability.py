from lct_python_backend.services.session_observability import (
    clear_session_observability_store,
    finish_session,
    get_conversation_observability,
    record_event,
    start_session,
)


def setup_function():
    clear_session_observability_store()


def teardown_function():
    clear_session_observability_store()


def test_session_observability_summarizes_latency_and_errors():
    start_session(
        conversation_id="conv-1",
        session_id="session-1",
        metadata={"provider": "openai_audio"},
    )
    record_event(
        conversation_id="conv-1",
        session_id="session-1",
        event_type="session_ack",
        stage="stt_setup",
        level="info",
        message="Session initialized",
        context={"stt_ready": True},
        metrics={"setup_ms": 120},
    )
    record_event(
        conversation_id="conv-1",
        session_id="session-1",
        event_type="processing_status",
        stage="graph",
        level="warning",
        message="Graph generation is slow",
        context={"queue_wait_ms": 900, "generation_ms": 1400},
    )
    record_event(
        conversation_id="conv-1",
        session_id="session-1",
        event_type="stt_provider_error",
        stage="stt_realtime",
        level="error",
        message="Provider timeout",
        context={"stt_request_ms": 1800},
    )
    finish_session(
        conversation_id="conv-1",
        session_id="session-1",
        status="completed",
    )

    payload = get_conversation_observability("conv-1")

    assert payload["conversation_id"] == "conv-1"
    assert payload["latest_session_id"] == "session-1"
    assert payload["session_count"] == 1

    session = payload["sessions"][0]
    assert session["metadata"]["provider"] == "openai_audio"
    assert session["event_count"] == 3
    assert session["warning_count"] == 1
    assert session["error_count"] == 1
    assert session["stage_counts"]["graph"] == 1
    assert session["latency_summary"]["dominant_stage"] == "stt_realtime"
    assert session["latency_summary"]["dominant_metric"] == "stt_request_ms"
    assert session["latency_summary"]["dominant_ms"] == 1800.0
