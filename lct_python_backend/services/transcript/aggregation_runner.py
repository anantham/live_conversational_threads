"""Resumable source-backed abstraction runner shared by live/import callers.

No production route enables this yet. All source must fit the explicit envelope;
larger conversations need bounded global reconciliation, never summary fallback.
"""
import asyncio
import json

from .aggregation_checkpoint import capture_aggregation, commit_aggregation


class AggregationRunner:
    def __init__(self, *, session_factory, conversation_id, owner_id, envelope):
        self.sessions = session_factory
        self.conversation_id = conversation_id
        self.owner_id = owner_id
        self.envelope = envelope

    async def run_level(self, target_level):
        scope = {"conversation_id": self.conversation_id, "owner_id": self.owner_id}
        async with self.sessions() as db:
            snapshot = await capture_aggregation(db, **scope, target_level=target_level)
        commit_args = {**scope, "snapshot": snapshot, "policy_fingerprint": self.envelope.fingerprint}
        async with self.sessions.begin() as db:
            saved = await commit_aggregation(db, **commit_args, payload=None)
        if saved is not None:
            return saved
        # No transaction/row lock is held while waiting on the provider.
        prompt = json.dumps(snapshot["request"], ensure_ascii=False, separators=(",", ":"))
        result = await asyncio.to_thread(self.envelope.complete_json, prompt)
        async with self.sessions.begin() as db:
            saved = await commit_aggregation(db, **commit_args, payload=result.data)
        return saved

    async def run_through(self, highest_level=5):
        if type(highest_level) is not int or highest_level not in {2, 3, 4, 5}:
            raise ValueError("Highest aggregation tier must be between 2 and 5")
        receipts = []
        for level in range(2, highest_level + 1):
            receipts.append(await self.run_level(level))
        return receipts
