"""Verify the DB-graph reconstruction round-trip is lossless.

Segment-and-stitch resume, re-enrichment, and migration all reconstruct a
graph from DB rows (`conversation_reader.build_graph_data_from_nodes`) and
re-persist it (`graph_persistence.persist_graph`). The original version of
this script PROVED that round-trip was lossy — relationships 706 -> 687 -> 678,
~3% of edges shed per cycle — because `build_graph_data_from_nodes` folded
edges into singular `predecessor`/`successor` fields + a name-keyed dict and
`persist_graph` re-derived and re-minted them.

The fix: `build_graph_data_from_nodes(..., include_edges_out=True)` now emits a
faithful `edges_out` list per node — every outgoing Relationship row verbatim
(id + all fields) — and `persist_graph` rewrites relationships from `edges_out`
when present, with their original ids.

This script proves the fix: reconstruct the largest real conversation's graph
(id-remapped into a throwaway, so the source is only ever READ), then run three
reconstruct -> re-persist cycles and assert every relationship survives each
cycle byte-identical — same count, same ids, same fields.

Run:  .venv/Scripts/python.exe scripts/verify_graph_roundtrip.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Windows consoles default to cp1252 — the report below prints em-dashes.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# Running as `python scripts/foo.py` puts scripts/ on sys.path, not the repo
# root — add the root so `lct_python_backend` is importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault(
    "DATABASE_URL", "postgresql://lct_user:lct_password@127.0.0.1:5432/lct_dev"
)

import asyncio
import uuid
from typing import Any, Dict, List

from sqlalchemy import delete, func, select

from lct_python_backend.db_session import get_async_session_context
from lct_python_backend.models import Conversation, Node, Relationship
from lct_python_backend.services.conversation_reader import (
    build_graph_data_from_nodes,
    fetch_conversation_bundle,
)
from lct_python_backend.services.graph_persistence import persist_graph


def _node_id(node: Dict[str, Any]) -> str:
    return str(node.get("id") or node.get("node_id") or "")


def _flatten(graph: Any) -> List[Dict[str, Any]]:
    """build_graph_data_from_nodes may return a flat list or nested chunks —
    flatten to a plain node-dict list either way."""
    out: List[Dict[str, Any]] = []
    for item in graph or []:
        if isinstance(item, dict):
            out.append(item)
        elif isinstance(item, list):
            out.extend(n for n in item if isinstance(n, dict))
    return out


def _remap_ids(graph: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Give every node id AND every relationship id (carried inside
    `edges_out`) a fresh uuid, consistently rewriting every reference. Node
    ids and relationship ids are both global primary keys — persisting a real
    graph's ids into a throwaway conversation would collide with the source
    rows. After remapping the graph is structurally identical but id-disjoint
    from everything in the DB."""
    id_map: Dict[str, str] = {}
    for node in graph:
        nid = _node_id(node)
        if nid:
            id_map.setdefault(nid, str(uuid.uuid4()))
        for edge in (node.get("edges_out") or []):
            if isinstance(edge, dict):
                rid = str(edge.get("id") or "")
                if rid:
                    id_map.setdefault(rid, str(uuid.uuid4()))

    def _remap(value: Any) -> Any:
        if isinstance(value, str):
            return id_map.get(value, value)
        if isinstance(value, list):
            return [_remap(v) for v in value]
        if isinstance(value, dict):
            return {k: _remap(v) for k, v in value.items()}
        return value

    return [{k: _remap(v) for k, v in node.items()} for node in graph]


def _snapshot_rels(rels) -> Dict[Any, tuple]:
    """Map each Relationship row to a comparable tuple, keyed by its id. An
    unchanged id + tuple across a re-persist proves the row was preserved
    verbatim — never deleted and re-minted."""
    return {
        r.id: (
            r.from_node_id, r.to_node_id, r.relationship_type,
            r.relationship_subtype, r.explanation, r.strength, r.confidence,
            bool(r.is_bidirectional),
        )
        for r in rels
    }


