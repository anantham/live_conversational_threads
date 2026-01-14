# ADR-009: Local-First LLM Defaults With Optional Online Mode

**Date:** 2026-01-12  
**Status:** Proposed  
**Group:** integration

## Context

Live Conversational Threads currently uses multiple online LLM providers (Anthropic, OpenRouter, Gemini) across detectors, clustering, and transcript processing. The product direction prioritizes local inference for privacy, with optional online usage only when users explicitly opt in. We also need a consistent configuration surface for chat and embedding model selection, backed by environment defaults and database overrides.

## Decision

- Default the application to local LLM mode, using an OpenAI-compatible LM Studio endpoint.
- Provide settings (env + DB override) for:
  - `mode`: `local` or `online`
  - `base_url`: LM Studio base URL
  - `chat_model`: local chat model id
  - `embedding_model`: local embedding model id
  - `json_mode` and `timeout_seconds` for safety/reliability
- Add a UI panel that surfaces both chat and embedding model dropdowns plus a mode toggle.
- Preserve online providers in code paths for optional use when `mode=online`.

## Consequences

- Local mode becomes the default for all LLM calls (detectors, clustering, transcript processing).
- Online providers remain available but require explicit opt-in and valid API keys.
- LLM configuration is centralized for consistent behavior across services.
- Future refactors should split large LLM-heavy modules into smaller units without changing behavior.

## Notes

- Local models incur no external usage cost and improve privacy.
- Online mode is still useful for higher-quality or specialized models and is gated by settings.
