"""Verify the DB-graph <-> existing_json round-trip is lossless.

Segment-and-stitch pause/resume depends on this: when a recording resumes,
the backend reconstructs the prior segment's graph from DB Node rows and
seeds the new session's TranscriptProcessor. The session's `persist_graph`
then does a destructive DELETE-all + re-INSERT. That's only SAFE if

    DB nodes  ->  build_graph_data_from_nodes  ->  persist_graph  ->  DB nodes

preserves every node (id, level, structure, relationships). If it's lossy,
every pause/resume silently corrupts the prior segment's graph.

This script proves it WITHOUT risking a real conversation:
  1. Pick the real conversation with the most nodes as the source graph.
  2. Reconstruct it to the existing_json shape (build_graph_data_from_nodes).
  3. persist_graph it into a fresh THROWAWAY conversation_id.
  4. Read the throwaway back, reconstruct again.
  5. Diff. Report PASS/FAIL with specifics.
  6. Delete the throwaway. The source conversation is only ever READ.

Run:  .venv/Scripts/python.exe scripts/verify_graph_roundtrip.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

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


# Fields whose change would mean real graph corruption. Derived fields like
# timestamps (build_graph_data_from_nodes backfills them from utterances —
# absent here since the throwaway has no utterances) are NOT compared.
COMPARED_FIELDS = ["level", "name", "summary", "title", "chunk_id"]


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


def _diff(graph_a: List[Dict[str, Any]], graph_b: List[Dict[str, Any]]) -> List[str]:
    """Return a list of human-readable problems. Empty list == lossless."""
    problems: List[str] = []

    a_by_id = {_node_id(n): n for n in graph_a if _node_id(n)}
    b_by_id = {_node_id(n): n for n in graph_b if _node_id(n)}

    if len(a_by_id) != len(graph_a):
        problems.append(
            f"source: {len(graph_a)} nodes but only {len(a_by_id)} unique ids "
            f"(some nodes have no id)"
        )
    if len(b_by_id) != len(graph_b):
        problems.append(
            f"round-tripped: {len(graph_b)} nodes but only {len(b_by_id)} unique ids"
        )

    missing = set(a_by_id) - set(b_by_id)
    extra = set(b_by_id) - set(a_by_id)
    if missing:
        problems.append(
            f"{len(missing)} node id(s) LOST in the round-trip — "
            f"e.g. {list(missing)[:3]}"
        )
    if extra:
        problems.append(
            f"{len(extra)} node id(s) APPEARED (ids not preserved — "
            f"persist_graph minted new ones) — e.g. {list(extra)[:3]}"
        )

    # Field-level drift on the ids that DID survive.
    for nid in set(a_by_id) & set(b_by_id):
        a, b = a_by_id[nid], b_by_id[nid]
        for field in COMPARED_FIELDS:
            if a.get(field) != b.get(field):
                problems.append(
                    f"node {nid[:8]}: field '{field}' changed "
                    f"{a.get(field)!r} -> {b.get(field)!r}"
                )

    return problems


def _remap_ids(graph: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Give every node a fresh uuid, consistently rewriting every field that
    references a node id (parent_id, children_ids, predecessor, successor,
    linked_nodes, ...). Needed because node ids are a GLOBAL primary key —
    seeding a throwaway conversation with a real graph's ids would collide
    with the source rows. After remapping, the graph is structurally
    identical but id-disjoint from anything in the DB."""
    id_map = {_node_id(n): str(uuid.uuid4()) for n in graph if _node_id(n)}

    def _remap_value(value: Any) -> Any:
        if isinstance(value, str):
            return id_map.get(value, value)
        if isinstance(value, list):
            return [_remap_value(v) for v in value]
        return value

    remapped: List[Dict[str, Any]] = []
    for node in graph:
        new_node = {k: _remap_value(v) for k, v in node.items()}
        remapped.append(new_node)
    return remapped


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
        source_id, source_node_count = row[0], row[1]
        print(f"Source conversation: {source_id} ({source_node_count} nodes) — read-only")

        _conv, nodes_a, rels_a, _utts = await fetch_conversation_bundle(db, source_id)
        source_graph = _flatten(build_graph_data_from_nodes(nodes_a, rels_a))
        print(f"Reconstructed source graph: {len(source_graph)} nodes, {len(rels_a)} rels")
        if source_graph:
            print(f"  node-dict keys: {sorted(source_graph[0].keys())}")

        # 2. Remap ids so the test graph is id-disjoint from the source.
        seg1 = _remap_ids(source_graph)

        throwaway = uuid.uuid4()
        print(f"Throwaway conversation: {throwaway}")
        problems: List[str] = []
        rel_delta = 0
        r1_count = 0
        r2_count = 0
        try:
            # 3. Seed the throwaway — this stands in for "segment 1 already
            #    recorded". persist_graph creates the conversation row.
            await persist_graph(
                db=db, conversation_id=str(throwaway), existing_json=seg1,
                conversation_name="roundtrip-verify (delete me)",
                source_type="roundtrip_test", source_metadata={},
            )
            await db.commit()

            # 4. Reconstruct it — this is what resume does to seed the
            #    resumed session's processor.
            _c1, n1, r1, _ = await fetch_conversation_bundle(db, throwaway)
            graph_e1 = _flatten(build_graph_data_from_nodes(n1, r1))
            print(f"After seed:        {len(graph_e1)} nodes, {len(r1)} rels")

            # 5. THE RESUME MECHANIC: re-persist the reconstructed graph back
            #    into the SAME conversation (segment 2's persist_graph call,
            #    minus the appended new nodes — which are just more INSERTs).
            await persist_graph(
                db=db, conversation_id=str(throwaway), existing_json=graph_e1,
                conversation_name="roundtrip-verify (delete me)",
                source_type="roundtrip_test", source_metadata={},
            )
            await db.commit()

            # 6. Reconstruct again + diff against the post-seed state.
            _c2, n2, r2, _ = await fetch_conversation_bundle(db, throwaway)
            graph_e2 = _flatten(build_graph_data_from_nodes(n2, r2))
            print(f"After re-persist:  {len(graph_e2)} nodes, {len(r2)} rels")

            problems = _diff(graph_e1, graph_e2)
            r1_count, r2_count = len(r1), len(r2)
            rel_delta = r1_count - r2_count
        finally:
            # 7. Always delete the throwaway — even on diff failure.
            await db.execute(delete(Relationship).where(Relationship.conversation_id == throwaway))
            await db.execute(delete(Node).where(Node.conversation_id == throwaway))
            await db.execute(delete(Conversation).where(Conversation.id == throwaway))
            await db.commit()
            print(f"Cleaned up throwaway {throwaway}")

    print()
    if rel_delta != 0:
        problems.append(
            f"relationship count dropped by {rel_delta} on a single re-persist "
            f"({r1_count} -> {r2_count}) — build_graph_data_from_nodes does not "
            f"round-trip all relationships"
        )

    if not problems:
        print("=" * 60)
        print("PASS — round-trip is lossless. Seeding the resumed processor")
        print("with build_graph_data_from_nodes is SAFE.")
        print("=" * 60)
        return 0

    print("=" * 60)
    print(f"FAIL — round-trip is LOSSY ({len(problems)} problem(s)):")
    for p in problems[:20]:
        print(f"  - {p}")
    if len(problems) > 20:
        print(f"  ... and {len(problems) - 20} more")
    print()
    print("Seeding with build_graph_data_from_nodes is NOT safe as-is —")
    print("a different reconstruction is needed before resume can ship.")
    print("=" * 60)
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
