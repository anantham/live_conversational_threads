"""Chokepoint byte-boundary tests (ADR-038 move 1 + finding 1.8).

Proves the NEW contract the redesign requires: a redaction-required (E3/E4) send
carrying a forbidden real name is blocked on its ACTUAL request body BEFORE the
socket opens — even when ``LCT_LOCAL_ONLY=0`` (the host gate no-ops then). Clean
(redacted) bodies are unaffected, and local/E1 traffic is never byte-scanned.

The boundary is purely ADDITIVE: it does not relax any existing host-locality
behavior (those tests stay green in test_egress_chokepoint.py); it only newly
blocks forbidden-name bodies that previously leaked at LCT_LOCAL_ONLY=0.
"""

import httpx
import pytest

from lct_python_backend.services.egress_chokepoint import (
    install_egress_chokepoint,
    uninstall_egress_chokepoint,
)
from lct_python_backend.services.privacy_boundary import (
    AudioEgressBlocked,
    UnverifiedEgressBlocked,
)

E4_URL = "https://api.openai.com/v1/chat/completions"
DIRTY = b'{"messages":[{"role":"user","content":"notes about Vatsal Mehra"}]}'
CLEAN = b'{"messages":[{"role":"user","content":"notes about [Friend A]"}]}'


@pytest.fixture(autouse=True)
def _chokepoint_on(monkeypatch):
    monkeypatch.delenv("LCT_LOCAL_ONLY_ALLOW_HOSTS", raising=False)
    install_egress_chokepoint()
    try:
        yield
    finally:
        uninstall_egress_chokepoint()


# --- finding 1.8: the new contract at LCT_LOCAL_ONLY=0 -----------------------

def test_dirty_body_blocked_when_local_only_off(monkeypatch):
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    with pytest.raises(UnverifiedEgressBlocked):
        httpx.Client(timeout=0.3).post(E4_URL, content=DIRTY)


def test_clean_body_passes_boundary_when_local_only_off(monkeypatch):
    # Only a block is a failure. Any network outcome — timeout, refusal, or a
    # real HTTP response on runners with internet — means the clean body
    # passed the redaction boundary. pytest.raises(Exception) flaked on CI
    # where the request completed inside the timeout and nothing raised.
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    try:
        httpx.Client(timeout=0.5).post(E4_URL, content=CLEAN)
    except UnverifiedEgressBlocked:  # pragma: no cover - would be a guard bug
        pytest.fail("redaction boundary blocked a clean body")
    except Exception:
        pass  # network failure — fine, the boundary let it through


def test_dirty_body_blocked_even_when_local_only_on(monkeypatch):
    # Under LOCAL_ONLY=1 the host gate would block anyway, but the byte check
    # fires first — and UnverifiedEgressBlocked is a CloudEgressBlocked subclass.
    monkeypatch.setenv("LCT_LOCAL_ONLY", "1")
    with pytest.raises(UnverifiedEgressBlocked):
        httpx.Client(timeout=0.3).post(E4_URL, content=DIRTY)


# --- local traffic is never byte-scanned -------------------------------------

def test_local_e1_body_not_scanned(monkeypatch):
    # A forbidden name in a LOCAL (E1) request body is NOT a leak — owner hardware.
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    with pytest.raises(Exception) as exc_info:
        httpx.Client(timeout=0.2).post("http://127.0.0.1:59999/x", content=DIRTY)
    assert not isinstance(exc_info.value, UnverifiedEgressBlocked)


# --- streamed bodies are materialized + scanned (codex blocker 1) ------------

def test_streamed_body_is_materialized_and_scanned(monkeypatch):
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")

    def _gen():
        yield b'{"messages":[{"content":"about Vatsal"}]}'

    with pytest.raises(UnverifiedEgressBlocked):
        httpx.Client(timeout=0.3).post(E4_URL, content=_gen())


def test_unmaterializable_body_fails_closed():
    from lct_python_backend.services.egress_chokepoint import _materialize_body_sync

    class _OneShot:
        url = httpx.URL(E4_URL)

        @property
        def content(self):
            raise httpx.RequestNotRead()

        def read(self):
            raise RuntimeError("one-shot stream, cannot replay")

    with pytest.raises(UnverifiedEgressBlocked):
        _materialize_body_sync(_OneShot(), E4_URL)


# --- SDK coverage via MRO (google-genai / OpenAI shape) ----------------------

def test_httpx_subclass_covered_by_mro(monkeypatch):
    # google-genai / OpenAI SDKs subclass httpx.Client and override only __init__,
    # so client.send resolves to the patched class method via MRO.
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")

    class FakeSdkClient(httpx.Client):
        pass

    with pytest.raises(UnverifiedEgressBlocked):
        FakeSdkClient(timeout=0.3).post("https://api.anthropic.com/v1/messages", content=DIRTY)


@pytest.mark.asyncio
async def test_async_dirty_body_blocked(monkeypatch):
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    async with httpx.AsyncClient(timeout=0.3) as client:
        with pytest.raises(UnverifiedEgressBlocked):
            await client.post(E4_URL, content=DIRTY)


