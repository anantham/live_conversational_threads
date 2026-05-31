"""Crux detection — identify load-bearing beliefs / disagreement pivots.

A *crux* is a belief or claim a position hinges on: change it and much of the
downstream position changes. Cruxes are often the true pivot of a disagreement.
Unlike the per-node bias/frame/simulacra detectors, crux detection is **relational**
— it makes ONE graph-level LLM call over the conversation's nodes + their
agreement/disagreement edges — and it sets the existing ``Node.is_crux`` flag
(which the frontend already renders amber), storing the rationale in
``Node.display_preferences["crux"]`` (no migration). See ADR-035.

Routed through the LlmGateway (via ``local_chat_json``), which captures LLM
telemetry (ADR-034) and never hardcodes a model — deliberately avoiding the
gateway-bypass pattern in the other detectors (see
docs/AUDIT_RATIONALITY_2026-05-30.md).

LIMITATION: the gateway is openai-compatible only — online (Gemini) generation
lives in ``transcript_llm_callers`` and is NOT reachable from here. When the LLM
lane is in online mode, ``_detect`` raises ``CruxConfigurationError`` rather than
silently posting to a likely-down local endpoint; ``analyze_conversation`` catches
it (like any detection failure) and surfaces the message in the response's
``error`` field, which the crux page displays. Crux runs on a local/
openai-compatible provider; wiring it to Gemini would need a general Gemini
chat-JSON caller, deferred as out-of-proportion for this path (see ISSUES.md).
"""

import logging
import uuid
from datetime import datetime
from typing import Any, Dict, List, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.models import Node, Relationship
from lct_python_backend.services.prompt_manager import get_prompt_manager
from lct_python_backend.services.llm_config import load_llm_config
from lct_python_backend.services.local_llm_client import local_chat_json

logger = logging.getLogger("lct_backend")


class CruxConfigurationError(ValueError):
    """Crux can't run under the current LLM configuration (e.g. online/Gemini mode).

    Raised by ``_detect``; ``analyze_conversation`` catches it with other detection
    failures and returns the message in the response's ``error`` field (HTTP 200),
    which the crux page surfaces to the user.
    """

CRUX_TYPES = {
    "disagreement_pivot",
    "load_bearing_assumption",
    "value_crux",
    "definitional_crux",
    "empirical_crux",
}

# Relationship types that signal where a crux is likely to sit. Used only to order
# the edge list so the most crux-relevant edges appear first; all edges are passed.
_DISAGREEMENT_HINTS = ("disagree", "contradict", "refute", "challenge", "tension", "agree", "support")


# ── pure helpers (LLM-independent — unit tested directly) ────────────────────

def build_detection_inputs(nodes: List[Any], relationships: List[Any]) -> Tuple[int, str, str]:
    """Render the nodes + edges blocks for the crux prompt. Pure / no IO."""
    node_lines = []
    for node in nodes:
        summary = (getattr(node, "summary", "") or "").strip().replace("\n", " ")
        if len(summary) > 200:
            summary = summary[:200] + "…"
        node_lines.append(f"- {node.id}: {getattr(node, 'node_name', '') or 'Untitled'} — {summary}")
    nodes_block = "\n".join(node_lines) if node_lines else "(no nodes)"

    def rel_rank(rel: Any) -> int:
        rtype = (getattr(rel, "relationship_type", "") or "").lower()
        for i, hint in enumerate(_DISAGREEMENT_HINTS):
            if hint in rtype:
                return i
        return len(_DISAGREEMENT_HINTS)

    edge_lines = []
    for rel in sorted(relationships, key=rel_rank):
        explanation = (getattr(rel, "explanation", "") or "").strip().replace("\n", " ")
        if len(explanation) > 120:
            explanation = explanation[:120] + "…"
        rtype = getattr(rel, "relationship_type", "") or "related"
        suffix = f" ({explanation})" if explanation else ""
        edge_lines.append(f"- {rel.from_node_id} --{rtype}--> {rel.to_node_id}{suffix}")
    edges_block = "\n".join(edge_lines) if edge_lines else "(no agreement/disagreement edges)"

    return len(nodes), nodes_block, edges_block


def parse_crux_response(data: Any) -> Dict[str, Dict[str, Any]]:
    """Normalize the LLM JSON into {node_id: {crux_type, confidence, reason}}.

    Defensive: tolerates non-dict input, missing keys, bad types, and confidence
    below the 0.5 threshold (those entries are dropped).
    """
    if not isinstance(data, dict):
        return {}
    cruxes = data.get("cruxes")
    if not isinstance(cruxes, list):
        return {}

    result: Dict[str, Dict[str, Any]] = {}
    for entry in cruxes:
        if not isinstance(entry, dict):
            continue
        node_id = str(entry.get("node_id") or "").strip()
        if not node_id:
            continue
        try:
            confidence = float(entry.get("confidence", 0))
        except (TypeError, ValueError):
            confidence = 0.0
        confidence = max(0.0, min(1.0, confidence))
        if confidence <= 0.5:
            continue
        crux_type = str(entry.get("crux_type") or "").strip().lower()
        if crux_type not in CRUX_TYPES:
            crux_type = "disagreement_pivot"
        result[node_id] = {
            "crux_type": crux_type,
            "confidence": round(confidence, 3),
            "reason": str(entry.get("reason") or "").strip(),
        }
    return result


def _summarize(node_results: List[Dict[str, Any]], total_nodes: int) -> Dict[str, Any]:
    by_type: Dict[str, int] = {}
    for r in node_results:
        by_type[r["crux_type"]] = by_type.get(r["crux_type"], 0) + 1
    return {
        "total_nodes": total_nodes,
        "crux_count": len(node_results),
        "by_type": by_type,
        "cruxes": node_results,
    }


