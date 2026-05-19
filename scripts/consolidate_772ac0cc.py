"""Post-streaming consolidation pass for conversation 772ac0cc.

Reads the persisted level-1 chunks + level-2 ideas, runs the three
hierarchy_consolidator passes (ideas->topics, topics->themes, themes->arcs),
then re-persists the whole graph via persist_live_graph_snapshot so the
new tier-3/4/5 nodes land in the DB.

Why this is a separate script: the live STT path doesn't currently call
consolidation (it runs only in import_bulk_pipeline). This script
duplicates that call sequence so we can manually fill the macro tiers
for an already-streamed live conversation.
"""
from __future__ import annotations
import asyncio
import json
import uuid
from pathlib import Path
from typing import Any, Dict, List

from dotenv import load_dotenv

load_dotenv("lct_python_backend/.env")

TARGET_CONV_ID = uuid.UUID("772ac0cc-fde1-4d98-8f68-a1e3a85257c5")
ORIGINAL_NAME = "Learning requires practical application and motivation"
OUT_PATH = Path("scripts/consolidation_observations.json")


async def _load_runtime_providers():
    from lct_python_backend.db_session import get_async_session_context
    from sqlalchemy import text
    async with get_async_session_context() as db:
        r = await db.execute(text("SELECT value FROM app_settings WHERE key='llm_providers'"))
        row = r.fetchone()
        if not row:
            return None
        payload = row[0]
        if isinstance(payload, str):
            payload = json.loads(payload)
        return [p for p in (payload.get("providers") or []) if p.get("enabled")]


def _node_row_to_dict(node) -> Dict[str, Any]:
    """Reconstruct the streaming-LLM-shaped dict from a DB Node row."""
    return {
        "id": str(node.id),
        "node_name": node.node_name,
        "summary": node.summary,
        "chunk_id": str(node.chunk_ids[0]) if node.chunk_ids else None,
        "semantic_level": int(node.level or 1),
        "level": int(node.level or 1),
        "is_bookmark": bool(node.is_bookmark),
        "is_tangent": bool(node.is_tangent),
        "is_contextual_progress": bool(node.is_contextual_progress),
        "thread_id": (node.cluster_info or {}).get("thread_id"),
        "thread_state": (node.cluster_info or {}).get("thread_state"),
        "linked_nodes": (node.cluster_info or {}).get("linked_nodes", []),
        "edge_relations": (node.display_preferences or {}).get("edge_relations", []),
        "utterance_ids": [str(u) for u in (node.utterance_ids or [])],
        "source_excerpt": (node.summary or "")[:200],  # placeholder; not in DB row
    }


