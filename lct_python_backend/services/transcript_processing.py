import json
import logging
import os
import random
import time
import uuid
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

import httpx
from google import genai
from google.genai import types

from lct_python_backend.services.llm_config import get_env_llm_defaults
from lct_python_backend.services.local_llm_client import extract_json_from_text

logger = logging.getLogger("lct_backend")

GEMINI_MODEL_NAME = os.getenv("ONLINE_LLM_CHAT_MODEL", "gemini-2.5-flash")
TRACE_API_CALLS = os.getenv("TRACE_API_CALLS", "true").strip().lower() in {"1", "true", "yes", "on"}
API_LOG_PREVIEW_CHARS = int(os.getenv("API_LOG_PREVIEW_CHARS", "280"))
_JSON_OBJECT_UNSUPPORTED_BASE_URLS: set[str] = set()
_GEMINI_KEY_ENV_ORDER = ("GOOGLEAI_API_KEY", "GEMINI_API_KEY", "GEMINI_KEY")

GENERATE_LCT_PROMPT = """You are an advanced AI model that structures conversations into strictly JSON-formatted nodes. Each conversational shift should be captured as a new node with defined relationships, with primary emphasis on capturing rich contextual connections that demonstrate thematic coherence, conceptual evolution, and cross-conversational idea building.
**Formatting Rules:**

**Instructions:**

**Handling New JSON Creation**
Extract Key Nodes: Identify all topic shifts in the conversation. Each topic shift forms a new "node", even if the topic was discussed earlier.

**Strictly Generate JSON Output:**
[
  {
    "node_name": "Title of the conversational thread",
    "predecessor": "Previous node name",
    "successor": "Next node name",
    "contextual_relation": {
      "Related Node 1": "Detailed explanation of how this node connects thematically, shows conceptual evolution, and builds upon ideas from the current discussion",
      "Related Node 2": " Another comprehensive explanation that weaves together thematic connections with how concepts have developed",
      "...": "Additional related nodes with their respective explanations can be included as needed"
    },
    "chunk_id": null,  // This field will be **ignored** for now and will be added externally.
    "linked_nodes": [
      "List of all nodes this node is either drawing context from or providing context to"
    ],
    "is_bookmark": true or false,
    ""is_contextual_progress": true or false,
    "summary": "Detailed description of what was discussed in this node.",
    "claims": [                    // NEW-  may be empty
  "Fact-checkable claim made by a speaker in this node",
  "Another claim, if present"]
  }
]
**Enhanced Contextual Relations Approach:**
- In "contextual_relation", provide integrated explanations that naturally weave together:
- How nodes connect thematically (shared concepts, related ideas)
- How concepts have evolved or been refined since previous mentions
- How ideas build upon each other across different conversation segments
- Don't capture direct shifts in conversations as contextual_relation unless there is a relevant contextual relation only then capture it.
- "linked_nodes" must track all nodes this node is either drawing context from or providing context to in a single list.
Create cohesive narratives that explain the full relationship context rather than treating these as separate analytical dimensions.

**Define Structure:**
"predecessor" -> The direct previous node temporally.
"successor" -> The direct next node temporally.
"contextual_relation" -> Use this to explain how past nodes contribute to the current discussion contextually.
• Keys = node names that contribute context.
• Values = a detailed explanation of how the multiple referenced nodes influence the current discussion.
"chunk_id" -> This field will be ignored for now, as it will be added externally by the code.

**Claims Field Detection and Handling**
"claims" must include only explicit, fact-checkable assertions made by a speaker.
A claim is considered fact-checkable if it states something that can be independently verified or falsified using objective data or authoritative sources.
If no valid claims exist in the node, leave "claims": [].
Do not include:
Opinions or subjective statements ("Plaid seems better")
Suggestions, questions, or hypotheticals ("Should we go with Plaid?")
Abstract or untestable beliefs ("I feel Plaid is more modern")

Be strictly conservative:
If a statement feels uncertain, implied, subjective, speculative, or ambiguous, do not include it as a claim.
Only add when there is a clear, confident declaration that something is true or factual, regardless of actual correctness.
Claims may be true or false - this field captures assertions, not verified facts.
Additionally, claims must include enough context to be independently verified:
A valid claim must provide sufficient specificity (e.g., named entities, timeframes, data, measurable outcomes) to be fact-checked without relying on implicit assumptions.
Avoid fragmentary or vague claims that cannot be verified on their own.
Claims should be self-contained, meaning a reviewer unfamiliar with the full transcript should still understand what is being asserted.

Multiple factual claims may be listed when clearly present.

**Handling Updates to Existing JSON**
If an existing JSON structure is provided along with the transcript, modify it as follows and strictly return only the nodes generated for the current input transcript:

- **Continuing a topic**: If the conversation continues an existing discussion, update the "successor" field of the last relevant node.
- **New topic**: If a conversation introduces a new topic, create a new node and properly link it.
- **Revisiting a Bookmark**: If "LLM wish bookmark open [name]" appears, find the existing bookmark node and update its "contextual_relation". Do NOT create a new bookmark when revisited - update the existing one instead.
- **Contextual Relation Updates**: Maintain connections that demonstrate how past discussions influence current ones through integrated thematic, evolutionary, and developmental relationships.

**Chronology, Contextual Referencing and Bookmarking**
If a topic is revisited, create a new node while ensuring proper linking to previous mentions through rich contextual relations. Ensure mutual linking between nodes that provide context to each other through comprehensive relationship explanations.

Each node must include both "predecessor" and "successor" fields to maintain chronological flow, maintaining the flow of the conversation irrespective of how related the topics are and strictly based on temporal relationship.

**Conversational Threads nodes("is_bookmark": false):**
- Every topic shift must be captured as a new node.
- "contextual_relation" must provide integrated explanations of how previous discussions contribute to the current conversation through thematic connections, conceptual evolution, and idea building.
- For non bookmark nodes, always set "is_bookmark": false.
**Handling Revisited Topics**
If a conversation returns to a previously discussed topic, create a new node and ensure "contextual_relation" provides comprehensive explanations of how past discussions relate to current context.

**Bookmark nodes ("is_bookmark": true) must:**
- A bookmark node must be created when "LLM wish bookmark create" appears, capturing the contextually relevant topic.
- Do not create bookmark node unless "LLM wish bookmark create" is mentioned.
- "contextual_relation" must reference nodes with integrated explanations of relationships, ensuring contextual continuity.
- The summary should clearly describe the reason for creating the bookmark and what it aims to track.
- If "LLM wish bookmark open" appears, do not create a new bookmark - update the existing one.
- For bookmark nodes, always set "is_bookmark": true.

**Contextual Progress Capture ("is_contextual_progress": true):**
- Only If "LLM wish capture contextual progress" appears, update the existing node (either "conversational_thread" or "bookmark") to include:
o "is_contextual_progress": true
- Contextual progress capture is used to capture a potential insight that might be present in that conversational node.
- It represents part of the conversation that could potentially be an insight that could be useful. These "potential insights" are the directions provided by humans that can later be taken by AI, which then uses this to generate formalisms.
- Do not create a new node for contextual progress capture. Instead, apply the flag to the relevant existing node where the potential insight was introduced or referenced.
- **Contextual Relation & Linked Nodes Updates:**
- "contextual_relation" must provide comprehensive, integrated explanations that demonstrate the full scope of how nodes relate through thematic coherence, conceptual development, and cross-conversational idea building as unified relationship narratives.
- Don't capture direct shifts in conversations as contextual_relation unless there is a relevant contextual relation only then capture it.
- "linked_nodes" must include all references in a single list, capturing all nodes this node draws from or informs.
- The structure of "predecessor", "successor", and "contextual_relation" must ensure logical and chronological consistency between past and present discussions.
"""

