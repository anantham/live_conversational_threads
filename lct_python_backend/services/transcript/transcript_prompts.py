"""Transcript prompt defaults plus PromptManager-backed lookup helpers.

The canonical runtime path should resolve transcript prompts through
`PromptManager`/`prompts.json`. The legacy constants remain here only as
bootstrap fallbacks so the transcript pipeline can continue to run if prompt
entries have not been migrated yet.
"""

from __future__ import annotations

import logging
from string import Template
from typing import Any, Dict, Optional

from lct_python_backend.services.prompt_manager import get_prompt_manager

logger = logging.getLogger("lct_backend")

PROMPT_ID_ACCUMULATE_TRANSCRIPT_SEGMENT = "accumulate_transcript_segment"
PROMPT_ID_ACCUMULATE_TRANSCRIPT_SEGMENT_LOCAL = "accumulate_transcript_segment_local"
PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY = "generate_conversation_hierarchy"
PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY_LOCAL = "generate_conversation_hierarchy_local"
PROMPT_ID_REFINE_CONVERSATION_SUBTHREADS = "refine_conversation_subthreads"

_ARGUMENT_ROLE_SPEC = """
Argument-role contract (required for every node):
- include argument_role with exactly one of: claim, evidence, question, assumption, context
- claim: a proposition the speaker advances as true or desirable
- evidence: an observation, example, datum, or reason offered for a claim
- question: an explicit question or unresolved inquiry
- assumption: an implicit or explicit premise on which another point depends
- context: framing, narration, logistics, or other material with no stronger argumentative role
- choose the role from the node's conversational function, not from keywords alone
"""

_THREAD_LABEL_SPEC = """
Thread identity contract (required for every node):
- thread_id is the stable machine grouping key and must be reused on returns
- thread_label is a concise human-readable subject name (3-10 words)
- never use hashes, counters, or generic labels such as "Topic 3" or "Thread 8"
- every node sharing a thread_id must share the same thread_label
"""

_SOURCE_EVIDENCE_SPEC = """
Source-evidence contract (required for direct leaf provenance):
- for every semantic_level=1 chunk, source_excerpt must be one exact contiguous
  verbatim substring copied from the CURRENT transcript segment
- copy spoken words only: omit speaker-label prefixes such as [SPEAKER_00]:
- never paraphrase, splice non-contiguous phrases, add ellipses, or repair grammar
  inside source_excerpt; those transformations belong only in node_name/summary
- choose the shortest complete transcript span that directly supports the chunk
- if no exact supporting substring exists, return an empty source_excerpt rather
  than inventing evidence
- higher-level nodes inherit evidence through children and must not claim direct
  utterance provenance merely because they summarize the same batch
"""