async def main() -> None:
    from lct_python_backend.db_session import get_async_session_context
    from lct_python_backend.models import Conversation, Node
    from lct_python_backend.services.hierarchy_consolidator import (
        consolidate_ideas_to_topics,
        consolidate_topics_to_themes,
        consolidate_themes_to_arcs,
    )
    from lct_python_backend.services.graph_persistence import persist_live_graph_snapshot
    from sqlalchemy import select, update

    providers = await _load_runtime_providers()
    print(f"Enabled providers: {[p.get('id') for p in (providers or [])]}")

    async with get_async_session_context() as db:
        r = await db.execute(select(Node).where(Node.conversation_id == TARGET_CONV_ID).order_by(Node.level))
        nodes = list(r.scalars().all())
    by_level: Dict[int, List[Dict[str, Any]]] = {}
    for n in nodes:
        lvl = int(n.level or 1)
        by_level.setdefault(lvl, []).append(_node_row_to_dict(n))
    print(f"Loaded {len(nodes)} nodes: " + ", ".join(f"L{k}={len(v)}" for k, v in sorted(by_level.items())))

    chunks = by_level.get(1, [])
    ideas_in = by_level.get(2, [])

    if not ideas_in:
        print("No level-2 ideas to consolidate; bailing.")
        return

    telemetry: Dict[str, Any] = {"ideas_in": len(ideas_in)}

    print(f"\n[pass 1] Consolidating {len(ideas_in)} ideas -> topics ...")
    import time
    t0 = time.perf_counter()
    topics = await consolidate_ideas_to_topics(ideas_in, providers=providers) or []
    telemetry["topics_out"] = len(topics)
    telemetry["topics_elapsed_s"] = round(time.perf_counter() - t0, 1)
    print(f"  -> {len(topics)} topics in {telemetry['topics_elapsed_s']}s")
    for t in topics[:5]:
        print(f"     L3: {t.get('node_name')}")

    themes = []
    arcs = []
    title = None
    summary = None
    if topics and len(topics) >= 2:
        print(f"\n[pass 2] Consolidating {len(topics)} topics -> themes ...")
        t0 = time.perf_counter()
        themes = await consolidate_topics_to_themes(topics, providers=providers) or []
        telemetry["themes_out"] = len(themes)
        telemetry["themes_elapsed_s"] = round(time.perf_counter() - t0, 1)
        print(f"  -> {len(themes)} themes in {telemetry['themes_elapsed_s']}s")
        for t in themes[:5]:
            print(f"     L4: {t.get('node_name')}")

        if themes and len(themes) >= 2:
            print(f"\n[pass 3] Consolidating {len(themes)} themes -> arcs (+ title/summary) ...")
            t0 = time.perf_counter()
            arcs_result = await consolidate_themes_to_arcs(themes, providers=providers)
            if isinstance(arcs_result, tuple) and len(arcs_result) == 3:
                arcs, title, summary = arcs_result
            else:
                arcs = arcs_result or []
            arcs = arcs or []
            telemetry["arcs_out"] = len(arcs)
            telemetry["arcs_elapsed_s"] = round(time.perf_counter() - t0, 1)
            telemetry["derived_title"] = title
            telemetry["executive_summary_chars"] = len(summary or "")
            print(f"  -> {len(arcs)} arcs in {telemetry['arcs_elapsed_s']}s")
            for t in arcs[:5]:
                print(f"     L5: {t.get('node_name')}")

    # Combine all tiers, normalize semantic_level
    combined: List[Dict[str, Any]] = []
    for n in chunks:
        n["semantic_level"] = 1
        combined.append(n)
    for n in ideas_in:
        n["semantic_level"] = 2
        combined.append(n)
    for n in topics:
        n["semantic_level"] = 3
        combined.append(n)
    for n in themes:
        n["semantic_level"] = 4
        combined.append(n)
    for n in arcs:
        n["semantic_level"] = 5
        combined.append(n)
    print(f"\nCombined node set: {len(combined)} total")

    # Plumb the arcs-pass title + executive summary into source_metadata.
    # The frontend banner (ViewConversation header) reads these via
    # /conversations/{id} → source_metadata.conversation_title /
    # executive_summary (conversations_api.py:165). The whole `metadata`
    # dict passed here becomes the conversation row's source_metadata
    # via persist_live_graph_snapshot → persist_graph (graph_persistence.py:815),
    # so fields go at the TOP level of metadata — wrapping them in a
    # nested "source_metadata" key would double-nest under
    # source_metadata.source_metadata, which is what the first run of this
    # script did and why the banner was blank.
    metadata: Dict[str, Any] = {
        "conversation_name": ORIGINAL_NAME,
        "consolidation_pass": True,
    }
    if title:
        metadata["conversation_title"] = title
    if summary:
        metadata["executive_summary"] = summary

    print("\nRe-persisting with full 5-tier hierarchy...")
    persisted = await persist_live_graph_snapshot(
        conversation_id=str(TARGET_CONV_ID),
        existing_json=combined,
        metadata=metadata,
        source_type="live_audio",
    )
    print(f"persist_live_graph_snapshot returned {persisted} nodes.")
    print(f"Persisted title={title!r}  summary_chars={len(summary or '')}")

    # Restore name + write telemetry
    async with get_async_session_context() as db:
        await db.execute(update(Conversation).where(Conversation.id == TARGET_CONV_ID).values(conversation_name=ORIGINAL_NAME))
        await db.commit()

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(telemetry, f, indent=2, default=str)
    print(f"\nTelemetry written to {OUT_PATH}")
    print(json.dumps(telemetry, indent=2, default=str))


if __name__ == "__main__":
    asyncio.run(main())
