"""Backfill node.speaker_info from chunk summaries + thread aggregation.

For chunk nodes (level=1): regex-extract "Speaker A|B|C..." mentions from summary.
For higher tiers: aggregate from chunks in the same thread_id.
"""

import asyncio
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Dict, Optional

from dotenv import load_dotenv
from sqlalchemy import select, update

load_dotenv(Path(__file__).parent.parent / "lct_python_backend" / ".env")

sys.path.insert(0, str(Path(__file__).parent.parent))

from lct_python_backend.db_session import get_async_session_context  # noqa: E402
from lct_python_backend.models import Node  # noqa: E402


SPEAKER_RE = re.compile(r"[Ss]peaker\s+([A-Z]{1,3}(?:_\d+)?)\b")


def extract_speakers_from_text(text: str) -> Counter:
    if not text:
        return Counter()
    return Counter(SPEAKER_RE.findall(text))


async def backfill(conversation_id: str, apply: bool) -> None:
    async with get_async_session_context() as db:
        result = await db.execute(
            select(Node).where(Node.conversation_id == conversation_id)
        )
        nodes = list(result.scalars().all())
        print(f"[backfill] loaded {len(nodes)} nodes for {conversation_id}")

        # Pass 1: chunks (level=1) -- extract from summary + node_name
        chunk_counts_by_thread: Dict[Optional[str], Counter] = {}
        chunk_updates: Dict[str, dict] = {}
        for node in nodes:
            if node.level != 1:
                continue
            counts = extract_speakers_from_text((node.summary or "") + " " + (node.node_name or ""))
            if not counts:
                continue
            primary = counts.most_common(1)[0][0]
            chunk_updates[str(node.id)] = {
                "primary_speaker": primary,
                "speaker_distribution": dict(counts),
            }
            thread = (node.cluster_info or {}).get("thread_id") if isinstance(node.cluster_info, dict) else None
            chunk_counts_by_thread.setdefault(thread, Counter()).update(counts)

        # Pass 2: higher tiers -- inherit from their thread's chunks
        higher_updates: Dict[str, dict] = {}
        for node in nodes:
            if node.level == 1:
                continue
            thread = (node.cluster_info or {}).get("thread_id") if isinstance(node.cluster_info, dict) else None
            counts = chunk_counts_by_thread.get(thread)
            if not counts:
                # Fall back: parse own summary in case the higher-tier text also mentions speaker
                counts = extract_speakers_from_text((node.summary or "") + " " + (node.node_name or ""))
            if not counts:
                continue
            primary = counts.most_common(1)[0][0]
            higher_updates[str(node.id)] = {
                "primary_speaker": primary,
                "speaker_distribution": dict(counts),
            }

        print(f"[backfill] computed speaker_info for {len(chunk_updates)} chunks + {len(higher_updates)} higher-tier nodes")
        sample = list(chunk_updates.items())[:3]
        for nid, info in sample:
            print(f"  sample chunk {nid[:8]} -> {info}")

        if not apply:
            print("[backfill] DRY RUN -- pass --apply to write to DB")
            return

        for nid, info in {**chunk_updates, **higher_updates}.items():
            await db.execute(
                update(Node).where(Node.id == nid).values(speaker_info=info)
            )
        await db.commit()
        print(f"[backfill] wrote speaker_info to {len(chunk_updates) + len(higher_updates)} nodes")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("conversation_id")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    asyncio.run(backfill(args.conversation_id, args.apply))
