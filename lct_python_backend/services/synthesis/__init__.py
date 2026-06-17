"""Grounded cross-conversation synthesis (PR#1).

Provenance-first synthesis over many conversations: extract claim-units carrying
verbatim quotes, drop any whose quote isn't literally in its source (deterministic
gate), synthesize over only the grounded units, then verify each synthesized point
against the units it cites. Default engine is local ($0, on-box); the frontier path
is consent-gated and dark while ``LCT_LOCAL_ONLY`` is on.

See docs/plans/2026-06-17-grounded-synthesis-productization.md.
"""

from __future__ import annotations

from lct_python_backend.services.synthesis.grounded_synthesis import (
    Conversation,
    SynthesisResult,
    render_report,
    synthesize,
)
from lct_python_backend.services.synthesis.grounding import (
    ClaimUnit,
    GroundingResult,
    ground_units,
    is_grounded,
)

__all__ = [
    "Conversation",
    "SynthesisResult",
    "synthesize",
    "render_report",
    "ClaimUnit",
    "GroundingResult",
    "ground_units",
    "is_grounded",
]
