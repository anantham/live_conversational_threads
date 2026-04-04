"""Provider-agnostic live STT runtime selection and adapters."""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Protocol

from lct_python_backend.services.stt_http_transcriber import RealtimeHttpSttSession
from lct_python_backend.services.stt_openai_realtime import OpenAIRealtimeTranscriptionRuntime

STT_OPENAI_REALTIME_ENABLED = os.getenv("STT_OPENAI_REALTIME_ENABLED", "true").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}


class LiveSttRuntime(Protocol):
    provider: str
    transport: str
    stt_mode: str
    sample_rate_hz: int
    timeout_seconds: float
    supports_diarization: bool

    def is_ready(self) -> bool: ...

    def get_last_runtime_metadata(self) -> Dict[str, Any]: ...

    async def start(self) -> None: ...

    async def push_audio_chunk(self, pcm_bytes: bytes) -> List[Dict[str, Any]]: ...

    async def flush(self) -> List[Dict[str, Any]]: ...

    async def close(self) -> None: ...


class HttpLiveSttRuntime:
    stt_mode = "backend_http"

    def __init__(self, session: RealtimeHttpSttSession, *, provider: str, transport: str, supports_diarization: bool) -> None:
        self._session = session
        self.provider = provider
        self.transport = transport
        self.supports_diarization = supports_diarization
        self.sample_rate_hz = session.sample_rate_hz
        self.timeout_seconds = session.timeout_seconds
        self.model = session.model
        self.language = session.language

    def is_ready(self) -> bool:
        return self._session.is_ready()

    def get_last_runtime_metadata(self) -> Dict[str, Any]:
        return self._session.get_last_runtime_metadata()

    async def start(self) -> None:
        return None

    async def push_audio_chunk(self, pcm_bytes: bytes) -> List[Dict[str, Any]]:
        result = await self._session.push_audio_chunk(pcm_bytes)
        if not result:
            return []
        return [
            {
                "event_type": "partial",
                "text": result.get("text") or "",
                "metadata": result.get("metadata") or {},
                "segments": result.get("segments"),
                "_wav_payload": result.get("_wav_payload"),
            }
        ]

    async def flush(self) -> List[Dict[str, Any]]:
        result = await self._session.flush()
        if not result:
            return []
        return [
            {
                "event_type": "final",
                "text": result.get("text") or "",
                "metadata": result.get("metadata") or {},
                "segments": result.get("segments"),
                "_wav_payload": result.get("_wav_payload"),
            }
        ]

    async def close(self) -> None:
        await self._session.close()


def _primary_candidate(
    candidates: Optional[List[Dict[str, Any]]],
    *,
    provider: str,
    http_url: str,
) -> Dict[str, Any]:
    if candidates:
        return dict(candidates[0])
    return {
        "provider": provider,
        "transport": "backend_http",
        "http_url": http_url,
        "supports_diarization": provider == "whisper",
    }


def build_live_stt_runtime(
    *,
    provider: str,
    http_url: str,
    sample_rate_hz: int,
    chunk_seconds: float,
    timeout_seconds: float,
    model: str,
    language: str,
    candidates: Optional[List[Dict[str, Any]]],
    session_id: str,
    conversation_id: str,
    prefer_streaming: bool = True,
) -> LiveSttRuntime:
    primary_candidate = _primary_candidate(candidates, provider=provider, http_url=http_url)
    primary_provider = str(primary_candidate.get("provider") or provider).strip() or provider
    primary_transport = str(primary_candidate.get("transport") or "backend_http").strip() or "backend_http"
    supports_diarization = bool(primary_candidate.get("supports_diarization")) and bool(
        primary_candidate.get("request_diarization", True)
    )

    if (
        prefer_streaming
        and STT_OPENAI_REALTIME_ENABLED
        and primary_provider == "openai_audio"
        and primary_transport == "openai_audio"
        and bool(primary_candidate.get("supports_realtime_streaming"))
    ):
        return OpenAIRealtimeTranscriptionRuntime(
            provider=primary_provider,
            api_key=str(primary_candidate.get("api_key") or "").strip(),
            model=str(primary_candidate.get("model") or model or "").strip(),
            base_url=str(primary_candidate.get("base_url") or primary_candidate.get("http_url") or "").strip(),
            sample_rate_hz=sample_rate_hz,
            timeout_seconds=timeout_seconds,
            language=str(primary_candidate.get("language") or language or "").strip(),
            session_id=session_id,
            conversation_id=conversation_id,
        )

    http_session = RealtimeHttpSttSession(
        provider=primary_provider,
        http_url=str(primary_candidate.get("http_url") or http_url or "").strip(),
        sample_rate_hz=sample_rate_hz,
        chunk_seconds=chunk_seconds,
        timeout_seconds=timeout_seconds,
        model=str(primary_candidate.get("model") or model or "").strip(),
        language=str(primary_candidate.get("language") or language or "").strip(),
        candidates=candidates,
        session_id=session_id,
        conversation_id=conversation_id,
    )
    return HttpLiveSttRuntime(
        http_session,
        provider=primary_provider,
        transport=primary_transport,
        supports_diarization=supports_diarization,
    )
