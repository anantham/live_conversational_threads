"""Claim extraction — self-contained, decontextualized claims + their relations.

Unlike a Node (a segment anchored to specific utterances/speakers/timestamps),
a Claim is a standalone proposition rewritten to stand on its own — understandable
without knowing who said it or when. Like crux detection, this is a **relational**,
graph-level pass: ONE LLM call over the conversation's nodes extracts both the
claims and the supports/contradicts/depends_on edges between them in one shot,
then persists to the ``claims`` table (``models/analysis.py``).

Routed through the shared provider chain (``chat_with_provider_fallback`` over the
``llm_providers`` list) — the same local-only chain the main graph build and crux
detection use.
"""

import logging
import uuid
from typing import Any, Dict, List, Tuple

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from lct_python_backend.models import Node
from lct_python_backend.models.analysis import Claim
from lct_python_backend.services.prompt_manager import get_prompt_manager
from lct_python_backend.services.llm_config import load_llm_providers
from lct_python_backend.services.local_llm_client import chat_with_provider_fallback

logger = logging.getLogger("lct_backend")


CLAIM_TYPES = {"factual", "normative", "worldview"}
RELATION_TYPES = {"supports", "contradicts", "depends_on"}


def _strict_int(value: Any) -> "int | None":
    """Coerce to int only for values that are ACTUALLY integral.

    ``int(1.9)`` silently truncates to ``1`` — for a local claim id that would
    mean a malformed LLM id (e.g. ``1.9``) silently collides with claim id
    ``1`` instead of being rejected. Reject bools too (``isinstance(True, int)``
    is True in Python, but a JSON boolean was never meant to be an id).
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else None
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


# ── pure helpers (LLM-independent — unit tested directly) ────────────────────

def build_extraction_inputs(nodes: List[Any]) -> Tuple[int, str]:
    """Render the nodes block for the claim extraction prompt. Pure / no IO."""
    node_lines = []
    for node in nodes:
        summary = (getattr(node, "summary", "") or "").strip().replace("\n", " ")
        if len(summary) > 200:
            summary = summary[:200] + "…"
        node_lines.append(f"- {node.id}: {getattr(node, 'node_name', '') or 'Untitled'} — {summary}")
    nodes_block = "\n".join(node_lines) if node_lines else "(no nodes)"
    return len(nodes), nodes_block


def parse_claim_response(data: Any) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Normalize the LLM JSON into (claims, relations).

    ``claims`` is a list of dicts keyed by the response's local integer ``id``
    (kept as ``local_id`` on each dict). ``relations`` reference those local ids
    via ``from``/``to``. Defensive: tolerates non-dict input, missing keys, bad
    types, and drops relations whose endpoints don't resolve to an extracted claim.
    """
    if not isinstance(data, dict):
        return [], []

    raw_claims = data.get("claims")
    if not isinstance(raw_claims, list):
        return [], []

    claims: List[Dict[str, Any]] = []
    seen_local_ids = set()
    for entry in raw_claims:
        if not isinstance(entry, dict):
            continue
        claim_text = str(entry.get("claim_text") or "").strip()
        if not claim_text:
            continue
        local_id = _strict_int(entry.get("id"))
        if local_id is None:
            continue
        if local_id in seen_local_ids:
            continue
        seen_local_ids.add(local_id)

        claim_type = str(entry.get("claim_type") or "").strip().lower()
        if claim_type not in CLAIM_TYPES:
            claim_type = "factual"

        def _clamp01(value: Any, default: float) -> float:
            try:
                v = float(value)
            except (TypeError, ValueError):
                return default
            return max(0.0, min(1.0, v))

        claims.append({
            "local_id": local_id,
            "claim_text": claim_text,
            "claim_type": claim_type,
            "source_node_id": str(entry.get("source_node_id") or "").strip() or None,
            "speaker_name": str(entry.get("speaker_name") or "").strip() or None,
            "strength": _clamp01(entry.get("strength"), 0.5),
            "confidence": _clamp01(entry.get("confidence"), 0.5),
        })

    raw_relations = data.get("relations")
    relations: List[Dict[str, Any]] = []
    if isinstance(raw_relations, list):
        for entry in raw_relations:
            if not isinstance(entry, dict):
                continue
            from_id = _strict_int(entry.get("from"))
            to_id = _strict_int(entry.get("to"))
            if from_id is None or to_id is None:
                continue
            if from_id not in seen_local_ids or to_id not in seen_local_ids or from_id == to_id:
                continue
            rel_type = str(entry.get("type") or "").strip().lower()
            if rel_type not in RELATION_TYPES:
                continue
            relations.append({"from": from_id, "to": to_id, "type": rel_type})

    return claims, relations


# ── extractor ────────────────────────────────────────────────────────────────

