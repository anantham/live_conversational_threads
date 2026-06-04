"""LLM API callers for transcript processing (Gemini + local).

Extracted from transcript_processing.py — contains configuration helpers,
API tracing, and all sync LLM call functions with retry logic.
"""

import json
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx
from google import genai
from google.genai import types

from lct_python_backend.services.llm_config import get_env_llm_defaults, get_default_providers
from lct_python_backend.services.local_llm_client import (
    extract_json_from_text,
    chat_with_provider_fallback_sync,
    ProviderResult,
)
from lct_python_backend.services.transcript_normalizer import _normalize_generated_output
from lct_python_backend.services.transcript_prompts import (
    PROMPT_ID_ACCUMULATE_TRANSCRIPT_SEGMENT,
    PROMPT_ID_ACCUMULATE_TRANSCRIPT_SEGMENT_LOCAL,
    PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY,
    PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY_LOCAL,
    get_transcript_prompt_metadata,
    get_transcript_prompt_text,
)

logger = logging.getLogger("lct_backend")


def _sleep_backoff(attempt: int, base: float) -> None:
    """Exponential backoff sleep between retry attempts (sync — safe in thread context)."""
    time.sleep(base ** attempt)

# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------
GEMINI_MODEL_NAME = os.getenv("ONLINE_LLM_CHAT_MODEL", "gemini-2.5-flash")
from lct_python_backend.services.env_helpers import env_bool

TRACE_API_CALLS = env_bool("TRACE_API_CALLS", default=True)
API_LOG_PREVIEW_CHARS = int(os.getenv("API_LOG_PREVIEW_CHARS", "280"))
_JSON_OBJECT_UNSUPPORTED_BASE_URLS: set[str] = set()
_GEMINI_KEY_ENV_ORDER = ("GOOGLEAI_API_KEY", "GEMINI_API_KEY", "GEMINI_KEY")


# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------
def _resolve_llm_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return config or get_env_llm_defaults()


def _resolve_online_gemini_model(llm_config: Optional[Dict[str, Any]] = None) -> str:
    config = _resolve_llm_config(llm_config)
    configured = str(config.get("chat_model") or "").strip()
    if configured.startswith("models/"):
        configured = configured[len("models/") :]
    if "/" in configured and "gemini" in configured.lower():
        tail = configured.split("/")[-1]
        if "gemini" in tail.lower():
            configured = tail

    if "gemini" in configured.lower():
        return configured
    return GEMINI_MODEL_NAME


def _resolve_gemini_api_key() -> Tuple[Optional[str], Optional[str]]:
    for env_name in _GEMINI_KEY_ENV_ORDER:
        value = str(os.getenv(env_name, "")).strip()
        if value:
            return value, env_name
    return None, None


def _missing_gemini_key_message() -> str:
    return (
        "Online mode requires a Gemini key (GOOGLEAI_API_KEY, GEMINI_API_KEY, or GEMINI_KEY); "
        "falling back to local LLM."
    )


# ---------------------------------------------------------------------------
# Trace helpers
# ---------------------------------------------------------------------------
def _preview_text(value: Any, limit: int = API_LOG_PREVIEW_CHARS) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return f"{text[:limit]}...<truncated {len(text) - limit} chars>"


def _trace_api_call(message: str, *args: Any) -> None:
    if TRACE_API_CALLS:
        logger.info(message, *args)


# ---------------------------------------------------------------------------
# Sync local caller (with provider fallback support)
# ---------------------------------------------------------------------------
def _call_local_chat_json_with_fallback(
    prompt: str,
    system_prompt: str,
    providers: Optional[List[Dict[str, Any]]] = None,
    temperature: float = 0.65,
    max_tokens: int = 4000,
) -> Tuple[Any, Optional[ProviderResult]]:
    """
    Call local LLM with provider fallback support.

    Returns:
        Tuple of (parsed_json, provider_result) where provider_result contains
        metadata about which provider succeeded.
    """
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": prompt},
    ]

    if providers is None:
        providers = get_default_providers()

    _trace_api_call(
        "[LLM API] Calling with %s enabled providers, prompt_chars=%s",
        len([p for p in providers if p.get("enabled", True)]),
        len(str(prompt or "")),
    )

    result = chat_with_provider_fallback_sync(
        messages=messages,
        providers=providers,
        temperature=temperature,
        max_tokens=max_tokens,
        require_json=True,
    )

    return result.data, result


