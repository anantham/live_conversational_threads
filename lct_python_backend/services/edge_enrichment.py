"""ADR-032 Part C+D+E: semantic edge enrichment for a finalized graph.

Runs the ``enrich_semantic_edges`` prompt (F3 — separate from
``refine_conversation_subthreads``) against the consolidated node list
PLUS retrieved IndrasNet context. Produces ONLY edges; no node mutation.

This module is the canonical entry point for the post-flush + import
enrichment pass that ships with ADR-032. The live STT pipeline calls
``run_edge_enrichment`` after hierarchy consolidation has produced the
full 5-tier graph, BEFORE the final persist.

Privacy gate: retrieved items whose source participants have
``external_llm_ok=False`` are filtered out BEFORE they reach the LLM
prompt. IndrasNet's retrieval endpoint doesn't enforce this; we must.

Failure policy (per AGENTS.md): never silently produce zero edges. If
the LLM fails to author edges, log loud + emit observability event but
do NOT block the parent persist. If IndrasNet is unreachable, run the
LLM without retrieved context (banner the user).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from lct_python_backend.services.edge_contract import canonical_relation_type
from lct_python_backend.services.indrasnet_client import (
    IndrasNetError,
    IndrasNetUnavailable,
    retrieval_search,
)
from lct_python_backend.services.transcript.transcript_llm_callers import _resolve_llm_config

logger = logging.getLogger("lct_backend")


# Cap on retrieved items per session — prevents giant context packs
# from blowing the LLM token budget. Per ADR-032 Part J: measure, don't
# presume; tune from telemetry.
MAX_CONTEXT_ITEMS_DEFAULT = 8

# Cap on edges per enrichment pass. The prompt instructs "be sparse";
# this enforces it server-side too.
MAX_EDGES_PER_PASS = 60
MAX_EDGE_EVIDENCE_IDS_PER_NODE = 12

EDGE_EVIDENCE_INSTRUCTION = """
EDGE EVIDENCE CONTRACT:
- Every node may list source_turn_ids. For each edge, return
  supporting_utterance_ids containing the smallest exact set of source_turn_ids
  from either endpoint that makes the relationship auditable.
- Never invent a source turn id. Return an empty list only when neither endpoint
  lists source_turn_ids.
""".strip()


# ---------------------------------------------------------------------------
# Context gather
# ---------------------------------------------------------------------------


async def gather_context(
    *,
    query: str,
    participant_external_llm_ok_set: Optional[set] = None,
    top_k: int = MAX_CONTEXT_ITEMS_DEFAULT,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Fetch + privacy-filter context items from IndrasNet retrieval.

    Args:
        query: free-text query for retrieval — typically conversation
            theme summary + recent transcript chunk.
        participant_external_llm_ok_set: set of participant ids/names
            that ARE allowed to be shipped to remote LLMs. Items whose
            source participants are NOT in this set get dropped.
            ``None`` means "no privacy filter applied" (caller takes
            responsibility — typically only valid in test contexts).
        top_k: max items to request.

    Returns:
        ``(filtered_items, telemetry)`` — items the prompt can use,
        and a telemetry dict for logging + pipeline_artifacts.
    """
    telemetry: Dict[str, Any] = {
        "indrasnet_called": False,
        "raw_items": 0,
        "filtered_items": 0,
        "ms": 0,
        "error": None,
    }
    started_at = time.perf_counter()

    try:
        body = await retrieval_search(query=query, top_k=top_k, rerank=True)
        telemetry["indrasnet_called"] = True
    except IndrasNetUnavailable as exc:
        telemetry["error"] = f"unavailable: {exc}"
        telemetry["ms"] = round((time.perf_counter() - started_at) * 1000.0, 1)
        logger.warning(
            "[edge_enrichment] IndrasNet retrieval unavailable; running enrichment WITHOUT context: %s",
            exc,
        )
        return [], telemetry
    except IndrasNetError as exc:
        telemetry["error"] = f"{type(exc).__name__}: {exc}"
        telemetry["ms"] = round((time.perf_counter() - started_at) * 1000.0, 1)
        logger.error(
            "[edge_enrichment] IndrasNet retrieval errored; running enrichment WITHOUT context: %s",
            exc,
        )
        return [], telemetry

    raw_items = body.get("items") or body.get("results") or []
    telemetry["raw_items"] = len(raw_items)

    filtered: List[Dict[str, Any]] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        if participant_external_llm_ok_set is not None:
            # Drop items whose source participants are NOT in the allow-set.
            item_participants = _extract_item_participants(item)
            if item_participants and not item_participants.issubset(
                participant_external_llm_ok_set
            ):
                # At least one participant on this item is NOT marked
                # external_llm_ok=True. Drop.
                continue
        filtered.append(item)

    telemetry["filtered_items"] = len(filtered)
    telemetry["ms"] = round((time.perf_counter() - started_at) * 1000.0, 1)
    logger.info(
        "[edge_enrichment] retrieval: %d raw -> %d after privacy filter (ms=%.1f)",
        telemetry["raw_items"],
        telemetry["filtered_items"],
        telemetry["ms"],
    )
    return filtered, telemetry


