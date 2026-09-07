"""Bounded source-backed context for an interleaved conversation.

This is a derived, conversation-local read model over the processor's committed
graph/chunks, not a second semantic database. Callers must supply only authorized
past evidence from ONE conversation. There is no network or cross-session cache.

Lexical retrieval is deliberately only a candidate generator. It neither merges
thread IDs nor authors relationships. Semantic retrieval/reconciliation and
transactional replay remain rollout gates for the experimental processor path.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
import json
import math
import re
from typing import Any, Callable, Mapping, Sequence
from .question_memory import fold_question_memory


class ContextBudgetExceeded(ValueError):
    """The unabridged current passage cannot fit the explicit input budget."""


def conservative_tokens(text: str) -> int:
    """Explicit byte-based estimate; NOT a claim about the provider tokenizer."""
    return len(text.encode("utf-8"))


@dataclass(frozen=True)
class PassageContextPolicy:
    # Budget for this serialized USER message only. The caller must first
    # reserve the actual system prompt, output tokens and protocol headroom.
    # Never infer this value from a model alias or advertised context maximum.
    input_token_budget: int
    count_tokens: Callable[[str], int] = field(default=conservative_tokens, repr=False)
    # None retains the caller's count cadence for compatibility tests. A
    # configured target replaces utterance-count triggers, while existing live
    # latency timers and explicit import/end flushes still make progress.
    passage_target_tokens: int | None = None

    def __post_init__(self) -> None:
        if self.input_token_budget <= 0:
            raise ValueError("input_token_budget must be positive")
        if self.passage_target_tokens is not None and not (
            0 < self.passage_target_tokens <= self.input_token_budget // 2
        ):
            raise ValueError("passage_target_tokens must reserve at least half the input budget for context")


@dataclass(frozen=True)
class ContextPlan:
    prompt: str
    estimated_tokens: int
    omitted_passages: int
    omitted_threads: int
    omitted_questions: int = 0


_STOP = frozenset("a an and are as at be been but by for from had has have i in is it its me my of on or our so that the their them then there these they this those to was we were what when which with would you your".split())
_NODE_FIELDS = ("id", "node_name", "summary", "semantic_level", "semantic_type",
                "thread_id", "thread_label", "thread_state", "argument_role", "speaker_id", "key_points",
                "attribution_review_required", "source_attributions")
_CONTRACT = (
    "This is a processing passage, not a completed topic. Earlier passages are "
    "context only: quote new leaf evidence only from current_passage. Thread memory "
    "is provisional interpretation, not source. Inactivity does not mean resolution. "
    "Retrieval candidates are not proof of a callback or support relationship. "
    "Reuse a thread ID only when meaning warrants it; several threads may advance. "
    "A later clarification preserves the original evidence. If an earlier referent "
    "is missing or ambiguous, do not invent it. Do not repeat earlier nodes. "
    "Nodes marked attribution_review_required were interpreted under earlier "
    "speaker labels; source_attributions records audited current labels, not "
    "proof that their speaker-specific summaries remain correct."
)


def _terms(text: str) -> set[str]:
    return {word for word in re.findall(r"\w+", text.casefold())
            if len(word) > 2 and word not in _STOP}


def plan_conversation_context(
    current_passage: str,
    existing_nodes: Sequence[Mapping[str, Any]],
    source_chunks: Mapping[str, str],
    chunk_utterance_map: Mapping[str, Sequence[str]],
    policy: PassageContextPolicy,
    *,
    semantic_scores: Mapping[str, float] | None = None,
) -> ContextPlan:
    """Retrieve across all supplied history, pack whole evidence under a budget.

    The source mapping is in committed order. Rebuilding from canonical state
    makes repeated planning deterministic and avoids a hidden mutable memory.
    Do not pass future imported utterances here: offline hindsight is a separate
    explicitly labelled mode, not a side effect of preloading the source store.
    """
    nodes_by_chunk: dict[str, list[dict]] = defaultdict(list)
    threads: dict[str, dict] = {}
    for node in existing_nodes:
        compact = {key: node[key] for key in _NODE_FIELDS if node.get(key) is not None}
        chunk_id = str(node.get("chunk_id") or "")
        if chunk_id in source_chunks:
            nodes_by_chunk[chunk_id].append(compact)
        thread_id = str(node.get("thread_id") or "")
        if not thread_id:
            continue
        memory = threads.setdefault(thread_id, {
            "thread_id": thread_id, "thread_label": node.get("thread_label") or thread_id,
            "anchors": [],
        })
        # Preserve the first anchor and most recent two, rather than replacing
        # the original question with the last thing said. This is not an LLM
        # summary and makes no claim to resolve or enumerate every open question.
        anchor = {k: compact[k] for k in ("id", "summary", "argument_role") if k in compact}
        anchor["chunk_id"] = chunk_id
        memory["anchors"].append(anchor)
        if len(memory["anchors"]) > 3:
            del memory["anchors"][1]

    chunk_ids = list(source_chunks)
    questions = fold_question_memory(existing_nodes, source_chunks)
    documents = [
        _terms(source_chunks[cid] + " " + json.dumps(nodes_by_chunk[cid], ensure_ascii=False))
        for cid in chunk_ids
    ]
    frequencies = Counter(term for terms in documents for term in terms)
    query = _terms(current_passage)
    scores = [sum(math.log(1 + len(documents) / frequencies[t])
                  for t in query & terms) for terms in documents]
    ranked = sorted(range(len(chunk_ids)), key=lambda i: (-scores[i], -i))
    if semantic_scores is not None:
        if any(cid not in source_chunks or type(score) not in (int, float) or not math.isfinite(score)
               for cid, score in semantic_scores.items()):
            raise ValueError("Invalid semantic source candidates")
        semantic_ranked = sorted(semantic_scores, key=lambda cid: (-semantic_scores[cid], cid))
        # Reciprocal-rank fusion avoids treating cosine as calibrated confidence
        # or comparing its magnitude directly to lexical relevance.
        fused = {index: 1 / (60 + rank) for rank, index in enumerate(ranked, 1) if scores[index] > 0}
        index_by_id = {cid: index for index, cid in enumerate(chunk_ids)}
        for rank, cid in enumerate(semantic_ranked, 1):
            index = index_by_id[cid]
            fused[index] = fused.get(index, 0) + 1 / (60 + rank)
        ranked = sorted(range(len(chunk_ids)), key=lambda i: (-fused.get(i, 0), -i))
    payload: dict[str, Any] = {
        "context_contract": _CONTRACT,
        "current_passage": current_passage,
        "earlier_passages": [],
        "thread_memory": [],
        "question_memory": [],
        "coverage": {},
    }
    selected_chunks: set[str] = set()
    selected_threads: set[str] = set()
    selected_questions: set[str] = set()

    def render() -> str:
        payload["coverage"] = {
            "omitted_passages": len(chunk_ids) - len(selected_chunks),
            "omitted_threads": len(threads) - len(selected_threads),
            "omitted_questions": len(questions) - len(selected_questions),
            "retrieval": ("semantic_lexical_rank_fusion_plus_recent_overlap" if semantic_scores is not None
                          else "lexical_candidates_plus_recent_overlap"),
        }
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    if policy.count_tokens(render()) > policy.input_token_budget:
        raise ContextBudgetExceeded("Current passage exceeds the reserved user-input budget; split before inference")

    def add(kind: str, identity: str, item: dict, selected: set[str]) -> bool:
        if identity in selected:
            return True
        payload[kind].append(item)
        selected.add(identity)
        if policy.count_tokens(render()) <= policy.input_token_budget:
            return True
        payload[kind].pop()
        selected.remove(identity)
        return False

    def add_passage(cid: str) -> bool:
        return add("earlier_passages", cid, {
            "chunk_id": cid, "text": source_chunks[cid],
            "utterance_ids": list(chunk_utterance_map.get(cid, ())),
            "nodes": nodes_by_chunk[cid],
        }, selected_chunks)

    def add_thread(tid: str) -> None:
        if tid in threads:
            add("thread_memory", tid, threads[tid], selected_threads)

    # Give a distant relevant source first claim on space, not an arbitrary
    # last-N node list. Keep the immediately previous passage as read-only
    # overlap where it fits. Never crop a quote to manufacture a fit.
    if ranked:
        first = chunk_ids[ranked[0]]
        if add_passage(first):
            for node in nodes_by_chunk[first]:
                add_thread(str(node.get("thread_id") or ""))
        add_passage(chunk_ids[-1])

    # Relevant evidence competes before the remaining thread register. Both
    # omissions are explicit; neither payload is advertised as complete memory.
    for index in ranked:
        cid = chunk_ids[index]
        if (scores[index] > 0 or (semantic_scores is not None and cid in semantic_scores)) and add_passage(cid):
            for node in nodes_by_chunk[cid]:
                add_thread(str(node.get("thread_id") or ""))
    # Keep unresolved questions available even if unrelated discussion has
    # displaced their raw passage. Exact original/intermediate/latest quotes and node/chunk
    # IDs remain attached. Closed questions are still eligible for callbacks.
    for qid in sorted(questions, key=lambda qid: questions[qid]["status"] != "open"):
        add("question_memory", qid, questions[qid], selected_questions)
    for tid in threads:
        add_thread(tid)
    for index in ranked:
        add_passage(chunk_ids[index])
    prompt = render()
    return ContextPlan(prompt, policy.count_tokens(prompt),
                       len(chunk_ids) - len(selected_chunks), len(threads) - len(selected_threads),
                       len(questions) - len(selected_questions))
