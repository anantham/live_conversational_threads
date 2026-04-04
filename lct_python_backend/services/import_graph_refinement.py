"""Second-pass import graph refinement for denser subthreads/tangents."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, Dict, Iterable, List, Mapping, Optional

from google import genai
from google.genai import types

from lct_python_backend.services.local_llm_client import _preview_text
from lct_python_backend.services.transcript_llm_callers import (
    _call_local_chat_json_with_fallback,
    _missing_gemini_key_message,
    _resolve_gemini_api_key,
    _resolve_llm_config,
    _resolve_online_gemini_model,
)
from lct_python_backend.services.transcript_normalizer import _normalize_generated_output
from lct_python_backend.services.transcript_prompts import REFINE_LCT_SUBTHREAD_PROMPT

logger = logging.getLogger("lct_backend")

IMPORT_GRAPH_REFINEMENT_MIN_UTTERANCES = int(os.getenv("IMPORT_GRAPH_REFINEMENT_MIN_UTTERANCES", "18"))
IMPORT_GRAPH_REFINEMENT_MIN_CHARS = int(os.getenv("IMPORT_GRAPH_REFINEMENT_MIN_CHARS", "1400"))
IMPORT_GRAPH_REFINEMENT_MIN_NODES = int(os.getenv("IMPORT_GRAPH_REFINEMENT_MIN_NODES", "4"))
IMPORT_GRAPH_REFINEMENT_MAX_TRANSCRIPT_CHARS = int(os.getenv("IMPORT_GRAPH_REFINEMENT_MAX_TRANSCRIPT_CHARS", "32000"))
IMPORT_GRAPH_REFINEMENT_MAX_NODES = int(os.getenv("IMPORT_GRAPH_REFINEMENT_MAX_NODES", "40"))


def _clean_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _format_utterance_lines(utterances: Iterable[Mapping[str, Any]]) -> str:
    lines: List[str] = []
    for utterance in utterances or []:
        if not isinstance(utterance, Mapping):
            continue
        text = _clean_str(utterance.get("text"))
        if not text:
            continue
        speaker = _clean_str(utterance.get("speaker_id")) or "SPEAKER_00"
        start = utterance.get("timestamp_start")
        end = utterance.get("timestamp_end")
        if isinstance(start, (int, float)) or isinstance(end, (int, float)):
            start_label = f"{float(start):.2f}" if isinstance(start, (int, float)) else "?"
            end_label = f"{float(end):.2f}" if isinstance(end, (int, float)) else "?"
            lines.append(f"[{start_label}-{end_label}] {speaker}: {text}")
        else:
            lines.append(f"{speaker}: {text}")
    return "\n".join(lines)


def _thread_metrics(nodes: Iterable[Mapping[str, Any]]) -> Dict[str, int]:
    node_list = [node for node in nodes or [] if isinstance(node, Mapping)]
    thread_ids = {
        _clean_str(node.get("thread_id"))
        for node in node_list
        if _clean_str(node.get("thread_id"))
    }
    edge_count = 0
    tangent_count = 0
    return_count = 0
    contextual_node_count = 0
    linked_node_count = 0
    contextual_entry_count = 0
    for node in node_list:
        thread_state = _clean_str(node.get("thread_state")).lower()
        if thread_state == "return_to_thread":
            return_count += 1
        contextual_relation = node.get("contextual_relation") or {}
        linked_nodes = node.get("linked_nodes") or []
        if isinstance(contextual_relation, Mapping) and contextual_relation:
            contextual_node_count += 1
            contextual_entry_count += len([key for key in contextual_relation.keys() if _clean_str(key)])
        if isinstance(linked_nodes, list) and linked_nodes:
            linked_node_count += 1
        for relation in node.get("edge_relations") or []:
            if not isinstance(relation, Mapping):
                continue
            edge_count += 1
            relation_type = _clean_str(relation.get("relation_type")).lower()
            if relation_type == "tangent":
                tangent_count += 1
            elif relation_type == "return_to_thread":
                return_count += 1
    return {
        "thread_count": len(thread_ids),
        "edge_count": edge_count,
        "tangent_count": tangent_count,
        "return_count": return_count,
        "contextual_node_count": contextual_node_count,
        "linked_node_count": linked_node_count,
        "contextual_entry_count": contextual_entry_count,
    }


def _has_duplicate_node_names(nodes: Iterable[Mapping[str, Any]]) -> bool:
    seen = set()
    for node in nodes or []:
        if not isinstance(node, Mapping):
            continue
        node_name = _clean_str(node.get("node_name"))
        if not node_name:
            continue
        if node_name in seen:
            return True
        seen.add(node_name)
    return False


def _should_refine(
    *,
    transcript_text: str,
    utterances: List[Dict[str, Any]],
    existing_nodes: List[Dict[str, Any]],
) -> tuple[bool, str]:
    if len(existing_nodes) < IMPORT_GRAPH_REFINEMENT_MIN_NODES:
        return False, "node_count_below_threshold"
    if len(utterances) < IMPORT_GRAPH_REFINEMENT_MIN_UTTERANCES:
        return False, "utterance_count_below_threshold"
    if len(transcript_text) < IMPORT_GRAPH_REFINEMENT_MIN_CHARS:
        return False, "transcript_chars_below_threshold"
    if len(transcript_text) > IMPORT_GRAPH_REFINEMENT_MAX_TRANSCRIPT_CHARS:
        return False, "transcript_too_large_for_refinement"
    return True, "eligible"


def _simplify_existing_nodes(existing_nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    simplified: List[Dict[str, Any]] = []
    for node in existing_nodes or []:
        if not isinstance(node, Mapping):
            continue
        simplified.append(
            {
                "node_name": _clean_str(node.get("node_name")),
                "summary": _clean_str(node.get("summary") or node.get("node_text")),
                "source_excerpt": _clean_str(node.get("source_excerpt")),
                "predecessor": _clean_str(node.get("predecessor")) or None,
                "successor": _clean_str(node.get("successor")) or None,
                "thread_id": _clean_str(node.get("thread_id")),
                "thread_state": _clean_str(node.get("thread_state")),
                "contextual_relation": node.get("contextual_relation") if isinstance(node.get("contextual_relation"), Mapping) else {},
                "edge_relations": node.get("edge_relations") if isinstance(node.get("edge_relations"), list) else [],
                "linked_nodes": node.get("linked_nodes") if isinstance(node.get("linked_nodes"), list) else [],
                "speaker_id": _clean_str(node.get("speaker_id")) or None,
            }
        )
    return simplified


def _refinement_semantics_degraded(
    *,
    original_metrics: Dict[str, int],
    refined_metrics: Dict[str, int],
) -> bool:
    original_contextual_nodes = int(original_metrics.get("contextual_node_count") or 0)
    original_edges = int(original_metrics.get("edge_count") or 0)
    original_links = int(original_metrics.get("linked_node_count") or 0)
    refined_contextual_nodes = int(refined_metrics.get("contextual_node_count") or 0)
    refined_edges = int(refined_metrics.get("edge_count") or 0)
    refined_links = int(refined_metrics.get("linked_node_count") or 0)

    if original_contextual_nodes > 0 and refined_contextual_nodes == 0:
        return True
    if original_edges > 0 and refined_edges == 0:
        return True
    if original_links > 0 and refined_links == 0:
        return True
    return False


def _build_refinement_prompt(
    *,
    transcript_text: str,
    utterances: List[Dict[str, Any]],
    existing_nodes: List[Dict[str, Any]],
) -> str:
    utterance_count = len(utterances)
    node_count = len(existing_nodes)
    target_min = min(IMPORT_GRAPH_REFINEMENT_MAX_NODES, max(node_count + 2, utterance_count // 4))
    target_max = min(IMPORT_GRAPH_REFINEMENT_MAX_NODES, max(target_min, utterance_count // 2))
    transcript_evidence = _format_utterance_lines(utterances) or transcript_text
    simplified_nodes = _simplify_existing_nodes(existing_nodes)
    return (
        f"Transcript Evidence:\n{transcript_evidence}\n\n"
        f"Current coarse nodes:\n{json.dumps(simplified_nodes, ensure_ascii=False, indent=2)}\n\n"
        f"Refinement target:\n"
        f"- Current node count: {node_count}\n"
        f"- Preferred refined node count: {target_min} to {target_max}\n"
        f"- Increase granularity only when the transcript clearly supports smaller tangents, returns, meta-conversations, or object-level pivots.\n"
        f"- Keep chronology faithful.\n"
        f"- Preserve high-level coverage, but expose more of the real branching structure.\n"
    )


def _refine_graph_nodes_gemini(
    prompt: str,
    *,
    llm_config: Optional[Dict[str, Any]],
    retries: int = 3,
) -> tuple[List[Dict[str, Any]], Optional[str], Optional[str]]:
    api_key, key_source = _resolve_gemini_api_key()
    if not api_key:
        return [], None, _missing_gemini_key_message()

    model_name = _resolve_online_gemini_model(llm_config)
    client = genai.Client(api_key=api_key)
    config = types.GenerateContentConfig(
        temperature=0.55,
        thinking_config=types.ThinkingConfig(thinking_budget=0),
        response_mime_type="application/json",
        system_instruction=[types.Part.from_text(text=REFINE_LCT_SUBTHREAD_PROMPT)],
    )

    last_error: Optional[str] = None
    for attempt in range(retries):
        full_response = ""
        try:
            for chunk in client.models.generate_content_stream(
                model=model_name,
                contents=[types.Content(role="user", parts=[types.Part.from_text(text=prompt)])],
                config=config,
            ):
                if hasattr(chunk, "text"):
                    full_response += str(chunk.text)

            parsed = json.loads(full_response)
            normalized = _normalize_generated_output(parsed)
            if normalized:
                return normalized, f"online_{model_name}", None
            last_error = f"Gemini refinement returned no normalized nodes (attempt {attempt + 1})."
            logger.warning("[GRAPH REFINE] %s", last_error)
        except Exception as exc:  # noqa: BLE001
            last_error = f"Gemini refinement failed on attempt {attempt + 1}: {exc}"
            logger.warning("[GRAPH REFINE] %s", last_error)
            logger.debug("[GRAPH REFINE] Raw Gemini response preview: %s", _preview_text(full_response))
        time.sleep(1.5 ** attempt)

    return [], None, last_error or "Gemini refinement attempts exhausted."


def _refine_graph_nodes_local(
    prompt: str,
    *,
    providers: Optional[List[Dict[str, Any]]],
) -> tuple[List[Dict[str, Any]], Optional[str], Optional[str]]:
    try:
        parsed, provider_result = _call_local_chat_json_with_fallback(
            prompt=prompt,
            system_prompt=REFINE_LCT_SUBTHREAD_PROMPT,
            providers=providers,
            temperature=0.55,
            max_tokens=5000,
        )
        normalized = _normalize_generated_output(parsed)
        if normalized:
            return normalized, provider_result.backend_label() if provider_result else None, None
        return [], None, "Local refinement returned no normalized nodes."
    except Exception as exc:  # noqa: BLE001
        return [], None, f"Local refinement failed: {exc}"


async def refine_import_graph_nodes(
    *,
    transcript_text: str,
    utterances: Optional[List[Dict[str, Any]]] = None,
    existing_nodes: Optional[List[Dict[str, Any]]] = None,
    llm_config: Optional[Dict[str, Any]] = None,
    providers: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    utterance_list = list(utterances or [])
    node_list = list(existing_nodes or [])
    normalized_text = _clean_str(transcript_text)
    should_refine, reason = _should_refine(
        transcript_text=normalized_text,
        utterances=utterance_list,
        existing_nodes=node_list,
    )
    if not should_refine:
        return {
            "applied": False,
            "reason": reason,
            "original_node_count": len(node_list),
        }

    config = _resolve_llm_config(llm_config)
    prompt = _build_refinement_prompt(
        transcript_text=normalized_text,
        utterances=utterance_list,
        existing_nodes=node_list,
    )
    original_metrics = _thread_metrics(node_list)

    def _run_refinement() -> tuple[List[Dict[str, Any]], Optional[str], Optional[str]]:
        if config.get("mode") == "online":
            refined_nodes, backend_label, error = _refine_graph_nodes_gemini(
                prompt,
                llm_config=config,
            )
            if refined_nodes:
                return refined_nodes, backend_label, None
            local_nodes, local_backend, local_error = _refine_graph_nodes_local(
                prompt,
                providers=providers,
            )
            if local_nodes:
                return local_nodes, local_backend, None
            fallback_error = error or local_error or "Refinement returned no nodes."
            return [], None, fallback_error

        return _refine_graph_nodes_local(prompt, providers=providers)

    started_at = time.perf_counter()
    refined_nodes, backend_label, error = await asyncio.to_thread(_run_refinement)
    refinement_ms = round(max(0.0, (time.perf_counter() - started_at) * 1000.0), 2)

    if error:
        return {
            "applied": False,
            "reason": "refinement_failed",
            "error": error,
            "backend": backend_label,
            "refinement_ms": refinement_ms,
            "original_node_count": len(node_list),
        }

    if _has_duplicate_node_names(refined_nodes):
        return {
            "applied": False,
            "reason": "duplicate_node_names",
            "backend": backend_label,
            "refinement_ms": refinement_ms,
            "original_node_count": len(node_list),
        }

    if len(refined_nodes) > IMPORT_GRAPH_REFINEMENT_MAX_NODES:
        return {
            "applied": False,
            "reason": "refined_node_count_too_large",
            "backend": backend_label,
            "refinement_ms": refinement_ms,
            "original_node_count": len(node_list),
            "refined_node_count": len(refined_nodes),
        }

    refined_metrics = _thread_metrics(refined_nodes)
    if _refinement_semantics_degraded(
        original_metrics=original_metrics,
        refined_metrics=refined_metrics,
    ):
        return {
            "applied": False,
            "reason": "refinement_semantics_degraded",
            "backend": backend_label,
            "refinement_ms": refinement_ms,
            "original_node_count": len(node_list),
            "refined_node_count": len(refined_nodes),
            "original_metrics": original_metrics,
            "refined_metrics": refined_metrics,
        }

    richer = (
        len(refined_nodes) > len(node_list)
        or refined_metrics["edge_count"] > original_metrics["edge_count"]
        or refined_metrics["tangent_count"] > original_metrics["tangent_count"]
        or refined_metrics["return_count"] > original_metrics["return_count"]
        or refined_metrics["thread_count"] > original_metrics["thread_count"]
    )
    if not richer:
        return {
            "applied": False,
            "reason": "no_richer_structure_detected",
            "backend": backend_label,
            "refinement_ms": refinement_ms,
            "original_node_count": len(node_list),
            "refined_node_count": len(refined_nodes),
            "original_metrics": original_metrics,
            "refined_metrics": refined_metrics,
        }

    return {
        "applied": True,
        "reason": "refined",
        "backend": backend_label,
        "refinement_ms": refinement_ms,
        "original_node_count": len(node_list),
        "refined_node_count": len(refined_nodes),
        "original_metrics": original_metrics,
        "refined_metrics": refined_metrics,
        "nodes": refined_nodes,
    }