# ── detector ─────────────────────────────────────────────────────────────────

class CruxDetector:
    """Detects cruxes across a conversation and sets ``Node.is_crux``."""

    def __init__(self, db_session: AsyncSession):
        self.db = db_session
        self.prompt_manager = get_prompt_manager()

    async def _load_nodes(self, conversation_id: str) -> List[Node]:
        result = await self.db.execute(
            select(Node).where(Node.conversation_id == uuid.UUID(conversation_id))
        )
        return list(result.scalars().all())

    async def _load_relationships(self, conversation_id: str) -> List[Relationship]:
        result = await self.db.execute(
            select(Relationship).where(Relationship.conversation_id == uuid.UUID(conversation_id))
        )
        return list(result.scalars().all())

    async def _detect(self, node_count: int, nodes_block: str, edges_block: str) -> Dict[str, Dict[str, Any]]:
        """Render prompt, call the LLM via the gateway, return the parsed crux map."""
        prompt_text = self.prompt_manager.render_prompt(
            "crux_detection",
            {"node_count": node_count, "nodes_block": nodes_block, "edges_block": edges_block},
        )
        config = await load_llm_config(self.db)
        # The gateway is openai-compatible only; online (Gemini) mode is not
        # reachable from local_chat_json. Fail honestly with a clear message
        # rather than silently posting to a (likely-down) local endpoint.
        if str(config.get("mode") or "").lower() == "online":
            raise CruxConfigurationError(
                "Crux detection runs on a local/openai-compatible LLM and can't use "
                "online (Gemini) mode. Switch the LLM lane to a local engine in "
                "Settings → Active engines, then re-run crux analysis."
            )
        messages = [
            {"role": "system", "content": "You identify cruxes in conversations and return valid JSON only."},
            {"role": "user", "content": prompt_text},
        ]
        data = await local_chat_json(config, messages, temperature=0.2, max_tokens=2048)
        return parse_crux_response(data)

    async def analyze_conversation(self, conversation_id: str, force_reanalysis: bool = False) -> Dict[str, Any]:
        """Run crux detection over the conversation and persist ``is_crux`` flags.

        ``force_reanalysis`` is accepted for API symmetry; an explicit /analyze call
        always re-runs (it is a user-initiated action) and rewrites the flags.
        """
        nodes = await self._load_nodes(conversation_id)
        if not nodes:
            return {"total_nodes": 0, "crux_count": 0, "by_type": {}, "cruxes": []}

        relationships = await self._load_relationships(conversation_id)
        node_count, nodes_block, edges_block = build_detection_inputs(nodes, relationships)

        try:
            crux_map = await self._detect(node_count, nodes_block, edges_block)
        except Exception as exc:  # noqa: BLE001 - never half-write flags on LLM failure
            logger.error("[CRUX] detection failed for conversation %s: %s", conversation_id, exc, exc_info=True)
            return {"total_nodes": len(nodes), "crux_count": 0, "by_type": {}, "cruxes": [], "error": str(exc)}

        analyzed_at = datetime.utcnow().isoformat() + "Z"
        node_results: List[Dict[str, Any]] = []
        for node in nodes:
            meta = crux_map.get(str(node.id))
            node.is_crux = meta is not None
            prefs = dict(node.display_preferences or {})
            if meta is not None:
                prefs["crux"] = {**meta, "analyzed_at": analyzed_at}
                node_results.append({
                    "node_id": str(node.id),
                    "node_name": node.node_name,
                    **meta,
                })
            else:
                prefs.pop("crux", None)
            # Reassign (not in-place mutate) so SQLAlchemy detects the JSONB change.
            node.display_preferences = prefs

        await self.db.commit()
        logger.info("[CRUX] conversation %s: %d/%d nodes flagged as cruxes", conversation_id, len(node_results), len(nodes))
        return _summarize(node_results, len(nodes))

    async def get_conversation_results(self, conversation_id: str) -> Dict[str, Any]:
        """Read back the persisted cruxes for a conversation (no LLM call)."""
        nodes = await self._load_nodes(conversation_id)
        node_results: List[Dict[str, Any]] = []
        for node in nodes:
            if not getattr(node, "is_crux", False):
                continue
            crux = (node.display_preferences or {}).get("crux", {}) if isinstance(node.display_preferences, dict) else {}
            node_results.append({
                "node_id": str(node.id),
                "node_name": node.node_name,
                "crux_type": crux.get("crux_type", "disagreement_pivot"),
                "confidence": crux.get("confidence"),
                "reason": crux.get("reason", ""),
                "analyzed_at": crux.get("analyzed_at"),
            })
        return _summarize(node_results, len(nodes))

    async def get_node_crux(self, node_id: str) -> Dict[str, Any]:
        """Return the crux record for a single node, or None."""
        result = await self.db.execute(select(Node).where(Node.id == uuid.UUID(node_id)))
        node = result.scalar_one_or_none()
        if node is None or not getattr(node, "is_crux", False):
            return None
        crux = (node.display_preferences or {}).get("crux", {}) if isinstance(node.display_preferences, dict) else {}
        return {
            "node_id": str(node.id),
            "node_name": node.node_name,
            "is_crux": True,
            "crux_type": crux.get("crux_type", "disagreement_pivot"),
            "confidence": crux.get("confidence"),
            "reason": crux.get("reason", ""),
            "analyzed_at": crux.get("analyzed_at"),
        }
