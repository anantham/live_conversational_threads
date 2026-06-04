# STT/LLM Pipeline — Tier-1 Fixes + Telemetry Landing Plan

**Date:** 2026-06-05
**Status:** Proposed (scope for review before implementation)
**Source:** Empirical findings from the 2026-06-04/05 bench session. Evidence in
`docs/STT_BENCHMARK_2026-06-04.md`, `docs/STT_ORCHESTRATION_OVERHEAD_RCA.md`, and
the `.tmp_*` harness runs (File A: 41-min, 102 utterances, 3 speakers).

Converts a session of hand-discovery into committed, instrumented improvements.
Each item: what, why (with measured evidence), files, risk, test.

---

## Guardrails
- Commits land on a dedicated branch (`fix/stt-llm-pipeline`), NOT directly on
  `main`/`feat`. The repo has an active `feat` branch + ADR renumbering in flight.
- Each fix is its own commit (honest partial framing), pathspec-scoped.
- No change to the cloud STT path (25 MB-cap chunking stays). All changes are
  local-provider-only or additive telemetry.
- `persist_graph` is destructive — any verification uses throwaway conversation ids.

---

## P1 — Must-land production fixes (measured, high confidence)

### P1.1 — Local STT: whole-file instead of 85×30s chunks
- **Why:** measured ~8× (a 41-min file: ~39 min orchestrated → ~5 min direct).
  The 30s cap exists for cloud upload limits; local WhisperX has none + resident model.
- **Status:** ALREADY CODED (uncommitted): `transcription_utils.py`
  `LOCAL_STT_CHUNK_DURATION_S=600`; `file_transcriber.py` local path uses it +
  900s timeout floor. 150 STT tests pass.
- **Action:** commit as-is. Add an `STT_ORCHESTRATION_OVERHEAD_RCA.md` reference.
- **Risk:** low (transport-aware; cloud untouched).
- **Caveat to verify:** confirm the IndrasNet WhisperX server's internal >10min
  auto-chunking handles a single 10-min POST cleanly (RCA says it does).

### P1.2 — Ollama reasoning-model support (the silent-failure bug)
- **Why:** LCT reads only `message.content`; Ollama reasoning models leave
  `content` EMPTY while thinking → `extract_json_from_text("")` → "No JSON
  object found" on EVERY graph batch. `reasoning_effort:"none"` fixes the
  empty-content half.
- **REVISED 2026-06-05 (instrumented run evidence):** there are actually TWO
  distinct failure modes, and reasoning_effort alone is NOT sufficient:
  1. **Empty content** (thinking) → fixed by `reasoning_effort:"none"`.
  2. **Runaway non-closing JSON** → on the real accumulate prompt with thinking
     off + `response_format:json_object`, **gemma4 generated 33,245 chars,
     `finish_reason:length`, invalid (truncated) JSON** — 5/6 batches failed.
     **qwen3.6 on the identical prompt: 388 chars, `finish_reason:stop`, valid
     JSON.** So this is partly a MODEL-SUITABILITY issue: gemma4 (8B) is unfit
     for this structured task; qwen3.6 (36B) is the right local model.
- **Implications for the fix:**
  - Add a `finish_reason == "length"` guard: log/surface it as a real failure
    (truncated JSON) rather than a generic parse error, so the runaway case is
    diagnosable instead of silent.
  - `extract_json_from_text` should handle markdown-fenced JSON (```json ... ```)
    — observed gemma4 wrapping output in fences.
  - Model choice belongs in config/docs: **qwen3.6 is the validated local graph
    model**; gemma4 is not.
- **Without this fix, LCT cannot use any local reasoning model — it silently
  fails + drops every segment.**
- **Files:** `services/local_llm_client.py` (both sync `chat_with_provider_fallback_sync`
  ~line 420 + async ~line 420 payload build); the request payload to
  `openai_compatible` providers should include `reasoning_effort:"none"` (or a
  per-provider `disable_thinking` flag), AND/OR the response reader (~line 185 +
  the gateway) should fall back to `message.reasoning`/`message.thinking` when
  `content` is empty.
