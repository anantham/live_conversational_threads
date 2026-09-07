"""Frozen, privacy-filtered request contract for the interleaved interpreter.

context_tokens is an explicit per-provider configured limit, NOT an inferred
model capability or a claim of measured effective context. Runtime activation
must verify the serving host's limit. The fallback byte counter is conservative;
an actual tokenizer can be injected and the full message is checked again.
"""
from __future__ import annotations

import copy
import hashlib
import json

from lct_python_backend.services.deployment_privacy_policy import select_providers_for_privacy
from lct_python_backend.services.local_llm_client import chat_with_provider_fallback_sync
from .conversation_context import ContextBudgetExceeded, PassageContextPolicy, conservative_tokens
from .transcript_normalizer import _normalize_generated_output


class InferenceEnvelope:
    def __init__(self, *, system_prompt, providers, privacy, output_tokens, headroom_tokens,
                 temperature=0.3, count_tokens=conservative_tokens):
        allowed = select_providers_for_privacy(providers, privacy)
        capacities = [p.get("context_tokens") for p in allowed]
        if any(type(value) is not int or value <= 0 for value in capacities):
            raise ValueError("Each permitted provider needs an explicit positive context_tokens limit")
        if any(type(value) is not int or value <= 0 for value in (output_tokens, headroom_tokens)):
            raise ValueError("Positive output and protocol headroom reserves are required")
        self._providers = copy.deepcopy(allowed)
        self._privacy = copy.deepcopy(privacy)
        self._system_prompt = str(system_prompt)
        self._output_tokens = output_tokens
        self._headroom_tokens = headroom_tokens
        self._temperature = temperature
        self.count_tokens = count_tokens
        self._context_tokens = min(capacities)
        self.input_token_budget = self._context_tokens - output_tokens - headroom_tokens - self._message_tokens("")
        if self.input_token_budget <= 0:
            raise ContextBudgetExceeded("Instructions and output reserve exhaust the configured context")
        identity = {"system_prompt": self._system_prompt, "output_tokens": output_tokens,
                    "headroom_tokens": headroom_tokens, "temperature": temperature,
                    "providers": [{k: p.get(k) for k in ("id", "model", "model_revision", "base_url", "trust_scope", "context_tokens")}
                                  for p in self._providers]}
        self.fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()

    @property
    def providers(self):
        return copy.deepcopy(self._providers)

    def with_system_prompt(self, system_prompt):
        """New task instructions, same frozen routes, consent and capacity limits."""
        return type(self)(system_prompt=system_prompt, providers=self.providers,
            privacy=self._privacy, output_tokens=self._output_tokens,
            headroom_tokens=self._headroom_tokens, temperature=self._temperature,
            count_tokens=self.count_tokens)

    def context_policy(self, *, passage_target_tokens=None):
        # Count the user content in the same serialized envelope as validate.
        # JSON quoting/backslashes add framing cost that raw prompt counting
        # misses, especially when historical evidence fills the available space.
        return PassageContextPolicy(self.input_token_budget, count_tokens=self.user_message_cost,
                                    passage_target_tokens=passage_target_tokens)

    def user_message_cost(self, prompt):
        return self._message_tokens(prompt) - self._message_tokens("")

    def _messages(self, prompt):
        return [{"role": "system", "content": self._system_prompt}, {"role": "user", "content": prompt}]

    def _message_tokens(self, prompt):
        return self.count_tokens(json.dumps(self._messages(prompt), ensure_ascii=False, separators=(",", ":")))

    def validate(self, prompt):
        measured = self._message_tokens(prompt)
        if measured + self._output_tokens + self._headroom_tokens > self._context_tokens:
            raise ContextBudgetExceeded("Full request plus output/headroom exceeds an allowed provider's context")
        return measured

    def complete_json(self, prompt):
        # Do not widen routes from kwargs supplied by a legacy caller. The
        # admitted provider set and prompt are precisely those budgeted above.
        self.validate(prompt)
        return chat_with_provider_fallback_sync(
            messages=self._messages(prompt), providers=self.providers,
            temperature=self._temperature, max_tokens=self._output_tokens,
            require_json=True, prompt_name="interleaved_conversation", prompt_version=self.fingerprint,
        )
    def generate(self, prompt, **_legacy_kwargs):
        result = self.complete_json(prompt)
        nodes = _normalize_generated_output(result.data)
        if not nodes:
            raise ValueError("Interleaved interpreter returned no valid graph nodes")
        return nodes, result.backend_label()