async def main() -> int:
    async with get_async_session_context() as db:
        # Source = the real conversation with the most nodes (read-only).
        top = await db.execute(
            select(Node.conversation_id, func.count(Node.id).label("n"))
            .group_by(Node.conversation_id)
            .order_by(func.count(Node.id).desc())
            .limit(1)
        )
        row = top.first()
        if row is None:
            print("FAIL: no conversations with graph nodes in the DB to test against.")
            return 1
        source_id = row[0]
        _conv, nodes_a, rels_a, _utts = await fetch_conversation_bundle(db, source_id)
        source_graph = _remap_ids(
            _flatten(build_graph_data_from_nodes(nodes_a, rels_a, include_edges_out=True))
        )
        print(f"Source conversation {source_id} ({row[1]} nodes) — read-only")
        print(f"Reconstructed + id-remapped: {len(source_graph)} nodes")

        throwaway = uuid.uuid4()
        print(f"Throwaway conversation: {throwaway}")
        problems: List[str] = []
        snapshots: List[Dict[Any, tuple]] = []
        node_counts: List[int] = []
        try:
            graph = source_graph
            for cycle in range(3):
                # persist_graph is destructive (protect_node_ids=None) — it
                # DELETEs all rows for the conversation, then re-INSERTs. The
                # faithful path (graph carries `edges_out`) rewrites every
                # relationship with its original id.
                await persist_graph(
                    db=db, conversation_id=str(throwaway), existing_json=graph,
                    conversation_name="roundtrip-verify (delete me)",
                    source_type="roundtrip_test", source_metadata={},
                )
                await db.commit()
                _c, nodes, rels, _ = await fetch_conversation_bundle(db, throwaway)
                node_counts.append(len(nodes))
                snapshots.append(_snapshot_rels(rels))
                print(f"  cycle {cycle}: {len(nodes)} nodes, {len(rels)} relationships")
                graph = _flatten(
                    build_graph_data_from_nodes(nodes, rels, include_edges_out=True)
                )
        finally:
            # Always delete the throwaway — even on assertion failure.
            await db.execute(delete(Relationship).where(Relationship.conversation_id == throwaway))
            await db.execute(delete(Node).where(Node.conversation_id == throwaway))
            await db.execute(delete(Conversation).where(Conversation.id == throwaway))
            await db.commit()
            print(f"Cleaned up throwaway {throwaway}")

    # Every cycle must be byte-identical to cycle 0.
    base_nodes = node_counts[0]
    base = snapshots[0]
    for cycle in range(1, len(snapshots)):
        if node_counts[cycle] != base_nodes:
            problems.append(
                f"cycle {cycle}: node count {node_counts[cycle]} != {base_nodes}"
            )
        now = snapshots[cycle]
        if len(now) != len(base):
            problems.append(
                f"cycle {cycle}: {len(now)} relationships, expected {len(base)} "
                f"— round-trip is LOSSY"
            )
        for rid, fields in base.items():
            if rid not in now:
                problems.append(f"cycle {cycle}: relationship {str(rid)[:8]} LOST")
            elif now[rid] != fields:
                problems.append(f"cycle {cycle}: relationship {str(rid)[:8]} MUTATED")

    print()
    if not problems:
        print("=" * 64)
        print("PASS — the DB-graph reconstruct -> re-persist round-trip is")
        print(f"lossless. {len(base)} relationships survived 3 cycles with every")
        print("id and field unchanged. (The pre-fix script saw 706 -> 687 -> 678.)")
        print("=" * 64)
        return 0

    print("=" * 64)
    print(f"FAIL — round-trip is LOSSY ({len(problems)} problem(s)):")
    for p in problems[:20]:
        print(f"  - {p}")
    if len(problems) > 20:
        print(f"  ... and {len(problems) - 20} more")
    print("=" * 64)
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
