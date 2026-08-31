import cgi
import json
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Optional

from lct_python_backend.services.stt import stt_http_transcriber as transcriber_mod
from lct_python_backend.tests.integration.transcripts_test_support import (
    build_processor_class,
    build_test_client,
    pcm_audio_base64,
    receive_session_ack,
    receive_until_type,
)


@dataclass
class RecordedRequest:
    path: str
    filename: Optional[str]
    language: Optional[str]
    model: Optional[str]
    diarize: Optional[str]
    wav_bytes: bytes


@dataclass
class FakeSttServerState:
    requests: list[RecordedRequest] = field(default_factory=list)


@contextmanager
def fake_stt_server(response_factory):
    state = FakeSttServerState()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            content_type = self.headers.get("Content-Type", "")
            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={
                    "REQUEST_METHOD": "POST",
                    "CONTENT_TYPE": content_type,
                    "CONTENT_LENGTH": self.headers.get("Content-Length", "0"),
                },
            )

            file_item = form["file"] if "file" in form else None
            wav_bytes = file_item.file.read() if file_item is not None else b""
            request = RecordedRequest(
                path=self.path,
                filename=getattr(file_item, "filename", None),
                language=form.getvalue("language"),
                model=form.getvalue("model"),
                diarize=form.getvalue("diarize"),
                wav_bytes=wav_bytes,
            )
            self.server.state.requests.append(request)

            payload = response_factory(request)
            body = json.dumps(payload).encode("utf-8")

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.state = state
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        yield state, f"http://127.0.0.1:{server.server_port}/api/transcribe"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_transcripts_ws_streams_audio_to_http_stt_and_requests_diarization(monkeypatch):
    persisted = []
    processor_calls = {"final": [], "flush": 0}

    async def fake_persist(_session, _state, payload, event_type, text):
        persisted.append((event_type, text, payload))

    def response_factory(_request):
        return {
            "text": "stream chunk.",
            "speakers": [
                {
                    "speaker": "SPEAKER_00",
                    "start": 0.0,
                    "end": 0.3,
                    "text": "stream chunk.",
                }
            ],
        }

    monkeypatch.setattr(transcriber_mod, "STT_DIARIZE_ENABLED", True)
    monkeypatch.setattr(transcriber_mod, "STT_HTTP_POOL_ENABLED", False)

    with fake_stt_server(response_factory) as (state, http_url):
        client = build_test_client(
            monkeypatch,
            stt_settings={
                "provider": "whisper",
                "local_authorities": [
                    {
                        "id": "test-whisper",
                        "enabled": True,
                        "provider": "whisper",
                        "http_url": http_url,
                        "supports_diarization": True,
                        "request_diarization": True,
                    }
                ],
                "provider_http_urls": {"whisper": http_url},
                "http_url": http_url,
                "http_chunk_seconds": 0.25,
                "http_model": "stream-test",
                "http_language": "en",
            },
            processor_cls=build_processor_class(processor_calls),
            persist_side_effect=fake_persist,
        )

        conversation_id = str(uuid.uuid4())

        with client.websocket_connect("/ws/transcripts") as ws:
            ws.send_json(
                {
                    "type": "session_meta",
                    "conversation_id": conversation_id,
                    "session_id": "session-http-diarize",
                    "provider": "whisper",
                    "store_audio": False,
                }
            )
            ack = receive_session_ack(ws)
            assert ack["type"] == "session_ack"
            assert ack["stt_ready"] is True
            assert ack["provider_http_url"] == http_url

            ws.send_json({"type": "audio_chunk", "audio_base64": pcm_audio_base64(0.3)})

            partial_msg = receive_until_type(ws, "transcript_partial")
            final_msg = receive_until_type(ws, "transcript_final")
            assert partial_msg["type"] == "transcript_partial"
            assert final_msg["type"] == "transcript_final"
            assert final_msg["text"] == "stream chunk."

            ws.send_json({"type": "final_flush"})
            flush_ack = ws.receive_json()
            assert flush_ack["type"] == "flush_ack"

        time.sleep(0.05)

    assert [event for event, *_rest in persisted] == ["partial", "final"]
    assert processor_calls["final"] == [
        (
            "stream chunk.",
            [
                {
                    "speaker": "SPEAKER_00",
                    "start": 0.0,
                    "end": 0.3,
                    "text": "stream chunk.",
                }
            ],
        )
    ]
    assert processor_calls["flush"] == 1

    assert len(state.requests) == 1
    request = state.requests[0]
    assert request.path == "/api/transcribe"
    assert request.filename == "chunk.wav"
    assert request.language == "en"
    assert request.model == "stream-test"
    assert request.diarize == "true"
    assert request.wav_bytes.startswith(b"RIFF")
    assert b"WAVE" in request.wav_bytes[:24]


def test_transcripts_ws_streams_audio_to_http_stt_and_sends_diarize_false(monkeypatch):
    processor_calls = {"final": [], "flush": 0}

    def response_factory(_request):
        return {"text": "plain chunk."}

    monkeypatch.setattr(transcriber_mod, "STT_DIARIZE_ENABLED", False)
    monkeypatch.setattr(transcriber_mod, "STT_HTTP_POOL_ENABLED", False)

    with fake_stt_server(response_factory) as (state, http_url):
        client = build_test_client(
            monkeypatch,
            stt_settings={
                "provider": "whisper",
                "local_authorities": [
                    {
                        "id": "test-whisper",
                        "enabled": True,
                        "provider": "whisper",
                        "http_url": http_url,
                        "supports_diarization": True,
                        "request_diarization": False,
                    }
                ],
                "provider_http_urls": {"whisper": http_url},
                "http_url": http_url,
                "http_chunk_seconds": 0.25,
                "http_language": "en",
            },
            processor_cls=build_processor_class(processor_calls),
        )

        with client.websocket_connect("/ws/transcripts") as ws:
            ws.send_json(
                {
                    "type": "session_meta",
                    "conversation_id": str(uuid.uuid4()),
                    "session_id": "session-http-no-diarize",
                    "provider": "whisper",
                    "store_audio": False,
                }
            )
            ack = receive_session_ack(ws)
            assert ack["type"] == "session_ack"
            assert ack["stt_ready"] is True

            ws.send_json({"type": "audio_chunk", "audio_base64": pcm_audio_base64(0.3)})
            assert receive_until_type(ws, "transcript_partial")["type"] == "transcript_partial"
            assert receive_until_type(ws, "transcript_final")["type"] == "transcript_final"

            ws.send_json({"type": "final_flush"})
            assert ws.receive_json()["type"] == "flush_ack"

        time.sleep(0.05)

    assert processor_calls["final"] == [("plain chunk.", None)]
    assert processor_calls["flush"] == 1
    assert len(state.requests) == 1
    assert state.requests[0].diarize == "false"
