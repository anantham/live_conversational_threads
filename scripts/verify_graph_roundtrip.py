"""Verify the segment-and-stitch resume persist preserves the prior segment.

Segment-and-stitch pause/resume re-attaches a new recording to an existing
conversation_id. The danger: ``persist_graph`` is destructive — it DELETEs every
Node/Relationship row for the conversation before re-INSERTing. A naive resume
would wipe the prior segment's graph.

The fix (see ``persist_graph``'s ``protect_node_ids`` param): on resume, the
prior segment's node ids are passed as ``protect_node_ids`` and the delete is
scoped to *exclude* them. The prior segment is frozen — never deleted, never
reconstructed.

An earlier version of this script proved the *rejected* approach was unsafe:
reconstructing the prior segment via ``build_graph_data_from_nodes`` and letting
the destructive persist "self-correct" loses ~3% of relationships per cycle
(``build_graph_data_from_nodes`` folds edges into singular predecessor/successor
fields). That finding stands — see commit c0c4e4a. This script now verifies the
shipped fix instead.

What it does (never touches a real conversation destructively):
  1. Reconstruct the largest real conversation's graph -> id-remapped "segment 1".
  2. persist_graph it FRESH (protect_node_ids=None) into a throwaway conversation.
  3. Snapshot segment 1's node ids + every relationship row (id + all fields).
  4. Build a synthetic "segment 2" (fresh, disjoint ids).
  5. persist_graph segment 2 with protect_node_ids = segment 1's ids — twice,
     simulating two live-flush persists of the resumed session.
  6. After each, assert segment 1 is byte-identical: every node id present,
     every relationship row present with an UNCHANGED id and unchanged fields
     (an unchanged relationship id proves the row was never deleted).
  7. Assert segment 2's nodes landed and conv.total_nodes == seg1 + seg2.
  8. Delete the throwaway. The source conversation is only ever READ.

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

# A synthetic segment 2 produces exactly this many relationships:
# seg2-A --successor--> seg2-B  (1 temporal)
# seg2-B --contextual-> seg2-C  (1 contextual)
SEG2_EXPECTED_RELS = 2


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
    """Give every node a fresh uuid, consistently rewriting every field that
    references a node id (parent_id, children_ids, predecessor, successor,
    linked_nodes, ...). Needed because node ids are a GLOBAL primary key —
    seeding a throwaway conversation with a real graph's ids would collide
    with the source rows."""
    id_map = {_node_id(n): str(uuid.uuid4()) for n in graph if _node_id(n)}

    def _remap_value(value: Any) -> Any:
        if isinstance(value, str):
            return id_map.get(value, value)
        if isinstance(value, list):
            return [_remap_value(v) for v in value]
        return value

    return [{k: _remap_value(v) for k, v in node.items()} for node in graph]


def _build_seg2_graph() -> List[Dict[str, Any]]:
    """A synthetic 'segment 2' — 3 fresh nodes + 2 relationships among them
    (A->B temporal via successor, B->C contextual). Fresh uuids, disjoint
    from segment 1 (the resume path never seeds segment-2 ids from the DB)."""
    a, b, c = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    return [
        {"id": a, "node_name": "seg2-A", "summary": "segment 2 node A",
         "level": 1, "successor": "seg2-B"},
        {"id": b, "node_name": "seg2-B", "summary": "segment 2 node B",
         "level": 1, "contextual_relation": {"seg2-C": "B relates to C"}},
        {"id": c, "node_name": "seg2-C", "summary": "segment 2 node C",
         "level": 1},
    ]


def _snapshot_rels(rels) -> Dict[Any, tuple]:
    """Map each Relationship row to a comparable tuple, keyed by its id. An
    unchanged id across a re-persist proves the row was never deleted +
    re-inserted (persist_graph mints a fresh uuid for every relationship it
    writes)."""
    return {
        r.id: (
            r.from_node_id, r.to_node_id, r.relationship_type,
            r.relationship_subtype, r.explanation, r.strength, r.confidence,
        )
        for r in rels
    }


async def _check_after_resume(
    db, throwaway, seg1_node_ids: set, seg1_rels: Dict[Any, tuple],
    seg2_ids: set, label: str,
) -> List[str]:
    """Re-fetch the throwaway and assert segment 1 is intact + segment 2 landed."""
    problems: List[str] = []
    conv, nodes, rels, _ = await fetch_conversation_bundle(db, throwaway)
    node_ids_now = {n.id for n in nodes}
    rels_now = _snapshot_rels(rels)

    lost_nodes = seg1_node_ids - node_ids_now
    if lost_nodes:
        problems.append(f"[{label}] {len(lost_nodes)} segment-1 node(s) LOST")

    missing_seg2 = seg2_ids - node_ids_now
    if missing_seg2:
        problems.append(f"[{label}] {len(missing_seg2)} segment-2 node(s) missing")

    for rid, fields in seg1_rels.items():
        if rid not in rels_now:
            problems.append(
                f"[{label}] segment-1 relationship {str(rid)[:8]} LOST "
                f"(id no longer in DB — row was deleted)"
            )
        elif rels_now[rid] != fields:
            problems.append(
                f"[{label}] segment-1 relationship {str(rid)[:8]} MUTATED "
                f"{fields} -> {rels_now[rid]}"
            )

    expected_total = len(seg1_node_ids) + len(seg2_ids)
    if conv is not None and conv.total_nodes != expected_total:
        problems.append(
            f"[{label}] conv.total_nodes={conv.total_nodes}, "
            f"expected {expected_total}"
        )

    print(
        f"  {label}: {len(node_ids_now)} nodes "
        f"({len(seg1_node_ids)} seg1 + {len(seg2_ids)} seg2), "
        f"{len(rels_now)} rels (seg1 had {len(seg1_rels)}, seg2 adds "
        f"{SEG2_EXPECTED_RELS}), total_nodes={getattr(conv, 'total_nodes', '?')}"
    )
    return problems


async def main() -> int:
    async with get_async_session_context() as db:
        # 1. Source = real conversation with the most nodes (read-only).
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
        seg1_graph = _remap_ids(_flatten(build_graph_data_from_nodes(nodes_a, rels_a)))
        print(f"Source conversation {source_id} ({row[1]} nodes) — read-only")
        print(f"Reconstructed + id-remapped segment 1: {len(seg1_graph)} nodes")

        throwaway = uuid.uuid4()
        print(f"Throwaway conversation: {throwaway}")
        problems: List[str] = []
        try:
            # 2. Persist segment 1 FRESH (protect_node_ids=None) — this stands
            #    in for "segment 1 already recorded".
            await persist_graph(
                db=db, conversation_id=str(throwaway), existing_json=seg1_graph,
                conversation_name="roundtrip-verify seg1 (delete me)",
                source_type="roundtrip_test", source_metadata={},
            )
            await db.commit()

            # 3. Snapshot segment 1's exact DB state.
            _c, n1, r1, _ = await fetch_conversation_bundle(db, throwaway)
            seg1_node_ids = {n.id for n in n1}
            seg1_rels = _snapshot_rels(r1)
            print(f"Segment 1 persisted: {len(seg1_node_ids)} nodes, {len(seg1_rels)} relationships")

            # 4. Synthetic segment 2 (fresh ids, disjoint from segment 1).
            seg2_graph = _build_seg2_graph()
            seg2_ids = {uuid.UUID(_node_id(n)) for n in seg2_graph}

            # 5. RESUME PERSIST #1 — scoped: freeze segment 1.
            await persist_graph(
                db=db, conversation_id=str(throwaway), existing_json=seg2_graph,
                protect_node_ids=seg1_node_ids,
                conversation_name="roundtrip-verify (delete me)",
                source_type="roundtrip_test", source_metadata={},
            )
            await db.commit()
            problems += await _check_after_resume(
                db, throwaway, seg1_node_ids, seg1_rels, seg2_ids,
                "after resume-persist #1",
            )

            # 6. RESUME PERSIST #2 — a second live-flush of the resumed
            #    session. The old destructive path would have re-minted every
            #    relationship id here; the scoped path must not touch segment 1.
            await persist_graph(
                db=db, conversation_id=str(throwaway), existing_json=seg2_graph,
                protect_node_ids=seg1_node_ids,
                conversation_name="roundtrip-verify (delete me)",
                source_type="roundtrip_test", source_metadata={},
            )
            await db.commit()
            problems += await _check_after_resume(
                db, throwaway, seg1_node_ids, seg1_rels, seg2_ids,
                "after resume-persist #2",
            )
        finally:
            # 7. Always delete the throwaway — even on assertion failure.
            await db.execute(delete(Relationship).where(Relationship.conversation_id == throwaway))
            await db.execute(delete(Node).where(Node.conversation_id == throwaway))
            await db.execute(delete(Conversation).where(Conversation.id == throwaway))
            await db.commit()
            print(f"Cleaned up throwaway {throwaway}")

    print()
    if not problems:
        print("=" * 64)
        print("PASS — the scoped resume persist preserves the prior segment")
        print("byte-identical across repeated live-flush persists. Every")
        print("segment-1 node and relationship row survived with an unchanged")
        print("id. Segment-and-stitch resume does not erode the prior graph.")
        print("=" * 64)
        return 0

    print("=" * 64)
    print(f"FAIL — the resume persist corrupted the prior segment ({len(problems)} problem(s)):")
    for p in problems[:20]:
        print(f"  - {p}")
    if len(problems) > 20:
        print(f"  ... and {len(problems) - 20} more")
    print("=" * 64)
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
