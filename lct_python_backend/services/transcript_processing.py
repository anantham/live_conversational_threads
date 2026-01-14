import json
import logging
import os
import random
import time
import uuid
from typing import Any, Dict, List, Tuple, Optional

import httpx
from google import genai
from google.genai import types

from lct_python_backend.services.llm_config import get_env_llm_defaults
from lct_python_backend.services.local_llm_client import extract_json_from_text

logger = logging.getLogger("lct_backend")

GOOGLEAI_API_KEY = os.getenv("GOOGLEAI_API_KEY")
GEMINI_MODEL_NAME = "gemini-2.5-flash-preview-05-20"

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


def _resolve_llm_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return config or get_env_llm_defaults()


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

    if config.get("json_mode", True):
        payload["response_format"] = {"type": "json_object"}

    url = f"{base_url}/v1/chat/completions"
    timeout = float(config.get("timeout_seconds", 120))
    with httpx.Client(timeout=timeout) as client:
        try:
            response = client.post(url, json=payload)
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            return extract_json_from_text(content)
        except httpx.HTTPStatusError as exc:
            if "response_format" in payload:
                logger.warning(
                    "Local LLM response_format rejected (%s); retrying without response_format.",
                    exc.response.text,
                )
                payload.pop("response_format", None)
                retry = client.post(url, json=payload)
                retry.raise_for_status()
                content = retry.json()["choices"][0]["message"]["content"]
                return extract_json_from_text(content)
            raise


def generate_lct_json_gemini(
    transcript: str,
    retries: int = 5,
    backoff_base: float = 1.5,
) -> List[Dict[str, Any]]:
    if not GOOGLEAI_API_KEY:
        logger.error("GOOGLEAI_API_KEY is not set; cannot generate LCT JSON.")
        return []

    client = genai.Client(api_key=GOOGLEAI_API_KEY)

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

    for attempt in range(retries):
        full_response = ""
        try:
            for chunk in client.models.generate_content_stream(
                model=GEMINI_MODEL_NAME,
                contents=contents,
                config=config,
            ):
                if hasattr(chunk, "text"):
                    full_response += chunk.text

            try:
                parsed = json.loads(full_response)
                return parsed
            except json.JSONDecodeError as e:
                logger.warning("[LCT JSON] Attempt %s JSON decode failed: %s", attempt + 1, e)
                logger.debug("[LCT JSON] Raw Gemini response: %s", full_response)

        except Exception as e:
            logger.warning("[LCT JSON] Attempt %s failed: %s", attempt + 1, e)

        time.sleep(backoff_base ** attempt)

    logger.error("[LCT JSON] All attempts failed, returning empty list.")
    return []


def genai_accumulate_text_json(
    input_text: str,
    retries: int = 3,
    backoff_base: float = 1.5,
) -> Dict[str, Any]:
    if not GOOGLEAI_API_KEY:
        logger.error("GOOGLEAI_API_KEY is not set; cannot accumulate transcript text.")
        return {
            "decision": "continue_accumulating",
            "Completed_segment": "",
            "Incomplete_segment": input_text,
            "detected_threads": [],
        }

    system_prompt = ACCUMULATE_SYSTEM_PROMPT

    for attempt in range(retries):
        full_response = ""
        try:
            client = genai.Client(api_key=GOOGLEAI_API_KEY)

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
                model=GEMINI_MODEL_NAME,
                contents=contents,
                config=config,
            ):
                if hasattr(chunk, "text"):
                    full_response += str(chunk.text)

            try:
                return json.loads(full_response)
            except json.JSONDecodeError as e:
                logger.warning("[ACCUMULATE] Attempt %s JSON decode failed: %s", attempt + 1, e)
                logger.debug("[ACCUMULATE] Raw Gemini response: %s", full_response)

        except Exception as e:
            logger.warning("[ACCUMULATE] Attempt %s failed: %s", attempt + 1, e)

        time.sleep(backoff_base ** attempt)

    logger.error("[ACCUMULATE] All decoding attempts failed - using fallback.")
    return {
        "decision": "continue_accumulating",
        "Completed_segment": "",
        "Incomplete_segment": input_text,
        "detected_threads": [],
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
                system_prompt=GENERATE_LCT_PROMPT,
                config=config,
                temperature=0.65,
                max_tokens=4000,
            )
            if isinstance(parsed, list):
                return parsed
            logger.warning("[LCT JSON] Local response was not a list; attempt %s", attempt + 1)
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
                return parsed
            logger.warning("[ACCUMULATE] Local response was not a dict; attempt %s", attempt + 1)
        except Exception as e:
            logger.warning("[ACCUMULATE] Local attempt %s failed: %s", attempt + 1, e)

        time.sleep(backoff_base ** attempt)

    logger.error("[ACCUMULATE] Local attempts exhausted - using fallback.")
    return {
        "decision": "continue_accumulating",
        "Completed_segment": "",
        "Incomplete_segment": input_text,
        "detected_threads": [],
    }


def generate_lct_json(
    transcript: str,
    llm_config: Optional[Dict[str, Any]] = None,
    retries: int = 5,
    backoff_base: float = 1.5,
) -> List[Dict[str, Any]]:
    config = _resolve_llm_config(llm_config)
    if config.get("mode") == "online" and GOOGLEAI_API_KEY:
        return generate_lct_json_gemini(
            transcript,
            retries=retries,
            backoff_base=backoff_base,
        )

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
    if config.get("mode") == "online" and GOOGLEAI_API_KEY:
        return genai_accumulate_text_json(
            input_text,
            retries=retries,
            backoff_base=backoff_base,
        )

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
        self._llm_config = _resolve_llm_config(llm_config)

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
            return True, input_text

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
            output_json = generate_lct_json(mod_input, llm_config=self._llm_config)

            if output_json:
                chunk_id = str(uuid.uuid4())
                self.chunk_dict[chunk_id] = segmented_input_chunk
                for item in output_json:
                    item["chunk_id"] = chunk_id

                self.existing_json.extend(output_json)
                await self._send_update(self.existing_json, self.chunk_dict)

        logger.info("[ACCUMULATE] Evaluated batch of %s transcripts", len(text_batch))
        return decision, incomplete_seg
