# Cost Dashboard — Counterfactual Cloud-vs-Local Savings (Scoping, task #10)

> Authored 2026-06-24. Grounded against branch `docs/2026-06-19-token-incident-handover`; re-anchor line numbers against `main` before implementing.

## TL;DR

LCT already ships a `CostDashboard.jsx` page + ~11 backend cost endpoints, but they all read one table (`api_calls_log`) that **nothing writes to in production** — the only logging path (`@track_api_call`) is defined but applied to zero functions (verified: zero `@track_api_call` usages outside `/instrumentation/`). So the dashboard renders "$0.00 / No data" forever, and it tracks the wrong quantity anyway (actual spend, ~$0 because inference is local). The task wants **counterfactual savings** = "what cloud WOULD have charged." That's computable today for STT (we have real audio duration) and approximable for the LLM (we have node/word counts; real token counts need ~10 lines of new logging).

## Data inventory — have vs must-log

**Already captured** (`conversations` table, `models/core.py:15-83`):
- `duration_seconds` (`:39`) — STT counterfactual's primary input. Populated from utterance timestamps (`graph_persistence.py:1203`) / thread session (`thread_observability_service.py:170`).
- `total_utterances` (`:59`), `total_words` (`:60`), `total_nodes` (`:61`), `total_claims` (`:62`) — incremented live (`stt_session.py:117-119`) + on persist (`graph_generation_service.py:178`, `graph_persistence.py:1149`).
- List endpoint already returns duration/utterances/nodes per conversation (`conversations_api.py:63,66,68`).

**LLM token counts — captured but not DB-linked:** `llm_telemetry_service.py:60-99` (`record_llm_call`) appends every LLM call to `data/llm_telemetry.jsonl` with `prompt_tokens`/`completion_tokens` when the provider returns `usage` (fed from `local_llm_client.py:97-106`; M5 Ollama's `/v1/chat/completions` returns usage). **Gaps:** the JSONL row has **no `conversation_id`** and **no cost**, and rotates at 5000 lines / 2 MB — not a durable ledger.

**Cost scaffolding that exists but is inert:**
- `models/system.py:15-59` `APICallsLog` — full cost schema (prompt/completion/total tokens + costs, model, provider, feature, conversation_id, latency).
- `instrumentation/cost_calculator.py:27-116` `MODEL_PRICING` — per-1K-token table, but **stale ("as of January 2025") and missing gpt-4o / gpt-4o-mini**.
- `instrumentation/decorators.py:135-265` `track_api_call` + `cost_tracking_mapper.py:71-133` — the writer, **confirmed dead** (no usages).
- Readers over the empty table: `cost_api.py` (`/api/costs/*`) + `factcheck_api.py:219-227` `/api/cost-tracking/stats` (what the dashboard calls, `CostDashboard.jsx:28`).
- Frontend `CostDashboard.jsx` (route `/cost-dashboard`, `AppRoutes.jsx:47`) already footnotes "if no data, check api_calls_log exists" — it knows it's empty.

**Must start logging:** per-conversation LLM token totals. Preferred: write `APICallsLog` rows for local calls in `_record_llm_telemetry` (`local_llm_client.py:97`) with `provider="local"`, `total_cost=0`, real token counts, **+ `conversation_id`** (thread it from the call site). ~10 lines; reuses the durable table + existing reader. STT seconds already derivable from `duration_seconds`.

## The counterfactual formula (all rates = stated, UI-editable assumptions)

**STT (AssemblyAI):** `stt_avoided = (duration_seconds/3600) * ASSEMBLYAI_USD_PER_HOUR`. LCT does *live* STT, so the honest comparator is the streaming tier (~$0.15/hr), not async (~$0.12/hr) — make it config, stamp "rate as of <date>, source".

**LLM (OpenAI gpt-4o-class):** `llm_avoided = (prompt_tokens/1000)*INPUT + (completion_tokens/1000)*OUTPUT`. gpt-4o ≈ $2.50/1M in ($0.0025/1K), $10/1M out ($0.010/1K). Offer gpt-4o-mini (~16× cheaper) as a range comparator. Extend `MODEL_PRICING` (add gpt-4o rows).

**Interim fallback before token logging lands (label "estimated"):** input tokens ≈ `total_words * 1.3`; output ≈ `total_nodes * AVG_TOKENS_PER_NODE` (seed ~150, calibrate). Reuse `estimate_tokens(text)=len//4` (`cost_calculator.py:241-259`). Flag rows measured-vs-estimated.

**Cumulative:** `total_saved = Σ(stt_avoided + llm_avoided)`; `actual_local_cost ≈ $0`; `net_savings = total_saved`.

## Minimal dashboard shape

Reframe `CostDashboard.jsx` from "spend" to "**savings**" (keep route + time-range selector).
- **Hero band (3 cards):** Saved-by-running-local (headline `net_savings`); STT avoided (+ hours transcribed); LLM avoided (+ tokens, measured/estimated badge).
- **Per-conversation table:** name · duration · nodes · STT-avoided · LLM-avoided · total · measured/estimated flag; sort by avoided desc.
- **Assumptions panel (collapsible):** the three rates + source + as-of date, editable.
- **New endpoint:** `GET /api/cost-tracking/savings?time_range=...` (sibling to `factcheck_api.py:219`) joining `conversations` with per-conv token totals; returns `{total_saved, stt_avoided, llm_avoided, by_conversation, assumptions}`. Don't overload `/stats` (that one honestly reports ~$0 actual spend).

## Risks
- **The empty-table trap is the whole task** — first deliverable is making per-call token counts persist with a `conversation_id`.
- Token counts depend on the provider returning `usage`; if a path strips it, fall back to the estimate and label it.
- Rates are stale (no gpt-4o) — extend + date-stamp each rate; the counterfactual is only as credible as the cited rates.
- Live vs async STT rate — use the streaming tier as the honest comparator, but make it config.