ACCUMULATE_SYSTEM_PROMPT = """You are an expert conversation analyst and advanced AI reasoning assistant. I will provide you with a block of accumulated transcript text. Your task is to determine whether this text contains at least one complete and self-contained conversational thread, and if so, return all complete threads while leaving any incomplete ones for future accumulation.
Definition:
A conversational thread is a contiguous portion of a conversation that:
- Focuses on a coherent sub-topic or goal,
- Is interpretable on its own, without requiring future context,
- Demonstrates clear semantic structure: an initiation, development, and closure.
The input may contain zero, one, or multiple complete conversational threads. It will appear as unstructured text, with no speaker labels, so you must infer structure using topic continuity, transitions, and semantic signals.
Output Specification:
Return a JSON object containing:
"Decision":
- "continue_accumulating" if no complete thread can be identified.
- "stop_accumulating" if at least one complete and self-contained conversational thread exists.
"Completed_segment":
If "stop_accumulating", return the portion of the input that contains one or more completed conversational threads.
"Incomplete_segment":
The remaining text that is incomplete, off-topic, or still developing.
"detected_threads":
Return a list of short, descriptive names for each complete conversational thread detected in completed_segment.
Evaluation Notes:
- Be conservative: If in doubt, continue accumulating.
- Use semantic structure and topic closure to determine completeness - not superficial transitions.
- It is valid to return more than one thread in completed_segment, but each must be complete and independently meaningful.
- Do not rearrange the order of the text. Preserve original sequencing when splitting.
"""

