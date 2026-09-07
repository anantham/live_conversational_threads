"""Conversation-local semantic source candidates, never authored relationships.

Only caller-supplied committed source is embedded. Provider consent is applied
before content reaches the gateway; no fallback may change embedding space.
There is no persistent vector store or cross-conversation cache.
"""
import copy
import asyncio
import hashlib
import json
import math

from lct_python_backend.services.deployment_privacy_policy import select_providers_for_privacy
from .conversation_context import ContextBudgetExceeded, conservative_tokens


def normalized_vectors(vectors, expected):
    if len(vectors) != expected or not vectors:
        raise ValueError("Embedding count does not match source count")
    dimension = len(vectors[0])
    result = []
    for vector in vectors:
        if not dimension or len(vector) != dimension or not all(
            type(value) in (int, float) and math.isfinite(value) for value in vector
        ):
            raise ValueError("Invalid embedding dimension or values")
        norm = math.sqrt(sum(value * value for value in vector))
        if not norm or not math.isfinite(norm):
            raise ValueError("Invalid embedding norm")
        result.append([value / norm for value in vector])
    return result


class SemanticCandidates:
    def __init__(self, *, providers, privacy, embed_batch=None,
                 input_token_budget=8192, batch_token_budget=32768,
                 count_tokens=conservative_tokens):
        if (type(input_token_budget) is not int or type(batch_token_budget) is not int
                or not 0 < input_token_budget <= batch_token_budget):
            raise ValueError("Invalid embedding input/batch budget")
        allowed = copy.deepcopy(select_providers_for_privacy(providers, privacy))
        # A fallback with an identical model label can still be a different
        # model build. Pin one provider for this complete retrieval request.
        self._provider = allowed[0]
        if not self._provider.get("embedding_model"):
            raise ValueError("Explicit embedding_model required")
        self._provider["strict_embedding_response"] = True
        self._input_budget = input_token_budget
        self._batch_budget = batch_token_budget
        self._count_tokens = count_tokens
        self._cache = {}
        self._lock = asyncio.Lock()
        identity = {key: self._provider.get(key) for key in
                    ("id", "base_url", "embedding_model", "embedding_model_revision", "trust_scope")}
        identity.update({"retrieval_version": 1, "input_budget": input_token_budget,
                         "batch_budget": batch_token_budget})
        self.fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        if embed_batch is None:
            from lct_python_backend.services.llm_gateway import gateway
            embed_batch = gateway().embed_batch
        self._embed_batch = embed_batch

    @property
    def providers(self):
        """Frozen content recipients for fresh stored-consent checks."""
        return [copy.deepcopy(self._provider)]

    async def rank(self, current_passage, source_chunks):
        # This instance belongs to one processor/conversation. Snapshot before
        # awaiting and serialize updates so failures cannot partially publish
        # a cache generation. Store hashes/vectors, not another copy of source.
        chunks = dict(source_chunks)
        async with self._lock:
            return await self._rank(current_passage, chunks)

    async def _rank(self, current_passage, source_chunks):
        if not source_chunks:
            self._cache.clear()
            return {}
        identities = list(source_chunks)
        hashes = {cid: hashlib.sha256(text.encode()).hexdigest() for cid, text in source_chunks.items()}
        retained = {cid: cached for cid, cached in self._cache.items()
                    if cid in hashes and cached[0] == hashes[cid]}
        # Drop withdrawn/changed entries even when the next request fails.
        self._cache = retained
        missing = [cid for cid in identities if cid not in retained]
        texts = [source_chunks[cid] for cid in missing]
        texts.append("Instruct: Retrieve the earlier conversation passage relevant to this later remark.\nQuery: " + current_passage)
        costs = [self._count_tokens(text) for text in texts]
        if any(type(cost) is not int or cost < 0 or cost > self._input_budget for cost in costs):
            raise ContextBudgetExceeded("Embedding input exceeds configured budget; split before retrieval")
        batches, batch, total = [], [], 0
        for text, cost in zip(texts, costs):
            if batch and (len(batch) >= 16 or total + cost > self._batch_budget):
                batches.append(batch)
                batch, total = [], 0
            batch.append(text)
            total += cost
        if batch:
            batches.append(batch)
        vectors = []
        for batch in batches:
            result = await self._embed_batch(batch, providers=[copy.deepcopy(self._provider)])
            vectors.extend(normalized_vectors(result, len(batch)))
        vectors = normalized_vectors(vectors, len(texts))
        query = vectors[-1]
        if any(len(cached[1]) != len(query) for cached in retained.values()):
            raise ValueError("Embedding dimension changed against committed cache")
        updated = dict(retained)
        updated.update({cid: (hashes[cid], vector) for cid, vector in zip(missing, vectors[:-1])})
        self._cache = updated
        return {identity: sum(a * b for a, b in zip(query, vector))
                for identity, (_, vector) in updated.items()}