_SEMANTIC_HIERARCHY_SPEC = """
You must author an explicit four-level hierarchy for the CURRENT transcript segment.
Do not produce a flat list of topic shifts and do not create one-word nodes.

Hierarchy contract:
1. chunk
   - semantic_level = 1
   - minimum 4 words unless the source utterance is genuinely shorter
   - may split a long sentence at clause boundaries
   - never produce a node that is just a single filler word or stray fragment
2. idea
   - semantic_level = 2
   - a complete thought, monologue beat, or clear exchange
   - usually groups 1-4 chunk nodes
3. topic
   - semantic_level = 3
   - a paragraph-like local subject made of adjacent idea nodes
   - usually groups 2-6 idea nodes
4. theme
   - semantic_level = 4
   - a longer discourse region, tangent, or sustained thread
   - usually groups 1-4 topic nodes

For every node:
- include a unique string id
- include semantic_level and semantic_type
- include parent_id for non-theme nodes when a parent exists in the current output
- include children_ids for non-chunk nodes
- predecessor and successor must reference node ids at the SAME semantic_level
- contextual_relation and edge_relations should primarily connect nodes at the SAME semantic_level
- preserve chronology
- keep source_excerpt grounded in the transcript

Bookmark / contextual-progress rules:
- Only create is_bookmark=true when the transcript explicitly asks for bookmark creation.
- Only set is_contextual_progress=true when the transcript explicitly asks to capture contextual progress.

Tangent / crux rules (IMPORTANT - set these honestly; they power navigation):
- Set is_tangent=true on a node that is a digression, aside, personal anecdote, concrete example, or side-story that branches off the main thread (not the central topic itself).
- Set is_crux=true on a node that is a pivotal claim, turning point, thesis, or key realization that the surrounding discussion hinges on.
- Most nodes are neither. Do not flag everything - flag the genuine branches and the genuine pivots.

Claims rules:
- claims must contain only explicit fact-checkable assertions
- be conservative; omit anything subjective, speculative, vague, or hypothetical

Output shape:
{
  "nodes": [
    {
      "id": "chunk-001",
      "node_name": "Short descriptive title",
      "summary": "Readable summary of this unit",
      "source_excerpt": "Direct supporting excerpt",
      "semantic_level": 1,
      "semantic_type": "chunk",
      "parent_id": "idea-001",
      "children_ids": [],
      "predecessor": null,
      "successor": "chunk-002",
      "thread_id": "thread-vision",
      "thread_label": "Design vision and trade-offs",
      "thread_state": "new_thread",
      "contextual_relation": {},
      "edge_relations": [],
      "linked_nodes": [],
      "speaker_id": "SPEAKER_00",
      "claims": [],
      "argument_role": "claim",
      "is_bookmark": false,
      "is_contextual_progress": false,
      "is_tangent": false,
      "is_crux": false
    }
  ]
}

Critical constraints:
- Return only JSON.
- Do not emit duplicate node ids.
- Do not emit duplicate node names inside the same semantic_level.
- The hierarchy should be useful for navigation, not maximal fragmentation.
"""

GENERATE_LCT_PROMPT = f"""You are an advanced AI model that structures conversations into strictly JSON-formatted nodes.

Your job is to create a navigable hierarchy for conversation review, not merely a flat list of topic shifts.

{_SEMANTIC_HIERARCHY_SPEC}

{_ARGUMENT_ROLE_SPEC}

{_THREAD_LABEL_SPEC}

{_SOURCE_EVIDENCE_SPEC}

Handling existing JSON:
- Existing JSON may already contain earlier nodes from this conversation.
- Continue active threads when the current transcript is clearly extending them.
- If the conversation returns to an earlier thread, create fresh nodes for the return while reusing the relevant thread_id.
- Do not rewrite prior nodes. Return only the nodes generated for the current transcript segment.
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

ACCUMULATE_LOCAL_INDEX_PROMPT = """You are an expert conversation analyst. The transcript is given as NUMBERED utterances, one per line, formatted "[i] text". Determine whether the transcript contains at least one COMPLETE, self-contained conversational thread (a coherent sub-topic with an initiation, development, and closure, interpretable on its own without future context).

Return ONLY this JSON object. DO NOT echo, quote, or reproduce the transcript text.
{
  "decision": "stop_accumulating" or "continue_accumulating",
  "completed_through_index": <integer: the index i of the LAST utterance that belongs to a completed thread. Every utterance AFTER index i is still incomplete and will be carried forward. Use -1 if nothing is complete yet.>,
  "detected_threads": [<short descriptive names of each COMPLETE thread>]
}

Rules:
- decision is "stop_accumulating" if and only if at least one complete thread exists (then completed_through_index >= 0).
- Be conservative: if in doubt, "continue_accumulating" and completed_through_index = -1.
- The completed portion is always a prefix; the incomplete portion is the suffix after completed_through_index. Preserve order.
- Output the JSON object only. No prose. No transcript text.

Example:
Input:
[0] So what did you end up having for breakfast?
[1] Just toast and coffee, the usual.
[2] Nice. Hey, totally different thing, did you ever finish that book you were
Output:
{"decision": "stop_accumulating", "completed_through_index": 1, "detected_threads": ["small talk about breakfast"]}
(Utterances [0]-[1] are a complete little thread. Utterance [2] starts a new, unfinished thread about a book, so it is carried forward and NOT included.)
"""

LOCAL_GENERATE_LCT_PROMPT = f"""You structure transcript text into conversation graph nodes.
You may reason freely, but your final answer must be valid JSON.