LOCAL_GENERATE_LCT_PROMPT = """You structure transcript text into conversation graph nodes.
You may reason freely, but your final answer must end with valid JSON.

Return only a JSON array where each item is a node for the current transcript segment.
Do not rewrite previous nodes from Existing JSON.

Each node should include:
- node_name: short descriptive title
- summary: concise node-level summary text (used as node text in UI)
- source_excerpt: direct supporting excerpt from transcript
- predecessor: previous node_name in temporal flow or null
- successor: next node_name in temporal flow or null
- thread_id: stable identifier for the active thread
- thread_state: one of new_thread, continue_thread, return_to_thread
- contextual_relation: object {related_node_name: relation_text}
- edge_relations: array of objects with:
  - related_node: source node_name
  - relation_type: supports | rebuts | clarifies | asks | tangent | return_to_thread
  - relation_text: short explanation for edge hover
- linked_nodes: array of related node names
- claims: array of explicit fact-checkable claims
- is_bookmark: boolean
- is_contextual_progress: boolean

For meandering/interleaving dialogue:
- Start a new thread with thread_state=new_thread.
- Continue same thread with thread_state=continue_thread.
- If discussion returns to an earlier thread, create a new node with thread_state=return_to_thread and reuse that thread_id.
"""


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


def _preview_text(value: Any, limit: int = API_LOG_PREVIEW_CHARS) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return f"{text[:limit]}...<truncated {len(text) - limit} chars>"


def _trace_api_call(message: str, *args: Any) -> None:
    if TRACE_API_CALLS:
        logger.info(message, *args)


_THREAD_STATES = {"new_thread", "continue_thread", "return_to_thread"}
_RELATION_TYPES = {
    "supports",
    "rebuts",
    "clarifies",
    "asks",
    "tangent",
    "return_to_thread",
    "contextual",
    "temporal_next",
}


def _as_clean_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _as_string_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    seen = set()
    output: List[str] = []
    for item in value:
        text = _as_clean_str(item)
        if not text or text in seen:
            continue
        seen.add(text)
        output.append(text)
    return output


def _as_string_map(value: Any) -> Dict[str, str]:
    if not isinstance(value, dict):
        return {}
    normalized: Dict[str, str] = {}
    for key, map_value in value.items():
        normalized_key = _as_clean_str(key)
        normalized_value = _as_clean_str(map_value)
        if normalized_key and normalized_value:
            normalized[normalized_key] = normalized_value
    return normalized


def _slugify(value: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "-" for char in value)
    slug = "-".join(segment for segment in cleaned.split("-") if segment)
    return slug[:48] or "untitled-thread"