class ClaimExtractor:
    """Extracts self-contained claims + relations for a conversation, persisting to ``claims``."""

    def __init__(self, db_session: AsyncSession):
        self.db = db_session
        self.prompt_manager = get_prompt_manager()

    async def _load_nodes(self, conversation_id: str) -> List[Node]:
        result = await self.db.execute(
            select(Node).where(Node.conversation_id == uuid.UUID(conversation_id))
        )
        return list(result.scalars().all())

    async def _extract(self, node_count: int, nodes_block: str) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """Render prompt, call the LLM via the gateway, return (claims, relations)."""
        prompt_text = self.prompt_manager.render_prompt(
            "claim_extraction",
            {"node_count": node_count, "nodes_block": nodes_block},
        )
        providers_cfg = await load_llm_providers(self.db, include_secrets=True)
        messages = [
            {"role": "system", "content": "You extract self-contained claims from conversations and return valid JSON only."},
            {"role": "user", "content": prompt_text},
        ]
        provider_result = await chat_with_provider_fallback(
            messages=messages,
            providers=providers_cfg.get("providers"),
            temperature=0.2,
            # Generous budget — a large conversation (100+ nodes) can produce
            # 50+ claims plus their relations in one JSON response; observed
            # empirically that 4096 sometimes truncated/starved output on
            # large graphs, silently yielding zero claims.
            max_tokens=8192,
            require_json=True,
        )
        return parse_claim_response(provider_result.data)

    async def analyze_conversation(self, conversation_id: str, force_reanalysis: bool = False) -> Dict[str, Any]:
        """Run claim extraction over the conversation and persist ``Claim`` rows.

        ``force_reanalysis`` is accepted for API symmetry with the other detectors;
        an explicit /analyze call always re-runs (it is a user-initiated action) and
        replaces any previously persisted claims for this conversation.
        """
        conv_uuid = uuid.UUID(conversation_id)
        nodes = await self._load_nodes(conversation_id)
        if not nodes:
            return {"total_nodes": 0, "claim_count": 0, "relation_count": 0, "claims": []}

        node_count, nodes_block = build_extraction_inputs(nodes)

        try:
            raw_claims, raw_relations = await self._extract(node_count, nodes_block)
        except Exception as exc:  # noqa: BLE001 - never half-write claims on LLM failure
            logger.error("[CLAIMS] extraction failed for conversation %s: %s", conversation_id, exc, exc_info=True)
            return {"total_nodes": len(nodes), "claim_count": 0, "relation_count": 0, "claims": [], "error": str(exc)}

        node_by_id = {str(n.id): n for n in nodes}

        # Clean re-run: drop any previously persisted claims for this conversation
        # before inserting the fresh set. NOTE: argument_trees.root_claim_id and
        # is_ought_conflations.*_claim_id reference claims.id WITHOUT
        # ondelete=CASCADE — currently harmless because nothing in this codebase
        # populates those two tables yet, but a future feature that does would
        # need to either cascade-clear them here too or add the FK ondelete.
        await self.db.execute(delete(Claim).where(Claim.conversation_id == conv_uuid))

        local_id_to_uuid: Dict[int, uuid.UUID] = {}
        db_claims: List[Claim] = []
        by_local_id: Dict[int, Claim] = {}
        for c in raw_claims:
            source_node_id = c["source_node_id"]
            source_node = node_by_id.get(source_node_id)
            node_uuid = source_node.id if source_node is not None else None
            if node_uuid is None:
                # A claim must trace back to a real node for FK integrity —
                # drop ones the model mis-attributed to a nonexistent id.
                continue
            new_id = uuid.uuid4()
            local_id_to_uuid[c["local_id"]] = new_id
            new_claim = Claim(
                id=new_id,
                conversation_id=conv_uuid,
                node_id=node_uuid,
                claim_text=c["claim_text"],
                claim_type=c["claim_type"],
                # Inherit the source node's utterance provenance so a claim can
                # still be traced back to the exact transcript lines it came from.
                utterance_ids=list(source_node.utterance_ids or []),
                speaker_name=c["speaker_name"],
                strength=c["strength"],
                confidence=c["confidence"],
            )
            db_claims.append(new_claim)
            by_local_id[c["local_id"]] = new_claim

        for claim in db_claims:
            self.db.add(claim)
        await self.db.flush()

        # Resolve local-id relations into the real UUID arrays.
        relation_field = {
            "supports": "supports_claim_ids",
            "contradicts": "contradicts_claim_ids",
            "depends_on": "depends_on_claim_ids",
        }
        persisted_relation_count = 0
        for rel in raw_relations:
            from_claim = by_local_id.get(rel["from"])
            to_uuid = local_id_to_uuid.get(rel["to"])
            if from_claim is None or to_uuid is None:
                continue
            field = relation_field[rel["type"]]
            current = list(getattr(from_claim, field) or [])
            if to_uuid not in current:
                current.append(to_uuid)
                setattr(from_claim, field, current)
                persisted_relation_count += 1

        await self.db.commit()
        logger.info(
            "[CLAIMS] conversation %s: extracted %d claims, %d relations",
            conversation_id, len(db_claims), persisted_relation_count,
        )
        return await self.get_conversation_results(conversation_id)

    async def get_conversation_results(self, conversation_id: str) -> Dict[str, Any]:
        """Read back the persisted claims + relations for a conversation (no LLM call)."""
        conv_uuid = uuid.UUID(conversation_id)
        result = await self.db.execute(select(Claim).where(Claim.conversation_id == conv_uuid))
        claims = list(result.scalars().all())

        node_count_result = await self.db.execute(
            select(Node).where(Node.conversation_id == conv_uuid)
        )
        total_nodes = len(list(node_count_result.scalars().all()))

        relation_count = sum(
            len(c.supports_claim_ids or []) + len(c.contradicts_claim_ids or []) + len(c.depends_on_claim_ids or [])
            for c in claims
        )

        return {
            "total_nodes": total_nodes,
            "claim_count": len(claims),
            "relation_count": relation_count,
            "claims": [
                {
                    "id": str(c.id),
                    "claim_text": c.claim_text,
                    "claim_type": c.claim_type,
                    "source_node_id": str(c.node_id),
                    "utterance_ids": [str(x) for x in (c.utterance_ids or [])],
                    "speaker_name": c.speaker_name,
                    "strength": c.strength,
                    "confidence": c.confidence,
                    "supports_claim_ids": [str(x) for x in (c.supports_claim_ids or [])],
                    "contradicts_claim_ids": [str(x) for x in (c.contradicts_claim_ids or [])],
                    "depends_on_claim_ids": [str(x) for x in (c.depends_on_claim_ids or [])],
                }
                for c in claims
            ],
        }
