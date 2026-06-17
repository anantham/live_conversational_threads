"""Local (M5) fact-check of a spoken claim — hybrid grounded + labeled.

Local-only (no web/Perplexity). Two-tier, honestly labeled:
1. GROUNDED: retrieve evidence from the user's OWN knowledge base via IndrasNet
   ``retrieval_search`` (notes + past conversations). If relevant evidence exists, M5
   judges the claim against it and the verdict is ``grounding="grounded"`` with citations.
2. MODEL_KNOWLEDGE: if no relevant evidence is found (or IndrasNet is down), M5 judges
   from its own parametric knowledge, labeled ``grounding="model_knowledge"`` so the user
   knows it's unverified-against-their-data and subject to a training cutoff.

A deterministic guard forces ``model_knowledge`` whenever no evidence was retrieved —
the model can't be "grounded" in evidence that doesn't exist.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, Dict, List, Optional

from lct_python_backend.services.live_prayer import _llm

logger = logging.getLogger("lct_backend")

_VERDICTS = {"SUPPORTED", "REFUTED", "PARTLY", "UNVERIFIABLE"}

_PROMPT = """You are fact-checking a single CLAIM spoken in a live conversation.

Below is CONTEXT retrieved from the user's OWN knowledge base (their notes + past conversations). It may be empty or irrelevant.

Decide:
- If the CONTEXT contains evidence bearing on the claim: judge against it and set "grounding":"grounded". Reference the evidence in "reason".
- If the CONTEXT is empty or irrelevant: judge from your own general knowledge and set "grounding":"model_knowledge".

"verdict" is one of: SUPPORTED, REFUTED, PARTLY, UNVERIFIABLE.
Output ONLY JSON: {{"verdict":"...","confidence":0.0-1.0,"grounding":"grounded"|"model_knowledge","reason":"<=40 words"}}

CLAIM: {claim}

CONTEXT:
{evidence}
"""


async def _default_retrieval(query: str) -> Dict[str, Any]:
    from lct_python_backend.services.indrasnet_client import retrieval_search
    return await retrieval_search(query=query, top_k=5, rerank=True)


def _extract_evidence(body: Dict[str, Any], limit: int) -> List[Dict[str, Any]]:
    results = body.get("results") if isinstance(body, dict) else None
    if not isinstance(results, list):
        results = body.get("matches") if isinstance(body, dict) else None
    out: List[Dict[str, Any]] = []
    for r in (results or [])[:limit]:
        if not isinstance(r, dict):
            continue
        snippet = r.get("content") or r.get("snippet") or r.get("text") or ""
        out.append({
            "snippet": str(snippet)[:500],
            "source_type": r.get("source_type"),
            "source_id": r.get("source_id") or r.get("id"),
            "source_timestamp": r.get("source_timestamp") or r.get("item_timestamp"),
            "score": r.get("final_score") or r.get("score") or r.get("rrf_score"),
            "why_relevant": r.get("why_relevant"),
        })
    return out


def _fmt_evidence(evidence: List[Dict[str, Any]]) -> str:
    if not evidence:
        return "(no relevant evidence found in the user's knowledge base)"
    lines = []
    for i, e in enumerate(evidence, 1):
        ts = f" [{e['source_timestamp']}]" if e.get("source_timestamp") else ""
        lines.append(f"{i}.{ts} {e['snippet']}")
    return "\n".join(lines)


async def factcheck(
    claim: str,
    *,
    providers: Optional[List[Dict[str, Any]]] = None,
    retrieval_fn: Optional[Callable[[str], Awaitable[Dict[str, Any]]]] = None,
    max_evidence: int = 5,
) -> Dict[str, Any]:
    """Return a fact-check verdict dict for ``claim``. Never raises (live path)."""
    evidence: List[Dict[str, Any]] = []
    rfn = retrieval_fn or _default_retrieval
    try:
        body = await rfn(claim)
        evidence = _extract_evidence(body, max_evidence)
    except Exception as exc:  # noqa: BLE001 — grounding is best-effort
        logger.info("[live-prayer] factcheck retrieval unavailable (%s) — model-knowledge only", type(exc).__name__)

    data = await _llm.call_json(
        _PROMPT.format(claim=claim, evidence=_fmt_evidence(evidence)),
        providers=providers, max_tokens=400,
    )

    verdict = str(data.get("verdict", "UNVERIFIABLE")).strip().upper()
    if verdict not in _VERDICTS:
        verdict = "UNVERIFIABLE"
    try:
        confidence = float(data.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    # Deterministic honesty guard: no evidence retrieved => cannot be grounded.
    grounding = str(data.get("grounding", "")).strip().lower()
    if not evidence or grounding != "grounded":
        grounding = "model_knowledge"
    reason = str(data.get("reason", ""))[:300]

    return {
        "claim": claim,
        "verdict": verdict,
        "confidence": confidence,
        "grounding": grounding,                 # "grounded" | "model_knowledge"
        "reason": reason,
        "evidence": evidence if grounding == "grounded" else [],
    }