def _normalize_thread_state(value: Any, predecessor: Optional[str]) -> str:
    raw = _as_clean_str(value).lower()
    if raw in _THREAD_STATES:
        return raw
    if "return" in raw:
        return "return_to_thread"
    if predecessor:
        return "continue_thread"
    return "new_thread"


def _normalize_relation_type(value: Any) -> str:
    raw = _as_clean_str(value).lower()
    if raw in _RELATION_TYPES:
        return raw
    if "support" in raw:
        return "supports"
    if "rebut" in raw or "contradict" in raw:
        return "rebuts"
    if "clarif" in raw:
        return "clarifies"
    if "question" in raw or "ask" in raw:
        return "asks"
    if "return" in raw:
        return "return_to_thread"
    if "tangent" in raw or "branch" in raw:
        return "tangent"
    return "contextual"


def _normalize_edge_relations(value: Any) -> List[Dict[str, str]]:
    if not isinstance(value, list):
        return []
    normalized: List[Dict[str, str]] = []
    seen = set()
    for item in value:
        if not isinstance(item, dict):
            continue
        related_node = _as_clean_str(
            item.get("related_node")
            or item.get("relatedNode")
            or item.get("source")
            or item.get("from")
            or item.get("node")
        )
        relation_text = _as_clean_str(
            item.get("relation_text")
            or item.get("relationText")
            or item.get("description")
            or item.get("explanation")
        )
        relation_type = _normalize_relation_type(item.get("relation_type") or item.get("type"))
        if not related_node:
            continue
        if not relation_text:
            relation_text = f"{related_node} -> current node"
        key = (related_node, relation_type, relation_text)
        if key in seen:
            continue
        seen.add(key)
        normalized.append(
            {
                "related_node": related_node,
                "relation_type": relation_type,
                "relation_text": relation_text,
            }
        )
    return normalized


def _normalize_generated_output(parsed: Any) -> List[Dict[str, Any]]:
    if isinstance(parsed, list):
        raw_nodes = parsed
        raw_edges = []
    elif isinstance(parsed, dict):
        if isinstance(parsed.get("nodes"), list):
            raw_nodes = parsed.get("nodes") or []
            raw_edges = parsed.get("edges") if isinstance(parsed.get("edges"), list) else []
        elif parsed.get("node_name") or parsed.get("title") or parsed.get("name"):
            raw_nodes = [parsed]
            raw_edges = []
        else:
            return []
    else:
        return []

    id_to_name: Dict[str, str] = {}
    for raw in raw_nodes:
        if not isinstance(raw, dict):
            continue
        node_name = _as_clean_str(raw.get("node_name") or raw.get("title") or raw.get("name"))
        raw_id = _as_clean_str(raw.get("id") or raw.get("node_id"))
        if node_name and raw_id:
            id_to_name[raw_id] = node_name

    incoming_edges_by_target: Dict[str, List[Dict[str, str]]] = {}
    for raw_edge in raw_edges:
        if not isinstance(raw_edge, dict):
            continue
        source_raw = _as_clean_str(raw_edge.get("source") or raw_edge.get("from") or raw_edge.get("from_node"))
        target_raw = _as_clean_str(raw_edge.get("target") or raw_edge.get("to") or raw_edge.get("to_node"))
        source_name = id_to_name.get(source_raw, source_raw)
        target_name = id_to_name.get(target_raw, target_raw)
        if not source_name or not target_name:
            continue
        entry = {
            "related_node": source_name,
            "relation_type": _normalize_relation_type(raw_edge.get("relation_type") or raw_edge.get("type")),
            "relation_text": _as_clean_str(
                raw_edge.get("relation_text")
                or raw_edge.get("description")
                or raw_edge.get("label")
            )
            or f"{source_name} -> {target_name}",
        }
        incoming_edges_by_target.setdefault(target_name, []).append(entry)

    normalized_nodes: List[Dict[str, Any]] = []
    for raw in raw_nodes:
        if not isinstance(raw, dict):
            continue

        node_name = _as_clean_str(raw.get("node_name") or raw.get("title") or raw.get("name"))
        if not node_name:
            continue

        predecessor = _as_clean_str(raw.get("predecessor")) or None
        successor = _as_clean_str(raw.get("successor")) or None
        summary = _as_clean_str(raw.get("summary") or raw.get("node_text") or raw.get("text")) or node_name
        source_excerpt = _as_clean_str(raw.get("source_excerpt") or raw.get("source") or summary)
        contextual_relation = _as_string_map(raw.get("contextual_relation"))
        edge_relations = _normalize_edge_relations(raw.get("edge_relations"))
        edge_relations.extend(incoming_edges_by_target.get(node_name, []))

        for relation in edge_relations:
            related_name = relation["related_node"]
            if related_name not in contextual_relation:
                contextual_relation[related_name] = relation["relation_text"]

        linked_nodes = _as_string_list(raw.get("linked_nodes"))
        for related_name in contextual_relation:
            if related_name not in linked_nodes:
                linked_nodes.append(related_name)

        thread_id = _as_clean_str(raw.get("thread_id")) or f"thread::{_slugify(node_name)}"
        thread_state = _normalize_thread_state(raw.get("thread_state"), predecessor)

        normalized_nodes.append(
            {
                "id": _as_clean_str(raw.get("id") or raw.get("node_id")) or str(uuid.uuid4()),
                "node_name": node_name,
                "summary": summary,
                "node_text": summary,
                "source_excerpt": source_excerpt,
                "predecessor": predecessor,
                "successor": successor,
                "contextual_relation": contextual_relation,
                "edge_relations": edge_relations,
                "thread_id": thread_id,
                "thread_state": thread_state,
                "linked_nodes": linked_nodes,
                "claims": _as_string_list(raw.get("claims")),
                "is_bookmark": bool(raw.get("is_bookmark")),
                "is_contextual_progress": bool(raw.get("is_contextual_progress")),
                "chunk_id": raw.get("chunk_id"),
            }
        )
    return normalized_nodes


