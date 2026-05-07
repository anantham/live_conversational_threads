"""One-shot backfill: re-persist saved conversation JSONs to recover the
LLM-authored ``semantic_level`` / ``semantic_type`` that the previous
``persist_graph`` flattened to ``level=1`` for every node.

Background
----------
ADR-030 §P5 mandates the backend honour LLM-authored hierarchy. Until
commit ``b59563d`` shipped the level-honour fix in ``graph_persistence``,
every Node row was written with ``level=1`` regardless of what the LLM
actually produced. The saved JSON snapshots in
``outputs/saved_conversations/{conversation_id}.json`` preserve the
original LLM output — including the ``semantic_level``/``semantic_type``
fields — so the data is recoverable.

This script re-runs ``persist_graph`` against each conversation's saved
snapshot. The persist function is idempotent: it deletes existing
``Node`` / ``Relationship`` rows for the conversation, then re-writes
from the snapshot with proper levels.

Usage
-----
    .venv/Scripts/python scripts/backfill_authored_levels.py --dry-run
    .venv/Scripts/python scripts/backfill_authored_levels.py --apply

Always do --dry-run first. The dry-run mode reports what *would* change
(nodes-by-level distribution before vs after) without touching the DB.

Safety
------
- Skips conversations whose saved JSON has no ``semantic_level`` on any
  node (nothing to restore).
- Skips conversations whose DB rows already show levels > 1
  (already-backfilled — re-running would be a no-op but still costs a
  delete+insert; skip it).
- The saved JSON files are the canonical backup; persist is destructive
  but only on the conversation's own rows.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional

# Load DATABASE_URL etc. from lct_python_backend/.env before any of the
# backend modules are imported (db_session.py reads DATABASE_URL at
# module top-level).
try:
    from dotenv import load_dotenv  # type: ignore
    _ENV_PATH = Path(__file__).resolve().parent.parent / "lct_python_backend" / ".env"
    if _ENV_PATH.exists():
        load_dotenv(_ENV_PATH)
except ImportError:
    pass


def _load_snapshot(conv_id: str) -> Optional[List[Dict[str, Any]]]:
    """Return the flat node list from the conversation's saved JSON, or
    None if the file doesn't exist or has no graph data."""
    path = Path("outputs/saved_conversations") / f"{conv_id}.json"
    if not path.exists():
        return None
    try:
        body = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"  ! failed to parse {path}: {exc}", flush=True)
        return None
    raw = body.get("graph_data") or []
    if not raw:
        return None
    flat = raw[0] if isinstance(raw[0], list) else raw
    if not isinstance(flat, list):
        return None
    return [n for n in flat if isinstance(n, dict)]


def _has_authored_levels(nodes: List[Dict[str, Any]]) -> bool:
    """True iff at least one node carries an explicit semantic_level > 1.
    A snapshot with all level=1 is either truly chunks-only or pre-
    hierarchy; either way re-persisting wouldn't change anything."""
    for n in nodes:
        sl = n.get("semantic_level")
        if isinstance(sl, int) and sl > 1:
            return True
    return False


async def main(apply: bool) -> int:
    # Lazy imports so importing this script doesn't trigger backend init
    # in environments where DATABASE_URL isn't set.
    from sqlalchemy import select, func as sql_func
    from lct_python_backend.db_session import get_async_session_context
    from lct_python_backend.models import Conversation, Node
    from lct_python_backend.services.graph_persistence import persist_graph

    print(f"[BACKFILL] mode={'APPLY' if apply else 'DRY-RUN'}")

    async with get_async_session_context() as db:
        result = await db.execute(
            select(Conversation).where(Conversation.deleted_at.is_(None))
        )
        conversations = list(result.scalars().all())

    print(f"[BACKFILL] {len(conversations)} conversation(s) found")
    affected = 0
    skipped_no_snapshot = 0
    skipped_no_levels = 0
    skipped_already_done = 0

    for conv in conversations:
        conv_id = str(conv.id)
        snapshot_nodes = _load_snapshot(conv_id)
        if snapshot_nodes is None:
            skipped_no_snapshot += 1
            continue
        if not _has_authored_levels(snapshot_nodes):
            skipped_no_levels += 1
            continue

        # Check current DB state to skip already-backfilled rows.
        async with get_async_session_context() as db:
            res = await db.execute(
                select(Node.level, sql_func.count(Node.id))
                .where(Node.conversation_id == conv.id)
                .group_by(Node.level)
            )
            current_levels = {int(level): int(count) for level, count in res.all()}

        if any(level > 1 for level in current_levels.keys()):
            skipped_already_done += 1
            print(
                f"  - {conv_id} ({conv.conversation_name[:40]!r}): "
                f"already has levels {sorted(current_levels)} — skipping"
            )
            continue

        # Compute snapshot level distribution for the report.
        snapshot_levels = Counter(int(n.get("semantic_level") or 1) for n in snapshot_nodes)
        print(
            f"  + {conv_id} ({conv.conversation_name[:40]!r}): "
            f"current={sorted(current_levels.items())} -> snapshot={sorted(snapshot_levels.items())}"
        )
        affected += 1

        if not apply:
            continue

        # APPLY: re-persist through the now-fixed path.
        async with get_async_session_context() as db:
            try:
                persisted = await persist_graph(
                    db=db,
                    conversation_id=conv_id,
                    existing_json=snapshot_nodes,
                    conversation_name=conv.conversation_name,
                    source_type=conv.source_type,
                    source_metadata=conv.source_metadata or {},
                )
                print(f"    re-persisted {persisted} nodes")
            except Exception as exc:  # noqa: BLE001
                print(f"    !! re-persist failed: {exc}")

    print()
    print(f"[BACKFILL] summary:")
    print(f"  conversations: {len(conversations)}")
    print(f"  would-update / updated: {affected}")
    print(f"  skipped (no snapshot file): {skipped_no_snapshot}")
    print(f"  skipped (snapshot has no authored levels): {skipped_no_levels}")
    print(f"  skipped (already has levels > 1): {skipped_already_done}")
    if not apply and affected > 0:
        print(f"\n  re-run with --apply to actually persist the changes")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument(
        "--apply", action="store_true",
        help="Actually persist changes. Without this flag, the script only reports.",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Explicit dry-run flag (default behaviour without --apply).",
    )
    args = parser.parse_args()
    if args.apply and args.dry_run:
        print("ERROR: --apply and --dry-run are mutually exclusive", file=sys.stderr)
        sys.exit(2)
    sys.exit(asyncio.run(main(apply=args.apply)))