def _extract_item_participants(item: Dict[str, Any]) -> set:
    """Pull participant identifiers out of a retrieval item, normalized.

    IndrasNet retrieval items vary in shape — some have ``participants:
    [...]``, some have ``contact_ids: [...]``, some have neither (notes
    not tied to a contact). Return the union as a set of strings; empty
    set means "no contact attribution — assume safe to use".
    """
    out: set = set()
    for key in ("participants", "contact_ids", "speakers"):
        raw = item.get(key)
        if isinstance(raw, list):
            for entry in raw:
                if isinstance(entry, str):
                    out.add(entry)
                elif isinstance(entry, dict):
                    pid = entry.get("contact_id") or entry.get("id") or entry.get("name")
                    if pid:
                        out.add(str(pid))
    return out


# ---------------------------------------------------------------------------
# LLM call
# ---------------------------------------------------------------------------


def _format_context_pack(items: List[Dict[str, Any]]) -> str:
    """Render retrieved items as a compact text block for the prompt.

    Keep this lean — the LLM has the full conversation as primary input;
    context is supplementary. Each item formatted as:

        [N] <title or first 60 chars of text>
           why_relevant: <reranker explanation if present>
           <body excerpt, capped at 240 chars>
    """
    if not items:
        return ""
    lines = ["RETRIEVED CONTEXT (use to spot cross-references and resolve in-group jargon):"]
    for idx, item in enumerate(items, start=1):
        title = (
            item.get("title")
            or item.get("source_identifier")
            or (item.get("text") or "")[:60]
            or "(untitled)"
        )
        why = item.get("why_relevant") or item.get("reason") or ""
        body = item.get("text") or item.get("content") or item.get("summary") or ""
        body_trim = (body[:240] + "...") if len(body) > 240 else body
        lines.append(f"[{idx}] {title}")
        if why:
            lines.append(f"    why_relevant: {why}")
        if body_trim:
            lines.append(f"    {body_trim}")
    return "\n".join(lines)


def _format_node_list(nodes: List[Dict[str, Any]]) -> str:
    """Render the full node list as the prompt's primary input.

    Compact form: each node one line with id, semantic_level, node_name,
    and a short summary. The LLM uses the id values verbatim when
    authoring edges.
    """
    lines = ["NODES (use id values verbatim when authoring edges):"]
    for n in nodes:
        if not isinstance(n, dict):
            continue
        nid = n.get("id") or n.get("node_id") or ""
        level = n.get("semantic_level") or n.get("level") or 1
        name = (n.get("node_name") or "").strip() or "(unnamed)"
        summary = (n.get("summary") or "").strip().replace("\n", " ")
        if len(summary) > 200:
            summary = summary[:200] + "..."
        lines.append(f"- [{nid}] L{level} {name}")
        if summary:
            lines.append(f"  summary: {summary}")
        evidence_ids = _node_utterance_ids(n)
        if evidence_ids:
            shown_ids = _prompt_visible_utterance_ids(n)
            suffix = (
                f" (+{len(evidence_ids) - len(shown_ids)} more; prefer a lower-tier endpoint)"
                if len(evidence_ids) > len(shown_ids)
                else ""
            )
            lines.append(f"  source_turn_ids: {', '.join(shown_ids)}{suffix}")
    return "\n".join(lines)