{_SEMANTIC_HIERARCHY_SPEC}

{_ARGUMENT_ROLE_SPEC}

{_THREAD_LABEL_SPEC}

{_SOURCE_EVIDENCE_SPEC}

Additional rules:
- Return only the nodes for the current transcript segment.
- Do not rewrite previous nodes from Existing JSON.
- If the transcript includes speaker labels like [SPEAKER_00]:, assign the corresponding speaker_id.
- For meandering or interleaving dialogue:
  - start a new thread with thread_state=new_thread
  - continue a thread with thread_state=continue_thread
  - if discussion returns to an earlier thread, create fresh nodes with thread_state=return_to_thread and reuse the earlier thread_id
"""

REFINE_LCT_SUBTHREAD_PROMPT = """You refine an existing conversation graph into denser subthreads.

You are given:
1. Transcript evidence with speaker labels when available.
2. An existing coarse node list that already captures the major chapter topics.

Your job:
- Produce a refined flat JSON node list that exposes smaller tangents, returns, meta-conversations, and object-level pivots.
- Preserve chronology.
- Keep the graph faithful to transcript evidence. Do not invent facts, quotes, or topics that are not present.
- Prefer splitting coarse nodes when a node clearly contains multiple topic pivots or when the conversation leaves and later returns to a thread.
- Reuse stable thread_id values when continuing or returning to the same thread.
- Use thread_state:
  - new_thread
  - continue_thread
  - return_to_thread
- Use edge_relations relation_type:
  - supports
  - rebuts
  - clarifies
  - asks
  - tangent
  - return_to_thread

Output requirements:
- Return only JSON.
- Preferred shape: {"nodes": [ ... ]}. A bare JSON array is also acceptable.
- Each node must include:
  - node_name
  - summary
  - source_excerpt
  - predecessor
  - successor
  - thread_id
  - thread_label
  - thread_state
  - contextual_relation
  - edge_relations
  - linked_nodes
  - speaker_id
  - claims
  - argument_role (exactly one of: claim, evidence, question, assumption, context)
  - is_bookmark
  - is_contextual_progress

