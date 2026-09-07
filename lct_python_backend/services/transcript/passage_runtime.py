"""Durable passage commit boundary, separate from best-effort notification.

Runtime entry points must explicitly opt in after constructing an owner-scoped
journal. The journal is recovery state; recipient graph materialization still
needs to track its revision before this path may be deployed.
"""
from __future__ import annotations

import copy

from .passage_journal import JournalConflict, append_passage, load_journal, restore_records
from .passage_projection import load_interpretation_projection


class PassageJournalSession:
    def __init__(self, *, session_factory, conversation_id: str, owner_id: str, policy_fingerprint: str,
                 inference_providers=None):
        if not owner_id.strip() or not policy_fingerprint.strip():
            raise ValueError("Owner and policy fingerprint are required")
        self._sessions = session_factory
        self._conversation_id = conversation_id
        self._owner_id = owner_id
        self._policy = policy_fingerprint
        self._inference_providers = copy.deepcopy(inference_providers)
        self._records = []
        self._loaded = False
        self._state = None

    async def _check_consent(self, db):
        if self._inference_providers is not None:
            from .source_inspection_runner import check_inference_consent
            await check_inference_consent(db, conversation_id=self._conversation_id,
                owner_id=self._owner_id, providers=self._inference_providers)

    async def check_consent(self):
        """Fresh owner-bound consent; no transaction remains open during inference."""
        async with self._sessions.begin() as db:
            await self._check_consent(db)

    @property
    def sources(self):
        return {s["id"]: copy.deepcopy(s) for record in self._records for s in record["sources"]}

    async def recover(self):
        if not self._loaded:
            async with self._sessions() as db:
                records = await load_journal(db, conversation_id=self._conversation_id, owner_id=self._owner_id)
                state = await load_interpretation_projection(
                    db, state=restore_records(records), conversation_id=self._conversation_id, owner_id=self._owner_id,
                    source_records=records,
                )
            if any(record["policy_fingerprint"] != self._policy for record in records):
                raise JournalConflict("Restart changed interpretation policy")
            self._records = records
            self._state = state
            self._loaded = True
        return copy.deepcopy(self._state)

    async def refresh_context(self):
        # Refresh once per inference passage, not once per incoming STT turn.
        # Recheck source revisions and ownership together with applied edits.
        self._loaded = False
        return await self.recover()

    async def capture_sources(self, source_ids):
        """Read the exact current source versions before constructing a request."""
        import uuid
        from sqlalchemy import select
        from lct_python_backend.models import Utterance
        from .passage_journal import _authorized_conversation, _source
        async with self._sessions() as db:
            await _authorized_conversation(db, self._conversation_id, self._owner_id, lock=False)
            rows = (await db.execute(select(Utterance).where(
                Utterance.conversation_id == uuid.UUID(self._conversation_id),
                Utterance.id.in_([uuid.UUID(value) for value in source_ids]),
            ).order_by(Utterance.sequence_number))).scalars().all()
            if [str(row.id) for row in rows] != source_ids:
                raise JournalConflict("Inference source IDs are unavailable or unordered")
            return [_source(row) for row in rows]

    async def commit(self, patch):
        if "inference_sources" not in patch:
            raise JournalConflict("Journaled inference requires its captured source snapshot")
        await self.recover()
        expected = len(self._records)
        # On uncertain commit acknowledgement, force a database reread before
        # accepting/retrying further source. Do not assume cancellation rolled
        # the transaction back: it may have reached Postgres already.
        self._loaded = False
        async with self._sessions.begin() as db:
            await self._check_consent(db)
            record = await append_passage(
                db, conversation_id=self._conversation_id, owner_id=self._owner_id,
                expected_revision=expected,
                source_ids=[uid for ids in patch["utterance_chunk_map"].values() for uid in ids],
                patch=patch, policy_fingerprint=self._policy,
            )
            state = await load_interpretation_projection(
                db, state=restore_records([*self._records, record]),
                conversation_id=self._conversation_id, owner_id=self._owner_id,
                source_records=[*self._records, record],
            )
        # Only reached after the context manager successfully commits.
        self._records.append(record)
        self._state = state
        self._loaded = True
        return copy.deepcopy(self._state)


class PassageCommitBoundary:
    def __init__(self, processor, journal):
        self.processor = processor
        self.journal = journal
        self.revision = -1
        self.interpretation_revision = None

    def _apply(self, state):
        p = self.processor
        p.existing_json = copy.deepcopy(state["nodes"])
        p.chunk_dict = copy.deepcopy(state["chunks"])
        p.chunk_utterance_map = copy.deepcopy(state["utterance_chunk_map"])
        self.revision = state["revision"]
        self.interpretation_revision = state.get("interpretation_revision")
        committed = self.journal.sources
        keep = [i for i, ids in enumerate(p.accumulator_utterance_ids)
                if not ids or not all(str(uid) in committed for uid in ids)]
        p.accumulator = [p.accumulator[i] for i in keep]
        p.accumulator_segments = [p.accumulator_segments[i] for i in keep]
        p.accumulator_utterance_ids = [p.accumulator_utterance_ids[i] for i in keep]

    async def recover(self, *, refresh_context=False):
        refresh = getattr(self.journal, "refresh_context", self.journal.recover)
        state = await (refresh() if refresh_context else self.journal.recover())
        if state["revision"] != self.revision or state.get("interpretation_revision") != self.interpretation_revision:
            if self.revision == -1 and self.processor.existing_json:
                raise JournalConflict("Cannot restore journal over an independently seeded graph")
            self._apply(state)

    def should_accept(self, text, utterance_id):
        if not utterance_id:
            raise JournalConflict("Journaled passages require persisted utterance IDs")
        saved = self.journal.sources.get(str(utterance_id))
        if saved is not None:
            if saved["text"] != text:
                raise JournalConflict("Redelivered source differs from committed evidence")
            return False
        for pending, ids in zip(self.processor.accumulator, self.processor.accumulator_utterance_ids):
            if str(utterance_id) in {str(value) for value in ids}:
                if pending != text:
                    raise JournalConflict("Redelivered source differs from pending evidence")
                return False
        return True

    async def commit_and_notify(self, patch, prior_state):
        p = self.processor
        try:
            state = await self.journal.commit(copy.deepcopy(patch))
        except BaseException:
            if prior_state is not None:
                p.existing_json, p.chunk_dict, p.chunk_utterance_map = prior_state
            raise
        self._apply(state)
        old_nodes = {node["id"] for node in prior_state[0]} if prior_state else set()
        old_chunks = set(prior_state[1]) if prior_state else set()
        notification = {
            # Snapshot receipts are internal commit evidence, not graph data.
            **{key: value for key, value in patch.items()
               if key not in {"inference_sources", "inference_context_revision"}},
            "nodes": [n for n in p.existing_json if n["id"] not in old_nodes],
            "chunks": {k: v for k, v in p.chunk_dict.items() if k not in old_chunks},
            "utterance_chunk_map": {k: v for k, v in p.chunk_utterance_map.items() if k not in old_chunks},
            "node_count": len(p.existing_json), "chunk_count": len(p.chunk_dict),
            "committed_revision": self.revision,
        }
        try:
            await p._emit_graph_update(patch=notification)
        except Exception:
            # No source text or provider exception details in this status.
            await p._emit_status("warning", "Passage saved; client notification failed.",
                                 {"stage": "notify", "committed_revision": self.revision})
        # Cancellation may propagate, but committed memory/source consumption
        # above survives it. Restart will restore the same durable revision.