- **Decision needed:** (a) send `reasoning_effort:none` for all openai_compatible
  providers (simple, but assumes Ollama — LM Studio ignores it harmlessly), or
  (b) read the reasoning field as fallback (handles both), or (c) both. *Lean: both.*
- **Risk:** medium — touches the core LLM client used by every detector. Needs the
  full LLM test suite + a live smoke test against M5.
- **Test:** unit (mock empty-content + reasoning-field response → extracts JSON);
  live smoke (gemma4 + qwen3.6 each return a parsed graph batch).

### P1.3 — `max_tokens=1200` default too small
- **Why:** `transcript_llm_callers.py:465` caps accumulate at 1200; reasoning
  models (and even verbose non-reasoning) can need more. Compounds P1.2.
- **Files:** `transcript_llm_callers.py` (raise default to ~4000, env-overridable
  `LCT_ACCUMULATE_MAX_TOKENS`); audit `hierarchy_consolidator.py` caps too.
- **Risk:** low.
- **Test:** existing accumulate tests + assert env override respected.

### P1.4 — STT cache that survives success (re-run reuse)
- **Why:** the checkpoint (`import_checkpoint.py`) is content-hashed by
  `file_hash` — exactly right — but `clear_checkpoint()` DELETES it on successful
  completion. So re-running the same audio re-transcribes (~5-39 min wasted).
  The user explicitly wants cheap same-audio re-runs.
- **Files:** `import_checkpoint.py` + the import-pipeline caller that clears it.
  Option: keep the manifest as a real cache keyed `(file_hash, model, diarize)`;
  on a new import, check it FIRST and short-circuit STT on hit. Gate behind
  `STT_CACHE_REUSE_ENABLED` (default off in prod to avoid surprising stale reuse;
  on for test/dev).
- **Risk:** medium — must key on model+diarize+settings so a config change
  doesn't serve a stale transcript. Don't reuse across different STT settings.
- **Test:** same file twice → second run hits cache, 0 STT calls.

---

## P2 — Telemetry (makes everything measurable; the empty-table gap)

### P2.1 — Populate per-stage timing into PipelineArtifact / a runs table
- **Why:** the `transcription_runs` table (IndrasNet side, registry §5a) is EMPTY;
  LCT has `PipelineArtifact` (`models/system.py:72`, `artifact_type` field) but no
  per-stage timing/quality rows. Every number this session came from a throwaway
  harness. No production visibility into: STT time, diarization time (60% of STT!),
  graph-gen time, batch success rate.
- **Action:** emit a `pipeline_stage_timing` artifact per stage (transcribe,
  diarize, accumulate, consolidate, persist) with `{stage, elapsed_ms, ok,
  item_count, backend, model}`. Reuse `PipelineArtifact` (cheap; no migration).
- **Risk:** low (additive, best-effort, never blocks the pipeline).

### P2.2 — Surface batch-failure / dropped-segment count
- **Why:** failed LLM batches silently drop transcript segments (we saw this).
  No user-facing signal that content was lost.
- **Action:** count dropped accumulate batches; emit a `stage_failure` artifact +
  return a `degraded: {dropped_segments: N}` field in the import result so the
  frontend can warn.
- **Risk:** low.

---

## P3 — Deferred (bigger; not this pass)
- Diarization as async pass / lighter diarizer (`simple_diarizer` bench) — biggest
  remaining STT lever but needs design.
- Interleave STT(asus)+LLM(M5); split-machine as default config.
- Coordinator-aware whole-file (1 acquire/file) in IndrasNet.
- WhisperX off WSL → native Windows.

---

## Suggested commit sequence (on `fix/stt-llm-pipeline`)
1. `fix(stt): whole-file local transcription (~8x)` — P1.1 (already coded)
2. `fix(llm): support Ollama reasoning models (empty-content/reasoning field)` — P1.2
3. `fix(llm): raise accumulate max_tokens default + env override` — P1.3
4. `feat(stt): opt-in content-hashed transcript cache for re-runs` — P1.4
5. `feat(telemetry): per-stage timing + dropped-segment artifacts` — P2.1/P2.2

Each verified before the next. P1.2 is the highest-value + highest-risk — review
its diff most carefully.
