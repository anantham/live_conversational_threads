# ADR-027: PromptManager as the Canonical Runtime Source for Transcript and Refinement Prompts

**Date:** 2026-04-13
**Status:** Approved
**Group:** integration + runtime
**Supersedes in practice:** direct runtime ownership of transcript prompt constants

---

## Issue

The repo had drifted into parallel prompt systems:

1. `PromptManager` + `prompts.json` + Prompt Library UI
2. Hardcoded transcript-generation prompts in `services/transcript_prompts.py`
3. Additional one-off inline provider/product prompts in isolated services

This was no longer principled. The live transcript graph and import refinement paths
were bypassing the same prompt-management system that the rest of the product exposes
in Settings. That made prompt editing misleading: the UI implied a single prompt
library, while one of the most important runtime paths ignored it entirely.

An additional implementation drift existed inside the canonical prompt system itself:
`PromptManager` rendered prompts with `string.Template` (`$name`) while many existing
`prompts.json` entries used `{name}` placeholders. That weakened confidence in the
canonical system and made migration riskier.

---

## Decision

`PromptManager` is the canonical runtime source for **product-facing transcript
prompts**:

- transcript accumulation
- conversation hierarchy generation
- local/fallback hierarchy generation
- import graph refinement

The transcript pipeline now resolves these prompts by stable ids from `prompts.json`
first. `services/transcript_prompts.py` remains only as a **bootstrap fallback**
containing default prompt bodies if the managed entries are missing or unreadable.

`PromptManager` now supports both placeholder styles used in-repo:

- `$variable`
- `{variable}`

This is a compatibility bridge so the canonical system can safely own runtime prompts
without requiring a disruptive same-day rewrite of all historical prompt templates.

---

## Rationale

- The settings-backed Prompt Library should reflect real runtime behavior.
- Prompt versioning, history, and reload should apply to the live graph pipeline.
- The transcript hierarchy rewrite in ADR-021 is important enough to be editable and
  inspectable through the same system as other analysis prompts.
- Keeping the old prompt constants as fallback reduces boot risk during migration.
- Supporting both placeholder syntaxes is lower risk than immediately rewriting every
  historical prompt template in `prompts.json`.

---

## Consequences

Positive:

- The live transcript graph and import refinement paths now participate in the same
  prompt-management flow as the analysis features.
- Prompt edits in the UI can affect the transcript pipeline instead of silently missing
  it.
- The prompt architecture is easier to reason about: one canonical runtime system, one
  migration fallback.

Tradeoffs:

- `services/transcript_prompts.py` still exists during the transition, but only as a
  fallback/default source rather than a co-equal runtime system.
- `PromptManager` now carries compatibility logic for two placeholder styles.
- Some inline prompts remain outside the canonical system where they are closer to
  transport/provider instructions than user-tunable product prompts.

Follow-up decisions likely needed:

- Whether product-facing inline prompts in `fact_check_service.py` should also migrate
  into the Prompt Library.
- When to remove the bootstrap fallback path from `services/transcript_prompts.py`
  entirely after runtime confidence is established.

---

## Related Artifacts

- [`lct_python_backend/services/prompt_manager.py`](../../lct_python_backend/services/prompt_manager.py)
- [`lct_python_backend/prompts.json`](../../lct_python_backend/prompts.json)
- [`lct_python_backend/services/transcript_prompts.py`](../../lct_python_backend/services/transcript_prompts.py)
- [`lct_python_backend/services/transcript_llm_callers.py`](../../lct_python_backend/services/transcript_llm_callers.py)
- [`lct_python_backend/services/import_graph_refinement.py`](../../lct_python_backend/services/import_graph_refinement.py)
- [`docs/adr/ADR-005-prompts-configuration-system.md`](./ADR-005-prompts-configuration-system.md)
- [`docs/adr/ADR-021-authored-four-level-conversation-hierarchy.md`](./ADR-021-authored-four-level-conversation-hierarchy.md)
