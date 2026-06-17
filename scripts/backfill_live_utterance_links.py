"""Backfill node<->utterance links for conversations the live STT path left unlinked.

The live STT writer persists ``Utterance`` and ``Node`` rows without linking
them (see ``services/utterance_node_reconciler`` for the why). New live
sessions now reconcile at post-flush; this script repairs conversations
recorded before that fix.

Candidates = conversations that still have unlinked utterances
(``node_id IS NULL``). By default this targets live conversations
(``conversation_type='live_audio'``). Pass ``--imports`` to instead target
import conversations (``transcript``/``text``/``google_meet``): contrary to an
earlier assumption, imports are NOT linked at persist time (the extraction path
authors no ``utterance_ids``), so they need reconciliation too. The reconciler's
chunk-FK pre-pass links them losslessly via ``node.chunk_ids`` ↔
``utterance.chunk_id`` (no source-excerpt text-match required), and is
UPDATE-only/idempotent — it never deletes or re-mints nodes, so manual edits are
preserved.

Usage (from the repo root):
    python scripts/backfill_live_utterance_links.py                  # dry run — live candidates
    python scripts/backfill_live_utterance_links.py --apply          # reconcile live
    python scripts/backfill_live_utterance_links.py --imports        # dry run — import candidates
    python scripts/backfill_live_utterance_links.py --imports --apply  # reconcile imports
"""

from __future__ import annotations

import asyncio
import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

try:
    from dotenv import load_dotenv

    load_dotenv(os.path.join(_REPO_ROOT, "lct_python_backend", ".env"))
except Exception:  # noqa: BLE001 — dotenv optional; env may already be set
    pass


async def main(apply: bool, imports: bool = False) -> int:
    from sqlalchemy import select

    from lct_python_backend.db_session import get_async_session_context
    from lct_python_backend.models import Conversation, Utterance
    from lct_python_backend.services.utterance_node_reconciler import (
        reconcile_conversation_links,
    )

    types = ["transcript", "text", "google_meet"] if imports else ["live_audio"]
    label = "import" if imports else "live"

    async with get_async_session_context() as db:
        rows = await db.execute(
            select(Utterance.conversation_id)
            .join(Conversation, Conversation.id == Utterance.conversation_id)
            .where(Conversation.conversation_type.in_(types))
            .where(Utterance.node_id.is_(None))
            .distinct()
        )
        conv_ids = [r[0] for r in rows]

    print(f"candidate {label} conversations (node_id IS NULL): {len(conv_ids)}")
    for cid in conv_ids:
        print(f"  {cid}")

    if not apply:
        print("\n(dry run — pass --apply to run the reconciler)")
        return 0

    print("\napplying reconciler...")
    ok = 0
    for cid in conv_ids:
        try:
            summary = await reconcile_conversation_links(str(cid))
            print(
                f"  {cid}: linked={summary.get('linked_utterances')}"
                f"/{summary.get('utterances')} (fk={summary.get('fk_linked')}) "
                f"l1_nodes={summary.get('l1_nodes')} "
                f"speaker_info={summary.get('nodes_with_speaker_info')} "
                f"higher={summary.get('higher_tier_nodes')} "
                f"unmatched={summary.get('unmatched_utterances')}"
            )
            ok += 1
        except Exception as exc:  # noqa: BLE001 — keep going; report at the end
            print(f"  {cid}: FAILED — {type(exc).__name__}: {exc}")
    print(f"\ndone: {ok}/{len(conv_ids)} reconciled")
    return 0 if ok == len(conv_ids) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main("--apply" in sys.argv, imports="--imports" in sys.argv)))
