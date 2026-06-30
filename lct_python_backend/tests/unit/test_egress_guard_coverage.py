"""Egress-guard COVERAGE tests — prove LCT_LOCAL_ONLY blocks each cloud path.

The egress guard is only trustworthy if EVERY surviving cloud egress funnel
calls ``assert_local_egress`` before it spends. These tests pin the funnels
that were unguarded until the ADR-034 merge mitigations:

  - EmbeddingService.embed_batch       -> direct OpenAI batch embeddings
  - OpenAIRealtimeTranscriptionRuntime.start -> wss://api.openai.com realtime
  - transcript_llm_callers.generate_lct_json_gemini  -> Gemini graph gen
  - transcript_llm_callers.genai_accumulate_text_json -> Gemini accumulation

Each test asserts the call raises ``CloudEgressBlocked`` under the default
(local-only ON) so the guard fires BEFORE any network/SDK client is built.
They are deliberately network-free: the guard raises first, so no real
OpenAI/Gemini client is ever constructed.
"""

import pytest

from lct_python_backend.services.egress_guard import CloudEgressBlocked


@pytest.fixture(autouse=True)
def _local_only_on(monkeypatch):
    # Default is ON, but pin it explicitly so the test is independent of env.
    monkeypatch.setenv("LCT_LOCAL_ONLY", "1")
    monkeypatch.delenv("LCT_LOCAL_ONLY_ALLOW_HOSTS", raising=False)
    # Provide fake keys so each path reaches its egress guard (not the
    # earlier "no key configured" early-return).
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")
    monkeypatch.setenv("GEMINI_API_KEY", "gm-test-not-real")
    monkeypatch.setenv("GOOGLE_API_KEY", "gm-test-not-real")


@pytest.mark.asyncio
async def test_embed_batch_blocked_under_local_only():
    """Direct OpenAI batch embeddings must be refused in local-only mode."""
    from lct_python_backend.services.embedding_service import EmbeddingService

    svc = EmbeddingService()
    # Force the cloud branch: a non-"local" config so embed_batch falls through
    # to the direct-OpenAI path where the guard now lives.
    with pytest.raises(CloudEgressBlocked):
        await svc.embed_batch(["hello", "world"], config={"mode": "online"})


@pytest.mark.asyncio
async def test_openai_realtime_start_blocked_under_local_only():
    """OpenAI realtime STT websocket (wss://api.openai.com) must be refused."""
    from lct_python_backend.services.stt.stt_openai_realtime import (
        OpenAIRealtimeTranscriptionRuntime,
    )

    runtime = OpenAIRealtimeTranscriptionRuntime(
        provider="openai_audio",
        api_key="sk-test-not-real",
        model="gpt-4o-realtime-preview",
        # default base_url resolves to wss://api.openai.com/... (non-local)
    )
    with pytest.raises(CloudEgressBlocked):
        await runtime.start()


def test_gemini_graph_generation_blocked_under_local_only():
    """Gemini graph generation (generativelanguage.googleapis.com) refused."""
    from lct_python_backend.services.transcript import transcript_llm_callers as tlc

    with pytest.raises(CloudEgressBlocked):
        tlc.generate_lct_json_gemini(
            transcript="some transcript text",
            model_name="gemini-2.5-flash",
            api_key="gm-test-not-real",
        )


def test_gemini_accumulation_blocked_under_local_only():
    """Gemini transcript accumulation refused in local-only mode."""
    from lct_python_backend.services.transcript import transcript_llm_callers as tlc

    with pytest.raises(CloudEgressBlocked):
        tlc.genai_accumulate_text_json(
            input_text="some segment text",
            model_name="gemini-2.5-flash",
            api_key="gm-test-not-real",
        )


def test_stt_health_probe_blocked_under_local_only():
    """probe_health_url imports urlopen by value (defeating the global urllib
    patch), so it carries its own per-site guard. A cloud health URL must be
    refused; the function returns a result dict with the block as its error,
    NOT a raised exception (it's a probe utility)."""
    from lct_python_backend.services.stt.stt_health_service import probe_health_url

    result = probe_health_url(
        "https://adityaarpitha--whisperx.modal.run/health", timeout_seconds=1.0
    )
    assert result["ok"] is False
    assert "CloudEgressBlocked" in str(result.get("error", "")), result


def test_stt_health_probe_allows_local(monkeypatch):
    """A local health URL passes the guard (then fails on connection, not on
    the egress guard) — no false positive on local providers."""
    from lct_python_backend.services.stt.stt_health_service import probe_health_url

    result = probe_health_url("http://127.0.0.1:59999/health", timeout_seconds=0.3)
    # Guard let it through -> error is a connection error, NOT an egress block.
    assert "CloudEgressBlocked" not in str(result.get("error", "")), result


@pytest.mark.asyncio
async def test_embed_batch_allowed_when_local_only_off(monkeypatch):
    """With local-only OFF, embed_batch passes the guard and proceeds to the
    client path (then fails on the fake key / network) — proving the guard is
    the only thing blocking it, not some other gate."""
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    from lct_python_backend.services.embedding_service import EmbeddingService

    svc = EmbeddingService()
    # Not CloudEgressBlocked: the guard is a no-op now, so it gets past the
    # guard and fails later (auth/network) — any non-CloudEgressBlocked error
    # (or success) is acceptable; we only assert the guard did NOT block.
    try:
        await svc.embed_batch(["hello"], config={"mode": "online"})
    except CloudEgressBlocked:
        pytest.fail("guard should be a no-op when LCT_LOCAL_ONLY=0")
    except Exception:
        pass  # expected: fake key / network error, not an egress block