def _call_local_chat_json(
    prompt: str,
    system_prompt: str,
    config: Dict[str, Any],
    temperature: float = 0.65,
    max_tokens: int = 4000,
) -> Any:
    """Legacy single-endpoint caller for backwards compatibility."""
    base_url = str(config.get("base_url", "")).rstrip("/")
    if not base_url:
        raise ValueError("Local LLM base_url is required.")

    payload = {
        "model": config.get("chat_model", "zai-org/glm-4.6v-flash"),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    use_json_object = bool(config.get("json_mode", True)) and base_url not in _JSON_OBJECT_UNSUPPORTED_BASE_URLS
    if use_json_object:
        payload["response_format"] = {"type": "json_object"}

    url = f"{base_url}/v1/chat/completions"
    timeout = float(config.get("timeout_seconds", 120))
    _trace_api_call(
        "[LLM API] POST %s model=%s prompt_chars=%s json_mode=%s",
        url,
        payload.get("model"),
        len(str(prompt or "")),
        "json_object" if "response_format" in payload else "none",
    )
    with httpx.Client(timeout=timeout) as client:
        try:
            response = client.post(url, json=payload)
            response.raise_for_status()
            raw_json = response.json()
            content = raw_json["choices"][0]["message"]["content"]
            _trace_api_call(
                "[LLM API] %s status=%s content_preview=%s",
                url,
                response.status_code,
                _preview_text(content),
            )
            return extract_json_from_text(content)
        except httpx.HTTPStatusError as exc:
            if "response_format" in payload:
                body_preview = _preview_text(exc.response.text)
                logger.warning(
                    "Local LLM response_format rejected (%s); retrying without response_format.",
                    body_preview,
                )
                _JSON_OBJECT_UNSUPPORTED_BASE_URLS.add(base_url)
                payload.pop("response_format", None)
                _trace_api_call("[LLM API] retry POST %s without response_format", url)
                retry = client.post(url, json=payload)
                retry.raise_for_status()
                retry_json = retry.json()
                content = retry_json["choices"][0]["message"]["content"]
                _trace_api_call(
                    "[LLM API] %s retry_status=%s content_preview=%s",
                    url,
                    retry.status_code,
                    _preview_text(content),
                )
                return extract_json_from_text(content)
            raise


# ---------------------------------------------------------------------------
# Gemini callers
# ---------------------------------------------------------------------------
def generate_lct_json_gemini(
    transcript: str,
    model_name: Optional[str] = None,
    api_key: Optional[str] = None,
    key_source: Optional[str] = None,
    retries: int = 5,
    backoff_base: float = 1.5,
    status_messages: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    resolved_model = str(model_name or GEMINI_MODEL_NAME).strip() or GEMINI_MODEL_NAME
    resolved_key = str(api_key or "").strip()
    if not resolved_key:
        resolved_key, key_source = _resolve_gemini_api_key()

    if not resolved_key:
        message = _missing_gemini_key_message()
        logger.error("%s Cannot generate graph nodes with Gemini.", message)
        if status_messages is not None:
            status_messages.append(message)
        return []

    # Local-only guard: Gemini is a cloud-only provider (genai SDK dials
    # generativelanguage.googleapis.com). Refuse it when LCT_LOCAL_ONLY is on,
    # before constructing the client / spending the key.
    from lct_python_backend.services.egress_guard import assert_local_egress
    assert_local_egress(
        "https://generativelanguage.googleapis.com",
        purpose="Gemini graph generation",
    )

    client = genai.Client(api_key=resolved_key)
    if key_source:
        _trace_api_call("[GEMINI] Using key from %s for graph generation model=%s.", key_source, resolved_model)

    prompt_metadata = get_transcript_prompt_metadata(PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY)
    generate_lct_prompt = get_transcript_prompt_text(PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY)

    contents = [
        types.Content(
            role="user",
            parts=[types.Part.from_text(text=transcript)],
        )
    ]

    config = types.GenerateContentConfig(
        temperature=float(prompt_metadata.get("temperature", 0.65)),
        thinking_config=types.ThinkingConfig(thinking_budget=0),
        response_mime_type="application/json",
        system_instruction=[types.Part.from_text(text=generate_lct_prompt)],
    )

    last_error: Optional[str] = None
    for attempt in range(retries):
        full_response = ""
        try:
            for chunk in client.models.generate_content_stream(
                model=resolved_model,
                contents=contents,
                config=config,
            ):
                if hasattr(chunk, "text"):
                    full_response += chunk.text

            try:
                parsed = json.loads(full_response)
                normalized = _normalize_generated_output(parsed)
                if normalized:
                    return normalized
                last_error = f"Gemini response decoded but produced no normalized nodes (attempt {attempt + 1})."
                logger.warning("[LCT JSON] %s", last_error)
            except json.JSONDecodeError as e:
                last_error = f"Gemini JSON decode failed on attempt {attempt + 1}: {e}"
                logger.warning("[LCT JSON] %s", last_error)
                logger.debug("[LCT JSON] Raw Gemini response: %s", full_response)

        except Exception as e:
            last_error = f"Gemini request failed on attempt {attempt + 1}: {e}"
            logger.warning("[LCT JSON] %s", last_error)

        _sleep_backoff(attempt, backoff_base)

    logger.error("[LCT JSON] All attempts failed, returning empty list.")
    if status_messages is not None and last_error:
        status_messages.append(last_error)
    return []


def genai_accumulate_text_json(
    input_text: str,
    model_name: Optional[str] = None,
    api_key: Optional[str] = None,
    key_source: Optional[str] = None,
    retries: int = 3,
    backoff_base: float = 1.5,
) -> Dict[str, Any]:
    resolved_model = str(model_name or GEMINI_MODEL_NAME).strip() or GEMINI_MODEL_NAME
    errors: List[str] = []
    resolved_key = str(api_key or "").strip()
    if not resolved_key:
        resolved_key, key_source = _resolve_gemini_api_key()
    if not resolved_key:
        message = _missing_gemini_key_message()
        logger.error("%s Cannot accumulate transcript text with Gemini.", message)
        return {
            "decision": "continue_accumulating",
            "Completed_segment": "",
            "Incomplete_segment": input_text,
            "detected_threads": [],
            "_errors": [message],
        }

    # Local-only guard: Gemini is cloud-only (genai SDK dials
    # generativelanguage.googleapis.com). Refuse it when LCT_LOCAL_ONLY is on,
    # before the retry loop constructs the client / spends the key.
    from lct_python_backend.services.egress_guard import assert_local_egress
    assert_local_egress(
        "https://generativelanguage.googleapis.com",
        purpose="Gemini transcript accumulation",
    )

    prompt_metadata = get_transcript_prompt_metadata(PROMPT_ID_ACCUMULATE_TRANSCRIPT_SEGMENT)
    system_prompt = get_transcript_prompt_text(PROMPT_ID_ACCUMULATE_TRANSCRIPT_SEGMENT)

    for attempt in range(retries):
        full_response = ""
        try:
            client = genai.Client(api_key=resolved_key)
            if key_source:
                _trace_api_call("[GEMINI] Using key from %s for accumulation model=%s.", key_source, resolved_model)

            contents = [
                types.Content(
                    role="user",
                    parts=[types.Part.from_text(text=input_text)],
                ),
            ]

            config = types.GenerateContentConfig(
                temperature=float(prompt_metadata.get("temperature", 0.65)),
                thinking_config=types.ThinkingConfig(thinking_budget=0),
                response_mime_type="application/json",
                response_schema=genai.types.Schema(
                    type=genai.types.Type.OBJECT,
                    properties={
                        "decision": genai.types.Schema(type=genai.types.Type.STRING),
                        "Completed_segment": genai.types.Schema(type=genai.types.Type.STRING),
                        "Incomplete_segment": genai.types.Schema(type=genai.types.Type.STRING),
                        "detected_threads": genai.types.Schema(
                            type=genai.types.Type.ARRAY,
                            items=genai.types.Schema(type=genai.types.Type.STRING),
                        ),
                    },
                ),
                system_instruction=[types.Part.from_text(text=system_prompt)],
            )

            for chunk in client.models.generate_content_stream(
                model=resolved_model,
                contents=contents,
                config=config,
            ):
                if hasattr(chunk, "text"):
                    full_response += str(chunk.text)

            try:
                parsed = json.loads(full_response)
                if errors:
                    parsed["_warnings"] = errors
                return parsed
            except json.JSONDecodeError as e:
                logger.warning("[ACCUMULATE] Attempt %s JSON decode failed: %s", attempt + 1, e)
                logger.debug("[ACCUMULATE] Raw Gemini response: %s", full_response)
                errors.append(f"Attempt {attempt + 1} decode failed: {e}")

        except Exception as e:
            logger.warning("[ACCUMULATE] Attempt %s failed: %s", attempt + 1, e)
            errors.append(f"Attempt {attempt + 1} failed: {e}")

        _sleep_backoff(attempt, backoff_base)

    logger.error("[ACCUMULATE] All decoding attempts failed - using fallback.")
    return {
        "decision": "continue_accumulating",
        "Completed_segment": "",
        "Incomplete_segment": input_text,
        "detected_threads": [],
        "_errors": errors or ["Gemini accumulation attempts exhausted"],
    }


# ---------------------------------------------------------------------------
# Local callers (with provider fallback)
# ---------------------------------------------------------------------------
def generate_lct_json_local(
    transcript: str,
    llm_config: Optional[Dict[str, Any]] = None,
    providers: Optional[List[Dict[str, Any]]] = None,
    retries: int = 5,
    backoff_base: float = 1.5,
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """
    Generate LCT JSON using local LLM with provider fallback.

    Returns:
        Tuple of (nodes_list, backend_label) where backend_label is like 'local_qwen3-32b'
    """
    if providers is None:
        providers = get_default_providers()
    prompt_metadata = get_transcript_prompt_metadata(PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY_LOCAL)
    system_prompt = get_transcript_prompt_text(PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY_LOCAL)

    for attempt in range(retries):
        try:
            parsed, provider_result = _call_local_chat_json_with_fallback(
                prompt=transcript,
                system_prompt=system_prompt,
                providers=providers,
                temperature=float(prompt_metadata.get("temperature", 0.65)),
                max_tokens=int(prompt_metadata.get("max_tokens", 4000)),
            )
            normalized = _normalize_generated_output(parsed)
            if normalized:
                backend_label = provider_result.backend_label() if provider_result else None
                return normalized, backend_label
            logger.warning(
                "[LCT JSON] Local response decoded but produced no normalized nodes; attempt %s",
                attempt + 1,
            )
        except Exception as e:
            logger.warning("[LCT JSON] Local attempt %s failed: %s", attempt + 1, e)

        _sleep_backoff(attempt, backoff_base)

    logger.error("[LCT JSON] Local attempts exhausted; returning empty list.")
    return [], None


def accumulate_text_json_local(
    input_text: str,
    llm_config: Optional[Dict[str, Any]] = None,
    providers: Optional[List[Dict[str, Any]]] = None,
    retries: int = 3,
    backoff_base: float = 1.5,
) -> Tuple[Dict[str, Any], Optional[str]]:
    """
    Accumulate transcript text using local LLM with provider fallback.

    Returns:
        Tuple of (result_dict, backend_label) where backend_label is like 'local_qwen3-32b'
    """
    if providers is None:
        providers = get_default_providers()
    prompt_metadata = get_transcript_prompt_metadata(PROMPT_ID_ACCUMULATE_TRANSCRIPT_SEGMENT)
    system_prompt = get_transcript_prompt_text(PROMPT_ID_ACCUMULATE_TRANSCRIPT_SEGMENT)

    errors: List[str] = []
    for attempt in range(retries):
        try:
            parsed, provider_result = _call_local_chat_json_with_fallback(
                prompt=input_text,
                system_prompt=system_prompt,
                providers=providers,
                temperature=float(prompt_metadata.get("temperature", 0.65)),
                max_tokens=int(prompt_metadata.get("max_tokens", 4000)),
            )
            if isinstance(parsed, dict):
                if errors:
                    parsed["_warnings"] = errors
                backend_label = provider_result.backend_label() if provider_result else None
                return parsed, backend_label
            logger.warning("[ACCUMULATE] Local response was not a dict; attempt %s", attempt + 1)
            errors.append(f"Attempt {attempt + 1} returned non-dict payload")
        except Exception as e:
            logger.warning("[ACCUMULATE] Local attempt %s failed: %s", attempt + 1, e)
            errors.append(f"Attempt {attempt + 1} failed: {e}")

        _sleep_backoff(attempt, backoff_base)

    logger.error("[ACCUMULATE] Local attempts exhausted - using fallback.")
    return {
        "decision": "continue_accumulating",
        "Completed_segment": "",
        "Incomplete_segment": input_text,
        "detected_threads": [],
        "_errors": errors or ["Local accumulation attempts exhausted"],
    }, None


def accumulate_text_json_local_indexed(
    numbered_input: str,
    providers: Optional[List[Dict[str, Any]]] = None,
    retries: int = 3,
    backoff_base: float = 1.5,
) -> Tuple[Dict[str, Any], Optional[str]]:
    """Local accumulate using the boundary-index prompt (no transcript echo).

    ``numbered_input`` is the batch's utterances pre-numbered as "[i] text"
    lines. The model returns ``{decision, completed_through_index,
    detected_threads}`` — a few dozen chars regardless of input size — instead
    of echoing the transcript back. This avoids the output-scales-with-input
    truncation that silently dropped every batch on local models (both qwen3.6
    and gemma4 failed identically on the old echo prompt; see
    docs/plans/2026-06-05-stt-llm-pipeline-landing.md and the
    .tmp_accumulate_experiment matrix).

    Returns ``(result_dict, backend_label)``. On exhaustion returns a
    conservative continue_accumulating fallback (index -1) so the buffer keeps
    growing until a force-flush rather than dropping content.
    """
    if providers is None:
        providers = get_default_providers()
    prompt_metadata = get_transcript_prompt_metadata(PROMPT_ID_ACCUMULATE_TRANSCRIPT_SEGMENT_LOCAL)
    system_prompt = get_transcript_prompt_text(PROMPT_ID_ACCUMULATE_TRANSCRIPT_SEGMENT_LOCAL)

    errors: List[str] = []
    for attempt in range(retries):
        try:
            parsed, provider_result = _call_local_chat_json_with_fallback(
                prompt=numbered_input,
                system_prompt=system_prompt,
                providers=providers,
                temperature=float(prompt_metadata.get("temperature", 0.65)),
                max_tokens=int(prompt_metadata.get("max_tokens", 4000)),
            )
            if isinstance(parsed, dict):
                if errors:
                    parsed["_warnings"] = errors
                backend_label = provider_result.backend_label() if provider_result else None
                return parsed, backend_label
            logger.warning("[ACCUMULATE-IDX] Local response was not a dict; attempt %s", attempt + 1)
            errors.append(f"Attempt {attempt + 1} returned non-dict payload")
        except Exception as e:
            logger.warning("[ACCUMULATE-IDX] Local attempt %s failed: %s", attempt + 1, e)
            errors.append(f"Attempt {attempt + 1} failed: {e}")

        _sleep_backoff(attempt, backoff_base)

    logger.error("[ACCUMULATE-IDX] Local attempts exhausted - using fallback (continue).")
    return {
        "decision": "continue_accumulating",
        "completed_through_index": -1,
        "detected_threads": [],
        "_errors": errors or ["Local indexed accumulation attempts exhausted"],
    }, None


# ---------------------------------------------------------------------------
# Dispatchers (online → local fallback)
# ---------------------------------------------------------------------------
def generate_lct_json(
    transcript: str,
    llm_config: Optional[Dict[str, Any]] = None,
    providers: Optional[List[Dict[str, Any]]] = None,
    retries: int = 5,
    backoff_base: float = 1.5,
    status_messages: Optional[List[str]] = None,
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """
    Generate LCT JSON nodes from transcript.

    Returns:
        Tuple of (nodes_list, backend_label) where backend_label is like 'local_qwen3-32b'
        or 'online_gemini-2.5-flash'
    """
    config = _resolve_llm_config(llm_config)
    if config.get("mode") == "online":
        gemini_key, key_source = _resolve_gemini_api_key()
        gemini_model = _resolve_online_gemini_model(config)
        if gemini_key:
            gemini_result = generate_lct_json_gemini(
                transcript,
                model_name=gemini_model,
                api_key=gemini_key,
                key_source=key_source,
                retries=retries,
                backoff_base=backoff_base,
                status_messages=status_messages,
            )
            if gemini_result:
                return gemini_result, f"online_{gemini_model}"
            fallback_message = "Gemini produced no graph output; falling back to local LLM."
            logger.warning("[LCT JSON] %s", fallback_message)
            if status_messages is not None:
                status_messages.append(fallback_message)
        else:
            fallback_message = _missing_gemini_key_message()
            logger.warning("[LCT JSON] %s", fallback_message)
            if status_messages is not None:
                status_messages.append(fallback_message)

    return generate_lct_json_local(
        transcript,
        llm_config=config,
        providers=providers,
        retries=retries,
        backoff_base=backoff_base,
    )


def accumulate_text_json(
    input_text: str,
    llm_config: Optional[Dict[str, Any]] = None,
    providers: Optional[List[Dict[str, Any]]] = None,
    retries: int = 3,
    backoff_base: float = 1.5,
) -> Tuple[Dict[str, Any], Optional[str]]:
    """
    Accumulate transcript text into segments.

    Returns:
        Tuple of (result_dict, backend_label) where backend_label is like 'local_qwen3-32b'
        or 'online_gemini-2.5-flash'
    """
    config = _resolve_llm_config(llm_config)
    if config.get("mode") == "online":
        gemini_key, key_source = _resolve_gemini_api_key()
        gemini_model = _resolve_online_gemini_model(config)
        if gemini_key:
            result = genai_accumulate_text_json(
                input_text,
                model_name=gemini_model,
                api_key=gemini_key,
                key_source=key_source,
                retries=retries,
                backoff_base=backoff_base,
            )
            return result, f"online_{gemini_model}"
        result, backend_label = accumulate_text_json_local(
            input_text,
            llm_config=config,
            providers=providers,
            retries=retries,
            backoff_base=backoff_base,
        )
        warnings = result.get("_warnings")
        if not isinstance(warnings, list):
            warnings = []
        warnings.append(_missing_gemini_key_message())
        result["_warnings"] = warnings
        return result, backend_label

    return accumulate_text_json_local(
        input_text,
        llm_config=config,
        providers=providers,
        retries=retries,
        backoff_base=backoff_base,
    )
