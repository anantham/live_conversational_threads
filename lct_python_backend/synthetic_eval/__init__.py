"""Synthetic-conversation evaluation harness (Tier 1: graph-gen / dimension extraction).

This package generates and scores FAKE conversations so LCT's transcript -> graph
extraction can be stress-tested against external/frontier LLM providers WITHOUT
ever shipping real conversation data to the cloud.

Why this is safe (the isolation argument):
  * The harness is a standalone process. It never starts the FastAPI app and never
    connects to the real Postgres database, so the production egress chokepoint and
    the real conversation corpus are both out of reach.
  * It only ever processes hand-authored / model-generated SYNTHETIC transcripts that
    carry no private data.
  * Because the data is synthetic, it deliberately sets ``LCT_LOCAL_ONLY=0`` for its
    own process so frontier providers (OpenAI / OpenRouter / Gemini) can be exercised.
    See ``providers.py`` for the loud banner and the opt-in.

The payoff over real data: because every planted crux / tangent / rebuttal / claim is
AUTHORED, we have ground truth and can finally measure extraction precision / recall /
F1 objectively — which is impossible on un-labelled real conversations.
"""

from lct_python_backend.synthetic_eval.schema import (  # noqa: F401
    Claim,
    Edge,
    GroundTruth,
    SyntheticConversation,
    Turn,
    load_conversation,
    load_all_conversations,
)

__all__ = [
    "Claim",
    "Edge",
    "GroundTruth",
    "SyntheticConversation",
    "Turn",
    "load_conversation",
    "load_all_conversations",
]