def test_json_unicode_escaped_name_blocked(monkeypatch):
    # codex Bug 6: a name escaped as \uXXXX in the JSON body must still be blocked.
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    body = ('{"messages":[{"content":"meet V' + chr(92) + 'u0061tsal"}]}').encode("utf-8")
    assert b"\\u0061" in body  # the wire bytes carry the literal escape
    with pytest.raises(UnverifiedEgressBlocked):
        httpx.Client(timeout=0.3).post(E4_URL, content=body)


# --- central audio backstop at the transport (codex round-2) -----------------

def test_central_audio_gate_blocks_cloud_multipart_upload(monkeypatch):
    # A non-local multipart WAV upload (e.g. audio_transcriber) is gated at the
    # chokepoint, not per-site — covers paths no per-site gate touches.
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    monkeypatch.delenv("LCT_ALLOW_CLOUD_AUDIO", raising=False)
    with pytest.raises(AudioEgressBlocked):
        httpx.Client(timeout=0.3).post(
            "https://stt.example/api/transcribe",
            data={"model": "whisper"},
            files={"file": ("chunk.wav", b"RIFFfakewavdata", "audio/wav")},
        )


def test_central_audio_gate_allows_local_multipart_upload(monkeypatch):
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    with pytest.raises(Exception) as exc_info:
        httpx.Client(timeout=0.2).post(
            "http://127.0.0.1:59999/api/transcribe",
            files={"file": ("chunk.wav", b"RIFFfakewavdata", "audio/wav")},
        )
    assert not isinstance(exc_info.value, AudioEgressBlocked)


def test_central_audio_gate_opt_in_allows_cloud(monkeypatch):
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    monkeypatch.setenv("LCT_ALLOW_CLOUD_AUDIO", "1")
    with pytest.raises(Exception) as exc_info:
        httpx.Client(timeout=0.1).post(
            "https://stt.example/api/transcribe",
            files={"file": ("chunk.wav", b"RIFFfakewavdata", "audio/wav")},
        )
    assert not isinstance(exc_info.value, AudioEgressBlocked)


def test_central_audio_gate_blocks_extensionless_octet_multipart(monkeypatch):
    # codex round-4: the import pipeline can post audio as an EXTENSIONLESS
    # octet-stream multipart part; any non-local multipart is treated as audio.
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    monkeypatch.delenv("LCT_ALLOW_CLOUD_AUDIO", raising=False)
    with pytest.raises(AudioEgressBlocked):
        httpx.Client(timeout=0.3).post(
            "https://stt.example/transcribe",
            files={"file": ("clip", b"RIFF\x00\x00\x00\x00WAVEfake", "application/octet-stream")},
        )


def test_central_audio_gate_blocks_raw_audio_octet_body(monkeypatch):
    # A raw octet-stream body with an audio file signature is caught by magic bytes.
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    monkeypatch.delenv("LCT_ALLOW_CLOUD_AUDIO", raising=False)
    with pytest.raises(AudioEgressBlocked):
        httpx.Client(timeout=0.3).post(
            "https://stt.example/transcribe",
            content=b"RIFF\x24\x00\x00\x00WAVEfmt fake-wav-bytes",
            headers={"content-type": "application/octet-stream"},
        )


def test_multipart_audio_with_name_in_formfield_still_scanned(monkeypatch):
    # codex round-6: a multipart STT request to a frontier host can carry real
    # participant names in form fields (e.g. known_speaker_names[]). Even after
    # the cloud-audio opt-in, the name scan must still run — audio gate AND name
    # scan, not XOR.
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    monkeypatch.setenv("LCT_ALLOW_CLOUD_AUDIO", "1")  # audio gate opted in
    with pytest.raises(UnverifiedEgressBlocked):
        httpx.Client(timeout=0.3).post(
            "https://api.openai.com/v1/audio/transcriptions",
            data={"known_speaker_names[]": "Vatsal"},
            files={"file": ("chunk.wav", b"RIFFfakewavdata", "audio/wav")},
        )


def test_central_audio_gate_blocks_mislabeled_content_type(monkeypatch):
    # codex round-5: raw audio mislabeled as text/plain (or application/json) must
    # STILL be caught by the magic-byte check on the materialized body.
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    monkeypatch.delenv("LCT_ALLOW_CLOUD_AUDIO", raising=False)
    with pytest.raises(AudioEgressBlocked):
        httpx.Client(timeout=0.3).post(
            "https://api.openai.com/x",
            content=b"RIFF\x24\x00\x00\x00WAVEfmt mislabeled-as-text",
            headers={"content-type": "text/plain"},
        )


@pytest.mark.asyncio
async def test_central_audio_gate_blocks_cloud_websocket(monkeypatch):
    monkeypatch.setenv("LCT_LOCAL_ONLY", "0")
    monkeypatch.delenv("LCT_ALLOW_CLOUD_AUDIO", raising=False)
    import websockets

    with pytest.raises(AudioEgressBlocked):
        await websockets.connect("wss://stt.example/realtime")