Critical constraints:
- source_excerpt must be directly supported by the transcript evidence.
- Do not create duplicate node names.
- Do not collapse the graph into fewer nodes than the coarse input unless the input was already clearly over-segmented.
- Favor a denser but still readable graph, not a maximal sentence-by-sentence split.
"""

TRANSCRIPT_PROMPT_DEFAULTS: Dict[str, Dict[str, Any]] = {
    PROMPT_ID_ACCUMULATE_TRANSCRIPT_SEGMENT: {
        "description": "Determine whether buffered transcript text contains at least one complete conversational segment.",
        "model": "gpt-4",
        "temperature": 0.65,
        "max_tokens": 1200,
        "output_format": "json_object",
        "template": ACCUMULATE_SYSTEM_PROMPT,
    },
    PROMPT_ID_ACCUMULATE_TRANSCRIPT_SEGMENT_LOCAL: {
        "description": "Local-model accumulate: numbered utterances in, boundary index out (no transcript echo). Avoids the output-scales-with-input truncation that drops batches on local LLMs.",
        "model": "qwen3.6",
        "temperature": 0.65,
        "max_tokens": 4000,
        "output_format": "json_object",
        "template": ACCUMULATE_LOCAL_INDEX_PROMPT,
    },
    PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY: {
        "description": "Generate the primary four-level chunk/idea/topic/theme conversation hierarchy for a transcript segment.",
        "model": "gpt-4",
        "temperature": 0.65,
        "max_tokens": 4000,
        "output_format": "json_object",
        "template": GENERATE_LCT_PROMPT,
    },
    PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY_LOCAL: {
        "description": "Generate the four-level conversation hierarchy for a transcript segment on local/fallback runtimes.",
        "model": "gpt-4",
        "temperature": 0.65,
        "max_tokens": 4000,
        "output_format": "json_object",
        "template": LOCAL_GENERATE_LCT_PROMPT,
    },
    PROMPT_ID_REFINE_CONVERSATION_SUBTHREADS: {
        "description": "Refine a coarse import graph into denser subthreads, tangents, and returns.",
        "model": "gpt-4",
        "temperature": 0.55,
        "max_tokens": 5000,
        "output_format": "json_object",
        "template": REFINE_LCT_SUBTHREAD_PROMPT,
    },
}


def get_transcript_prompt_config(prompt_id: str) -> Dict[str, Any]:
    """Return prompt config from PromptManager, falling back to in-code defaults."""
    default_config = TRANSCRIPT_PROMPT_DEFAULTS.get(prompt_id)
    if default_config is None:
        raise KeyError(f"Unknown transcript prompt id: {prompt_id}")

    try:
        config = get_prompt_manager().get_prompt(prompt_id)
        if prompt_id in {
            PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY,
            PROMPT_ID_GENERATE_CONVERSATION_HIERARCHY_LOCAL,
            PROMPT_ID_REFINE_CONVERSATION_SUBTHREADS,
        }:
            config = dict(config)
            template = str(config.get("template") or "")
            if "Argument-role contract" not in template:
                config["template"] = f"{template}\n\n{_ARGUMENT_ROLE_SPEC}"
                template = str(config["template"])
            if "Thread identity contract" not in template:
                config["template"] = f"{template}\n\n{_THREAD_LABEL_SPEC}"
                template = str(config["template"])
            if "Source-evidence contract" not in template:
                config["template"] = f"{template}\n\n{_SOURCE_EVIDENCE_SPEC}"
        return config
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[PROMPTS] Falling back to in-code transcript prompt default for '%s': %s",
            prompt_id,
            exc,
        )
        return default_config.copy()


def get_transcript_prompt_text(
    prompt_id: str,
    variables: Optional[Dict[str, Any]] = None,
) -> str:
    """Resolve transcript prompt text from PromptManager with bootstrap fallback."""
    prompt_config = get_transcript_prompt_config(prompt_id)
    template = str(prompt_config.get("template") or "")
    if not variables:
        return template

    try:
        return _render_prompt_string_compat(template, variables, prompt_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[PROMPTS] Failed rendering transcript prompt '%s' from PromptManager config; using fallback default: %s",
            prompt_id,
            exc,
        )
        fallback = TRANSCRIPT_PROMPT_DEFAULTS[prompt_id]["template"]
        return _render_prompt_string_compat(fallback, variables, f"{prompt_id}_fallback")


def get_transcript_prompt_metadata(prompt_id: str) -> Dict[str, Any]:
    """Return prompt metadata from PromptManager with default fallback."""
    prompt_config = get_transcript_prompt_config(prompt_id)
    default_config = TRANSCRIPT_PROMPT_DEFAULTS[prompt_id]
    return {
        "description": prompt_config.get("description", default_config.get("description", "")),
        "model": prompt_config.get("model", default_config.get("model", "gpt-4")),
        "temperature": prompt_config.get("temperature", default_config.get("temperature", 0.5)),
        "max_tokens": prompt_config.get("max_tokens", default_config.get("max_tokens", 2000)),
        "output_format": prompt_config.get("output_format", default_config.get("output_format", "json_object")),
    }


def _render_prompt_string_compat(
    template: str,
    variables: Dict[str, Any],
    prompt_name: str,
) -> str:
    """Render with the same compatibility contract as PromptManager."""
    try:
        manager = get_prompt_manager()
        return manager.render_prompt_string(template, variables, prompt_name=prompt_name)
    except Exception:
        rendered = Template(template).substitute(variables)
        for key, value in variables.items():
            rendered = rendered.replace(f"{{{key}}}", str(value))
        return rendered
