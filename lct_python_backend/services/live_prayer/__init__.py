"""Live-prayer cards: explicit, LLM-fuzzy fetch + fact-check during live conversation.

On each finalized STT segment, an M5 fuzzy detector recognizes an explicit (possibly
STT-garbled) "fetch" or "fact check" command, executes it (fetch → IndrasNet retrieval;
factcheck → local M5, hybrid grounded+labeled), and emits a passive ``prayer_card`` WS
event the viewer surfaces as an ambient, aging card stack. Local-only (M5 + loopback
IndrasNet), no redaction. Feature flag: LIVE_PRAYER_CARDS_ENABLED.
"""

from __future__ import annotations

from lct_python_backend.services.live_prayer.runner import (
    LivePrayerDeduper,
    run_for_segment,
    should_run,
)

__all__ = ["LivePrayerDeduper", "run_for_segment", "should_run"]
