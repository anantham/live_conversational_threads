"""Per-provider HTTP transcription transports for the realtime STT path.

These were originally methods on ``RealtimeHttpSttSession``. Each only
needed a handful of session-level fallback fields, never the live
buffer/VAD/circuit state — extracting them as free functions keeps
``stt_http_transcriber.py`` focused on session orchestration and makes
each transport independently testable.

The caller passes session-level defaults via [[SttSessionDefaults]];
fields are used as fallbacks when the candidate dict doesn't specify
its own value (model, language, etc.).

[[ADR-031]] §"finish C" tracks this split.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import httpx

from lct_python_backend.services.env_helpers import env_bool
from .stt_response_parsers import (
    extract_diarized_segments,
    extract_openai_diarized_segments,
    extract_openrouter_transcript_text,
    extract_transcript_text,
    text_from_segments,
)

logger = logging.getLogger("lct_backend")

# Default OFF: these traces echo transcript/LLM content (AGENTS.md #9 —
# diagnostic logging is opt-in). Set TRACE_API_CALLS=1 to enable.
TRACE_API_CALLS = env_bool("TRACE_API_CALLS", default=False)
API_LOG_PREVIEW_CHARS = int(os.getenv("API_LOG_PREVIEW_CHARS", "280"))
OPENROUTER_TRANSCRIPTION_PROMPT = (
    "Transcribe this audio accurately. Return plain text only. "
    "Do not summarize. Do not add speaker labels."
)


def build_known_speakers_form_fields(
    known_speakers: Optional[List[Dict[str, Any]]],
) -> Dict[str, List[str]]:
    """Build the OpenAI form-data fields for known_speakers, supporting
    name-only entries (no voice clip).

    Returns a dict ready to merge into the outgoing form payload. Empty
    dict if there are no usable entries. The caller decides whether to
    apply it (e.g. only for gpt-4o-transcribe-diarize).

    Contract:
        - `known_speaker_names[]` includes every entry with a non-empty
          name (covers participant-picker name-only entries).
        - `known_speaker_references[]` is included only when at least one
          entry has audio_base64. References are wrapped in data: URI
          form if not already so.
    """
    if not known_speakers:
        return {}

    speaker_names: List[str] = []
    speaker_refs: List[str] = []
    for s in known_speakers:
        name = (s.get("name") or "").strip() if isinstance(s, dict) else ""
        if not name:
            continue
        speaker_names.append(name)
        ref = s.get("audio_base64") if isinstance(s, dict) else None
        if ref:
            if not ref.startswith("data:"):
                ref = f"data:audio/wav;base64,{ref}"
            speaker_refs.append(ref)

    if not speaker_names:
        return {}

    fields: Dict[str, List[str]] = {"known_speaker_names[]": speaker_names}
    if speaker_refs:
        fields["known_speaker_references[]"] = speaker_refs
    return fields


@dataclass(frozen=True)
class SttSessionDefaults:
    """Session-level fallback values consumed by per-provider transports.

    The candidate dict carries per-candidate overrides; when a field is
    missing or empty, the transport falls back to the matching value
    here.
    """

    provider: str = ""
    http_url: str = ""
    model: str = ""
    language: str = ""


def _preview_text(value: Any, limit: int = API_LOG_PREVIEW_CHARS) -> str:
    if value is None:
        return ""
    text = str(value)
    if len(text) <= limit:
        return text
    return text[:limit] + "..."


def _parse_response_payload(response: httpx.Response) -> Any:
    content_type = str(response.headers.get("content-type", "")).lower()
    if "application/json" in content_type:
        return response.json()
    text = response.text or ""
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return text


async def transcribe_backend_http_candidate(
    client: httpx.AsyncClient,
    candidate: Dict[str, Any],
    pcm_bytes: bytes,
    wav_payload: bytes,
    *,
    defaults: SttSessionDefaults,
    diarize_default: bool = False,
    embeddings_default: bool = False,
) -> Tuple[str, Optional[List[Dict[str, Any]]], bool]:
    http_url = str(candidate.get("http_url") or defaults.http_url or "").strip()
    model = str(candidate.get("model") or defaults.model or "").strip()
    language = str(candidate.get("language") or defaults.language or "").strip()
    embeddings_enabled = bool(candidate.get("request_embeddings", embeddings_default))
    # Speaker embeddings (ECAPA, ADR-022) need speaker turns, so the local STT
    # server treats include_embeddings as implying diarization. Mirror that here so
    # diarized segments — which carry the per-segment `embedding` — get parsed even
    # if diarization wasn't explicitly requested.
    diarize_enabled = bool(candidate.get("request_diarization", diarize_default)) or embeddings_enabled
    form_data: Dict[str, str] = {"diarize": "true" if diarize_enabled else "false"}
    if embeddings_enabled:
        form_data["include_embeddings"] = "true"
    if model:
        form_data["model"] = model
    if language:
        form_data["language"] = language

    if TRACE_API_CALLS:
        logger.info(
            "[STT HTTP] POST %s provider=%s chunk_bytes=%s wav_bytes=%s model=%s language=%s diarize=%s include_embeddings=%s",
            http_url,
            candidate.get("provider") or defaults.provider,
            len(pcm_bytes),
            len(wav_payload),
            model or "-",
            language or "-",
            diarize_enabled,
            embeddings_enabled,
        )

    # ADR-038 audio hard-gate (codex review, Bug 1): the generic backend HTTP STT
    # path also ships raw WAV — keep it local-only at LCT_LOCAL_ONLY=0 too.
    from lct_python_backend.services.privacy_boundary import assert_audio_egress_allowed
    assert_audio_egress_allowed(http_url, purpose="backend HTTP audio STT")
    response = await client.post(
        http_url,
        data=form_data,
        files={"file": ("chunk.wav", wav_payload, "audio/wav")},
    )
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        if TRACE_API_CALLS:
            logger.warning(
                "[STT HTTP] %s status=%s body_preview=%s",
                http_url,
                exc.response.status_code,
                _preview_text(exc.response.text),
            )
        raise

    payload = _parse_response_payload(response)
    text = extract_transcript_text(payload)
    segments = extract_diarized_segments(payload) if diarize_enabled else None
    if TRACE_API_CALLS:
        logger.info(
            "[STT HTTP] %s status=%s transcript_preview=%s speakers=%s",
            http_url,
            response.status_code,
            _preview_text(text),
            len(segments) if segments else 0,
        )
    return text, segments, diarize_enabled


async def transcribe_openai_audio_candidate(
    client: httpx.AsyncClient,
    candidate: Dict[str, Any],
    wav_payload: bytes,
    *,
    defaults: SttSessionDefaults,
    known_speakers: Optional[List[Dict[str, str]]] = None,
) -> Tuple[str, Optional[List[Dict[str, Any]]], bool]:
    model = str(candidate.get("model") or "").strip()
    api_key = str(candidate.get("api_key") or "").strip()
    http_url = str(candidate.get("http_url") or "").strip()
    language = str(candidate.get("language") or defaults.language or "").strip()
    request_diarization = bool(candidate.get("request_diarization", True))

    # OpenAI supports streaming for already completed audio recordings.
    # DISABLED: streaming causes httpx issues with error handling and fallback chain.
    should_stream = False

    response_format = "diarized_json" if request_diarization else "json"
    form_data: Dict[str, Any] = {
        "model": model,
        "response_format": response_format,
        # Local OpenAI-compatible STT servers (the M5) key diarization off a plain
        # `diarize` form field, not OpenAI's response_format/model gate. Send it so
        # they diarize; the real OpenAI API ignores the extra multipart field and
        # uses response_format instead. (Cloud OpenAI is refused under
        # LCT_LOCAL_ONLY anyway, so in practice this path only hits local servers.)
        "diarize": "true" if request_diarization else "false",
    }
    if request_diarization:
        form_data["chunking_strategy"] = "auto"
        if known_speakers and model == "gpt-4o-transcribe-diarize":
            # Names always pass through; clip refs are gated upstream by
            # privacy tier (we just see audio_base64 = None when restricted).
            form_data.update(build_known_speakers_form_fields(known_speakers))
    # ADR-032 Part F: request word-level timestamps from the diarization
    # refinement call. One slow pass, double duty: speaker reconciliation
    # AND word_timings for the Descript-style synced transcript UI.
    # OpenAI's API takes ``timestamp_granularities[]`` as a repeated form
    # field; httpx-multipart accepts a list value. If diarized_json doesn't
    # surface word_timings, we'll see it in the response and adjust.
    if model in ("gpt-4o-transcribe-diarize", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"):
        form_data["timestamp_granularities[]"] = "word"

    if language:
        form_data["language"] = language
    if should_stream:
        form_data["stream"] = "true"

    headers = {"Authorization": f"Bearer {api_key}"}

    if TRACE_API_CALLS:
        logger.info(
            "[STT OpenAI] POST %s model=%s wav_bytes=%s response_format=%s language=%s stream=%s known_speakers=%s",
            http_url,
            model or "-",
            len(wav_payload),
            response_format,
            language or "-",
            should_stream,
            len(known_speakers) if known_speakers else 0,
        )

    if should_stream:
        full_text = ""
        # ADR-038 audio hard-gate (codex review, Bug 1): cover the streaming
        # branch too, so a future re-enable cannot bypass the gate.
        from lct_python_backend.services.privacy_boundary import assert_audio_egress_allowed
        assert_audio_egress_allowed(http_url, purpose="OpenAI streaming audio STT")
        async with client.stream(
            "POST",
            http_url,
            headers=headers,
            data=form_data,
            files={"file": ("chunk.wav", wav_payload, "audio/wav")},
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line or not line.startswith("data: "):
                    continue
                data_str = line[len("data: "):].strip()
                if data_str == "[DONE]":
                    break
                try:
                    chunk_payload = json.loads(data_str)
                    text_part = extract_transcript_text(chunk_payload)
                    if text_part:
                        full_text += text_part
                except json.JSONDecodeError:
                    continue
        return full_text, None, False

    # ADR-038 audio hard-gate: raw audio cannot be redacted, so it stays
    # local-only even at LCT_LOCAL_ONLY=0 unless LCT_ALLOW_CLOUD_AUDIO=1 (codex blocker 2).
    from lct_python_backend.services.privacy_boundary import assert_audio_egress_allowed
    assert_audio_egress_allowed(http_url, purpose="OpenAI HTTP audio STT")
    response = await client.post(
        http_url,
        headers=headers,
        data=form_data,
        files={"file": ("chunk.wav", wav_payload, "audio/wav")},
    )
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        if TRACE_API_CALLS:
            logger.warning(
                "[STT OpenAI] %s status=%s body_preview=%s",
                http_url,
                exc.response.status_code,
                _preview_text(exc.response.text),
            )
        raise
    payload = _parse_response_payload(response)
    # A local OpenAI-compatible server (the M5) may return whisperx-style diarized
    # segments rather than OpenAI's shape, so fall back to the generic extractor.
    segments = None
    if request_diarization:
        segments = extract_openai_diarized_segments(payload) or extract_diarized_segments(payload)
    text = extract_transcript_text(payload) or text_from_segments(segments)
    if TRACE_API_CALLS:
        logger.info(
            "[STT OpenAI] %s status=%s transcript_preview=%s speakers=%s",
            http_url,
            response.status_code,
            _preview_text(text),
            len(segments) if segments else 0,
        )
    return text, segments, request_diarization


async def transcribe_openrouter_audio_candidate(
    client: httpx.AsyncClient,
    candidate: Dict[str, Any],
    wav_payload: bytes,
    *,
    defaults: SttSessionDefaults,
) -> Tuple[str, Optional[List[Dict[str, Any]]], bool]:
    model = str(candidate.get("model") or "").strip()
    api_key = str(candidate.get("api_key") or "").strip()
    http_url = str(candidate.get("http_url") or "").strip()
    language = str(candidate.get("language") or defaults.language or "").strip()
    prompt = OPENROUTER_TRANSCRIPTION_PROMPT
    if language:
        prompt = f"{prompt} The audio language is {language}."
    base64_audio = base64.b64encode(wav_payload).decode("utf-8")
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "input_audio",
                        "input_audio": {
                            "data": base64_audio,
                            "format": "wav",
                        },
                    },
                ],
            }
        ],
        "stream": False,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    if TRACE_API_CALLS:
        logger.info(
            "[STT OpenRouter] POST %s model=%s wav_bytes=%s language=%s",
            http_url,
            model or "-",
            len(wav_payload),
            language or "-",
        )

    # ADR-038 audio hard-gate (codex blocker 2) — see OpenAI HTTP audio path above.
    from lct_python_backend.services.privacy_boundary import assert_audio_egress_allowed
    assert_audio_egress_allowed(http_url, purpose="OpenRouter HTTP audio STT")
    response = await client.post(http_url, headers=headers, json=payload)
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        if TRACE_API_CALLS:
            logger.warning(
                "[STT OpenRouter] %s status=%s body_preview=%s",
                http_url,
                exc.response.status_code,
                _preview_text(exc.response.text),
            )
        raise
    response_payload = _parse_response_payload(response)
    text = extract_openrouter_transcript_text(response_payload)
    if TRACE_API_CALLS:
        logger.info(
            "[STT OpenRouter] %s status=%s transcript_preview=%s",
            http_url,
            response.status_code,
            _preview_text(text),
        )
    return text, None, False