def _call_local_chat_json(
    prompt: str,
    system_prompt: str,
    config: Dict[str, Any],
    temperature: float = 0.65,
    max_tokens: int = 4000,
) -> Any:
    base_url = str(config.get("base_url", "")).rstrip("/")
    if not base_url:
        raise ValueError("Local LLM base_url is required.")

    payload = {
        "model": config.get("chat_model", "glm-4.6v-flash"),
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

    client = genai.Client(api_key=resolved_key)
    if key_source:
        _trace_api_call("[GEMINI] Using key from %s for graph generation model=%s.", key_source, resolved_model)

    generate_lct_prompt = GENERATE_LCT_PROMPT

    contents = [
        types.Content(
            role="user",
            parts=[types.Part.from_text(text=transcript)],
        )
    ]

    config = types.GenerateContentConfig(
        temperature=0.65,
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

        time.sleep(backoff_base ** attempt)

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

    system_prompt = ACCUMULATE_SYSTEM_PROMPT

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
                temperature=0.65,
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

        time.sleep(backoff_base ** attempt)

    logger.error("[ACCUMULATE] All decoding attempts failed - using fallback.")
    return {
        "decision": "continue_accumulating",
        "Completed_segment": "",
        "Incomplete_segment": input_text,
        "detected_threads": [],
        "_errors": errors or ["Gemini accumulation attempts exhausted"],
    }


def generate_lct_json_local(
    transcript: str,
    llm_config: Optional[Dict[str, Any]] = None,
    retries: int = 5,
    backoff_base: float = 1.5,
) -> List[Dict[str, Any]]:
    config = _resolve_llm_config(llm_config)
    for attempt in range(retries):
        try:
            parsed = _call_local_chat_json(
                prompt=transcript,
                system_prompt=LOCAL_GENERATE_LCT_PROMPT,
                config=config,
                temperature=0.65,
                max_tokens=4000,
            )
            normalized = _normalize_generated_output(parsed)
            if normalized:
                return normalized
            logger.warning(
                "[LCT JSON] Local response decoded but produced no normalized nodes; attempt %s",
                attempt + 1,
            )
        except Exception as e:
            logger.warning("[LCT JSON] Local attempt %s failed: %s", attempt + 1, e)

        time.sleep(backoff_base ** attempt)

    logger.error("[LCT JSON] Local attempts exhausted; returning empty list.")
    return []


def accumulate_text_json_local(
    input_text: str,
    llm_config: Optional[Dict[str, Any]] = None,
    retries: int = 3,
    backoff_base: float = 1.5,
) -> Dict[str, Any]:
    config = _resolve_llm_config(llm_config)
    errors: List[str] = []
    for attempt in range(retries):
        try:
            parsed = _call_local_chat_json(
                prompt=input_text,
                system_prompt=ACCUMULATE_SYSTEM_PROMPT,
                config=config,
                temperature=0.65,
                max_tokens=1200,
            )
            if isinstance(parsed, dict):
                if errors:
                    parsed["_warnings"] = errors
                return parsed
            logger.warning("[ACCUMULATE] Local response was not a dict; attempt %s", attempt + 1)
            errors.append(f"Attempt {attempt + 1} returned non-dict payload")
        except Exception as e:
            logger.warning("[ACCUMULATE] Local attempt %s failed: %s", attempt + 1, e)
            errors.append(f"Attempt {attempt + 1} failed: {e}")

        time.sleep(backoff_base ** attempt)

    logger.error("[ACCUMULATE] Local attempts exhausted - using fallback.")
    return {
        "decision": "continue_accumulating",
        "Completed_segment": "",
        "Incomplete_segment": input_text,
        "detected_threads": [],
        "_errors": errors or ["Local accumulation attempts exhausted"],
    }


def generate_lct_json(
    transcript: str,
    llm_config: Optional[Dict[str, Any]] = None,
    retries: int = 5,
    backoff_base: float = 1.5,
    status_messages: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
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
                return gemini_result
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
        retries=retries,
        backoff_base=backoff_base,
    )


def accumulate_text_json(
    input_text: str,
    llm_config: Optional[Dict[str, Any]] = None,
    retries: int = 3,
    backoff_base: float = 1.5,
) -> Dict[str, Any]:
    config = _resolve_llm_config(llm_config)
    if config.get("mode") == "online":
        gemini_key, key_source = _resolve_gemini_api_key()
        gemini_model = _resolve_online_gemini_model(config)
        if gemini_key:
            return genai_accumulate_text_json(
                input_text,
                model_name=gemini_model,
                api_key=gemini_key,
                key_source=key_source,
                retries=retries,
                backoff_base=backoff_base,
            )
        fallback = accumulate_text_json_local(
            input_text,
            llm_config=config,
            retries=retries,
            backoff_base=backoff_base,
        )
        warnings = fallback.get("_warnings")
        if not isinstance(warnings, list):
            warnings = []
        warnings.append(_missing_gemini_key_message())
        fallback["_warnings"] = warnings
        return fallback

    return accumulate_text_json_local(
        input_text,
        llm_config=config,
        retries=retries,
        backoff_base=backoff_base,
    )


class TranscriptProcessor:
    def __init__(
        self,
        send_update,
        send_status: Optional[Callable[[str, str, Dict[str, Any]], Awaitable[None]]] = None,
        batch_size: int = 4,
        max_batch_size: int = 12,
        llm_config: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.accumulator: List[str] = []
        self.existing_json: List[Dict[str, Any]] = []
        self.chunk_dict: Dict[str, str] = {}
        self.base_batch_size = batch_size
        self.max_batch_size = max_batch_size
        self._current_batch_size = batch_size
        self._continue_accumulating = True
        self._send_update = send_update
        self._send_status = send_status
        self._llm_config = _resolve_llm_config(llm_config)

    async def _emit_status(self, level: str, message: str, context: Optional[Dict[str, Any]] = None) -> None:
        if not self._send_status:
            return
        payload = context or {}
        try:
            await self._send_status(level, message, payload)
        except Exception as exc:
            logger.debug("[PROCESSOR STATUS] failed to send status update: %s", exc)

    async def handle_final_text(self, final_text: str) -> None:
        if not final_text:
            return
        self.accumulator.append(final_text)
        if len(self.accumulator) >= self._current_batch_size and self._continue_accumulating:
            await self._process_batches()

    async def flush(self) -> None:
        if not self.accumulator:
            return
        await self._process_batch(self.accumulator, stop_accumulating_flag=True)
        self.accumulator = []
        self._current_batch_size = self.base_batch_size
        self._continue_accumulating = True

    async def _process_batches(self) -> None:
        continue_accumulating, incomplete_seg = await self._process_batch(self.accumulator)

        if continue_accumulating:
            if self._current_batch_size >= self.max_batch_size:
                await self._process_batch(self.accumulator, stop_accumulating_flag=True)
                self.accumulator = []
                self._current_batch_size = self.base_batch_size
                self._continue_accumulating = True
            else:
                self._current_batch_size += self.base_batch_size
        else:
            self.accumulator = [incomplete_seg] if incomplete_seg else []
            self._current_batch_size = self.base_batch_size
            self._continue_accumulating = True

    async def _process_batch(
        self,
        text_batch: List[str],
        stop_accumulating_flag: bool = False,
    ) -> Tuple[bool, str]:
        input_text = " ".join(text_batch)
        accumulated_output = accumulate_text_json(input_text, llm_config=self._llm_config)
        if not accumulated_output:
            logger.info("[ACCUMULATE] Empty result; continuing accumulation.")
            await self._emit_status(
                "warning",
                "Accumulator returned empty output; continuing accumulation.",
                {"stage": "accumulate"},
            )
            return True, input_text

        errors = []
        if isinstance(accumulated_output, dict):
            raw_errors = accumulated_output.get("_errors") or accumulated_output.get("_warnings")
            if isinstance(raw_errors, list):
                errors = [str(item) for item in raw_errors if str(item).strip()]

        if errors:
            summary = errors[0]
            if len(errors) > 1:
                summary = f"{summary} (+{len(errors) - 1} more)"
            await self._emit_status(
                "warning",
                summary,
                {
                    "stage": "accumulate",
                    "attempt_errors": errors,
                },
            )

        segmented_input_chunk = accumulated_output.get("Completed_segment", "")
        incomplete_seg = accumulated_output.get("Incomplete_segment", "")

        decision_flag = accumulated_output.get("decision", "continue_accumulating")
        if decision_flag == "continue_accumulating":
            decision = True
        elif decision_flag == "stop_accumulating":
            decision = False
        else:
            logger.info("[ACCUMULATE] Unexpected decision flag: %s", decision_flag)
            decision = True

        if stop_accumulating_flag:
            decision = False
            segmented_input_chunk = input_text
            incomplete_seg = ""

        if segmented_input_chunk.strip():
            mod_input = (
                f"Existing JSON : \n {repr(self.existing_json)} "
                f"\n\n Transcript Input: \n {segmented_input_chunk}"
            )
            generation_status_messages: List[str] = []
            output_json = generate_lct_json(
                mod_input,
                llm_config=self._llm_config,
                status_messages=generation_status_messages,
            )
            for status_message in generation_status_messages:
                await self._emit_status(
                    "warning",
                    status_message,
                    {"stage": "generate_lct_json"},
                )

            if output_json:
                chunk_id = str(uuid.uuid4())
                self.chunk_dict[chunk_id] = segmented_input_chunk
                for item in output_json:
                    item["chunk_id"] = chunk_id

                self.existing_json.extend(output_json)
                await self._send_update(self.existing_json, self.chunk_dict)
            else:
                await self._emit_status(
                    "error",
                    "LLM returned no structured graph output for a completed transcript segment.",
                    {
                        "stage": "generate_lct_json",
                        "segment_chars": len(segmented_input_chunk),
                    },
                )

        logger.info("[ACCUMULATE] Evaluated batch of %s transcripts", len(text_batch))
        return decision, incomplete_seg