def _node_utterance_ids(node: Any) -> List[str]:
    if not isinstance(node, dict):
        return []
    source_ref = node.get("source_ref") if isinstance(node.get("source_ref"), dict) else {}
    ordered = [
        *(node.get("utterance_ids") if isinstance(node.get("utterance_ids"), list) else []),
        *(source_ref.get("utterance_ids") if isinstance(source_ref.get("utterance_ids"), list) else []),
    ]
    seen: set[str] = set()
    result: List[str] = []
    for value in ordered:
        identifier = str(value or "").strip()
        if identifier and identifier not in seen:
            seen.add(identifier)
            result.append(identifier)
    return result


def _prompt_visible_utterance_ids(node: Any) -> List[str]:
    """Return exactly the evidence IDs disclosed to the edge-authoring model."""
    return _node_utterance_ids(node)[:MAX_EDGE_EVIDENCE_IDS_PER_NODE]


async def _call_enrich_llm(
    *,
    nodes: List[Dict[str, Any]],
    context_items: List[Dict[str, Any]],
    llm_config: Optional[Dict[str, Any]] = None,
    providers: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Run the ``enrich_semantic_edges`` prompt. Returns (edges, telemetry).

    Edge shape (per prompt contract):
        {from_node_id, to_node_id, relation_type, explanation}
    """
    telemetry: Dict[str, Any] = {
        "ms": 0,
        "input_tokens": None,
        "output_tokens": None,
        "raw_edges": 0,
        "kept_edges": 0,
        "model": None,
        "error": None,
    }
    started_at = time.perf_counter()

    try:
        from lct_python_backend.services.prompt_manager import get_prompt_manager
        spec = get_prompt_manager().get_prompt("enrich_semantic_edges")
    except Exception as exc:  # noqa: BLE001
        telemetry["error"] = f"prompt_load: {exc}"
        logger.error("[edge_enrichment] failed to load enrich_semantic_edges prompt: %s", exc)
        return [], telemetry

    system_prompt = f"{spec.get('template') or ''}\n\n{EDGE_EVIDENCE_INSTRUCTION}"
    user_input = _format_node_list(nodes)
    context_block = _format_context_pack(context_items)
    if context_block:
        user_input = f"{user_input}\n\n{context_block}"

    config = _resolve_llm_config(llm_config)
    config = dict(config)
    # Prefer the prompt's pinned model when callers don't override.
    if spec.get("model"):
        config["chat_model"] = spec["model"]
    temperature = float(spec.get("temperature", config.get("temperature", 0.4)))
    max_tokens = int(spec.get("max_tokens", config.get("max_tokens", 6000)))

    try:
        from lct_python_backend.services.transcript.transcript_llm_callers import (
            _call_local_chat_json_with_fallback,
            get_default_providers,
        )
        # _call_local_chat_json_with_fallback returns (parsed_json, provider_result).
        # We pass providers explicitly (live STT runtime config) or fall back to defaults.
        result = await asyncio.to_thread(
            _call_local_chat_json_with_fallback,
            prompt=user_input,
            system_prompt=system_prompt,
            providers=providers if providers is not None else get_default_providers(),
            temperature=temperature,
            max_tokens=max_tokens,
        )
    except Exception as exc:  # noqa: BLE001
        telemetry["error"] = f"llm_call: {exc}"
        telemetry["ms"] = round((time.perf_counter() - started_at) * 1000.0, 1)
        logger.exception("[edge_enrichment] LLM call failed: %s", exc)
        return [], telemetry

    parsed: Any = None
    provider_result = None
    if isinstance(result, tuple) and len(result) >= 2:
        parsed = result[0]
        provider_result = result[1]
    elif isinstance(result, tuple) and len(result) == 1:
        parsed = result[0]
    else:
        parsed = result

    backend = None
    if provider_result is not None:
        try:
            backend = provider_result.backend_label()
        except Exception:  # noqa: BLE001
            backend = None
        try:
            telemetry["input_tokens"] = getattr(provider_result, "input_tokens", None)
            telemetry["output_tokens"] = getattr(provider_result, "output_tokens", None)
        except Exception:  # noqa: BLE001
            pass

    telemetry["model"] = backend or config.get("chat_model")
    telemetry["ms"] = round((time.perf_counter() - started_at) * 1000.0, 1)

    # parsed should be a dict like {"edges": [...]}. _parse_edges_response is
    # tolerant: it'll accept dict-with-edges, bare list, or even a JSON string.
    if isinstance(parsed, (dict, list)):
        raw_for_parser = json.dumps(parsed)
    else:
        raw_for_parser = str(parsed or "")

    payload_shape_valid = (
        isinstance(parsed, list)
        or (isinstance(parsed, dict) and isinstance(parsed.get("edges"), list))
    )
    telemetry["parse_status"] = "valid" if payload_shape_valid else "invalid"
    if not payload_shape_valid:
        telemetry["error"] = telemetry.get("error") or "invalid_edge_payload"

    edges = _parse_edges_response(
        raw_for_parser,
        nodes=nodes,
    )
    telemetry["raw_edges"] = len(edges)
    if len(edges) > MAX_EDGES_PER_PASS:
        edges = edges[:MAX_EDGES_PER_PASS]
    telemetry["kept_edges"] = len(edges)

    logger.info(
        "[edge_enrichment] LLM emitted %d edges (kept %d, model=%s ms=%.1f)",
        telemetry["raw_edges"],
        telemetry["kept_edges"],
        telemetry["model"],
        telemetry["ms"],
    )
    return edges, telemetry


def _parse_edges_response(
    raw_text: str,
    *,
    nodes: Optional[List[Dict[str, Any]]] = None,
    valid_node_ids: Optional[set] = None,
) -> List[Dict[str, Any]]:
    """Tolerant parser for the LLM output. Accepts {"edges": [...]} or a
    bare list. Drops edges that reference unknown node ids."""
    if not raw_text:
        return []
    try:
        parsed = json.loads(raw_text)
    except (TypeError, ValueError):
        # The LLM may wrap JSON in markdown or stray prose; try to recover.
        start = raw_text.find("{")
        end = raw_text.rfind("}")
        if start >= 0 and end > start:
            try:
                parsed = json.loads(raw_text[start : end + 1])
            except (TypeError, ValueError):
                return []
        else:
            return []

    if isinstance(parsed, dict) and "edges" in parsed:
        candidates = parsed["edges"]
    elif isinstance(parsed, list):
        candidates = parsed
    else:
        return []

    if not isinstance(candidates, list):
        return []

    node_by_id = {
        str(node.get("id") or "").strip(): node
        for node in (nodes or [])
        if isinstance(node, dict) and str(node.get("id") or "").strip()
    }
    allowed_node_ids = set(valid_node_ids or node_by_id)
    out: List[Dict[str, Any]] = []
    by_key: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    for edge in candidates:
        if not isinstance(edge, dict):
            continue
        frm = str(edge.get("from_node_id") or edge.get("from") or "").strip()
        to = str(edge.get("to_node_id") or edge.get("to") or "").strip()
        rel = canonical_relation_type(edge.get("relation_type") or edge.get("type"))
        if not frm or not to or not rel:
            continue
        if frm == to:
            continue
        if frm not in allowed_node_ids or to not in allowed_node_ids:
            # Hallucinated reference; drop.
            continue
        endpoint_evidence = [
            *_prompt_visible_utterance_ids(node_by_id.get(frm)),
            *_prompt_visible_utterance_ids(node_by_id.get(to)),
        ]
        allowed_evidence = set(endpoint_evidence)
        authored_evidence = edge.get("supporting_utterance_ids")
        supporting_ids = []
        if isinstance(authored_evidence, list):
            supporting_ids = [
                str(value).strip()
                for value in authored_evidence
                if str(value).strip() in allowed_evidence
            ]
        if not supporting_ids:
            source_ids = _node_utterance_ids(node_by_id.get(frm))
            # A short grounded leaf can safely fall back to all its source
            # turns. A broad aggregate cannot: copying dozens of turns would
            # manufacture the appearance of edge-specific evidence.
            if len(source_ids) <= MAX_EDGE_EVIDENCE_IDS_PER_NODE:
                supporting_ids = source_ids
        supporting_ids = list(dict.fromkeys(supporting_ids))
        try:
            confidence = float(edge.get("confidence")) if edge.get("confidence") is not None else None
        except (TypeError, ValueError):
            confidence = None
        key = (frm, to, rel)
        existing = by_key.get(key)
        if existing is not None:
            known_ids = set(existing["supporting_utterance_ids"])
            for identifier in supporting_ids:
                if identifier not in known_ids:
                    known_ids.add(identifier)
                    existing["supporting_utterance_ids"].append(identifier)
            explanation = str(edge.get("explanation") or "").strip()
            if not existing["explanation"] and explanation:
                existing["explanation"] = explanation
            if existing["confidence"] is None and confidence is not None:
                existing["confidence"] = confidence
            continue
        normalized = {
            "from_node_id": frm,
            "to_node_id": to,
            "relation_type": rel,
            "explanation": str(edge.get("explanation") or "").strip(),
            "confidence": confidence,
            "supporting_utterance_ids": supporting_ids,
        }
        out.append(normalized)
        by_key[key] = normalized
    return out


def merge_semantic_edges_into_nodes(
    nodes: List[Dict[str, Any]],
    edges: List[Dict[str, Any]],
) -> None:
    """Attach directed edges to the target node's incoming relation shape."""
    by_id = {
        str(node.get("id") or "").strip(): node
        for node in nodes
        if isinstance(node, dict) and str(node.get("id") or "").strip()
    }
    for edge in edges:
        source = by_id.get(str(edge.get("from_node_id") or "").strip())
        target = by_id.get(str(edge.get("to_node_id") or "").strip())
        relation = canonical_relation_type(edge.get("relation_type"))
        source_name = str((source or {}).get("node_name") or "").strip()
        if source is None or target is None or not relation or not source_name:
            continue
        relations = target.setdefault("edge_relations", [])
        key = (source_name, relation)
        existing = next(
            (
                item for item in relations
                if isinstance(item, dict)
                and (
                    str(item.get("related_node") or "").strip(),
                    canonical_relation_type(item.get("relation_type")),
                ) == key
            ),
            None,
        )
        supporting_ids = [str(value) for value in (edge.get("supporting_utterance_ids") or [])]
        if existing is not None:
            existing["supporting_utterance_ids"] = list(dict.fromkeys([
                *(existing.get("supporting_utterance_ids") or []),
                *supporting_ids,
            ]))
            continue
        relations.append({
            "related_node": source_name,
            "relation_type": relation,
            "relation_text": str(edge.get("explanation") or "").strip() or relation,
            "supporting_utterance_ids": list(dict.fromkeys(supporting_ids)),
        })


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def run_edge_enrichment(
    *,
    nodes: List[Dict[str, Any]],
    query_summary: str,
    participant_external_llm_ok_set: Optional[set] = None,
    llm_config: Optional[Dict[str, Any]] = None,
    providers: Optional[List[Dict[str, Any]]] = None,
    skip_context_lookup: bool = False,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """ADR-032 Part D entry point.

    Args:
        nodes: full node list AFTER consolidation (chunks+ideas+topics+themes+arcs).
        query_summary: free-text query for IndrasNet retrieval. Usually a
            blend of conversation_title + executive_summary + recent transcript.
        participant_external_llm_ok_set: privacy gate. See ``gather_context``.
        llm_config: optional override for LLM provider config.
        providers: optional provider list override.

    Returns:
        ``(edges, telemetry)``. Edges are ready to feed to
        ``graph_persistence`` as Relationship rows. Telemetry captures
        latency + token costs for ADR-032 Part J observability.
    """
    overall: Dict[str, Any] = {
        "started_at_ms": round(time.time() * 1000),
        "context_telemetry": None,
        "llm_telemetry": None,
        "total_ms": 0,
        "edges_emitted": 0,
    }
    t0 = time.perf_counter()

    if skip_context_lookup:
        context_items = []
        context_telemetry = {
            "indrasnet_called": False,
            "raw_items": 0,
            "filtered_items": 0,
            "ms": 0,
            "error": "skipped",
            "skipped_reason": "owner_local_raw_import",
        }
    else:
        context_items, context_telemetry = await gather_context(
            query=query_summary,
            participant_external_llm_ok_set=participant_external_llm_ok_set,
        )
    overall["context_telemetry"] = context_telemetry

    edges, llm_telemetry = await _call_enrich_llm(
        nodes=nodes,
        context_items=context_items,
        llm_config=llm_config,
        providers=providers,
    )
    overall["llm_telemetry"] = llm_telemetry
    overall["edges_emitted"] = len(edges)
    overall["total_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)

    logger.info(
        "[edge_enrichment] DONE: edges=%d total_ms=%.1f context_ms=%.1f llm_ms=%.1f",
        overall["edges_emitted"],
        overall["total_ms"],
        context_telemetry.get("ms", 0),
        llm_telemetry.get("ms", 0),
    )

    return edges, overall
