# synthetic_eval — synthetic-conversation extraction harness (Tier 1)

Generate **fake** conversations and grade LCT's transcript → graph extraction against
an **authored answer key**, so you can stress-test extraction quality against
external / frontier LLM providers **without ever shipping real conversation data to
the cloud**.

## Why this exists

Two goals, two tiers:

| Tier | What it tests | Needs TTS? | Status |
|------|---------------|-----------|--------|
| **Tier 1** (this package) | Graph-gen / dimension extraction (cruxes, tangents, surprises, claims, edges) against frontier LLMs, scored vs ground truth | No | **Built** |
| **Tier 2** (roadmap) | STT + diarization front-end, by rendering these conversations to multi-speaker audio (Dia-default, pluggable) | Yes | Not built |

The payoff over real data: because every planted crux / tangent / rebuttal / claim is
**authored**, we have ground truth and can measure extraction precision / recall / F1
**objectively** — impossible on un-labelled real conversations. This directly attacks
the known extraction-ceiling question (cruxes reliable ~75%, edges/tangents noisy).

## Why it's safe to use cloud providers here

The conversations are synthetic, so the privacy constraint that normally blocks cloud
LLMs does not apply. The harness is safe by **isolation**, not by flipping a global flag:

- It is a **standalone process** — it never starts the FastAPI app and never connects to
  the real Postgres DB, so the production egress chokepoint and the real corpus are both
  out of reach.
- It only ever processes **synthetic fixtures**.
- For cloud presets it sets `LCT_LOCAL_ONLY=0` **for its own process only** (the
  extractor's `assert_local_egress()` is the real gate; default-ON / fail-closed) and
  prints a loud banner. **Never** set `LCT_LOCAL_ONLY=0` in the main app.

## Quickstart

Run from the repo root with the backend's Python (`/c/Users/adity/anaconda3/python.exe`).

```bash
# 1. See what's available (conversations + provider presets + which keys are set)
python -m lct_python_backend.synthetic_eval.run --list

# 2. Validate the harness + scorer with zero network / zero credits
python -m lct_python_backend.synthetic_eval.run --all -p mock --verbose --no-save

# 3. Baseline against the local model (free; needs LM Studio reachable & fast)
SYNTH_EVAL_LOCAL_TIMEOUT=540 python -m lct_python_backend.synthetic_eval.run -c ai-safety-pause -p local

# 4. Push it at a frontier provider (synthetic data only)
OPENROUTER_API_KEY=... python -m lct_python_backend.synthetic_eval.run --all -p openrouter

# 5. Compare backends head-to-head on the same conversations
python -m lct_python_backend.synthetic_eval.run --all --providers mock,local,openrouter
```

Results JSON is written to `results/<slug>__<provider>.json` (report + raw extracted
nodes) unless `--no-save`.

## Provider presets (`providers.py`)

| preset | routing | needs |
|--------|---------|-------|
| `mock` | none (deterministic stub) | nothing — validates plumbing/scorer |
| `local` | `providers=[LM Studio]` fallback path | LM Studio reachable (Tailscale, counts as "local") |
| `openai` | OpenAI-compatible fallback path | `OPENAI_API_KEY` (+ quota) |
| `openrouter` | OpenRouter fallback path (use `anthropic/claude-*` models too) | `OPENROUTER_API_KEY` |
| `gemini` | Google genai SDK (`mode=online`) | `GOOGLEAI_API_KEY` / `GEMINI_API_KEY` |
| `claude` | **native Anthropic SDK** (`messages.create`, adaptive thinking) | `pip install anthropic` + `ANTHROPIC_API_KEY` |

> **Why `claude` has its own path:** LCT's extractor (`generate_lct_json`) only speaks the
> Gemini SDK and the OpenAI-compatible chat shape — Anthropic's native Messages API is
> neither. Rather than route Claude through an OpenAI-compat shim, the `claude` preset calls
> the official `anthropic` SDK directly while reusing LCT's **same** GENERATE prompt and
> `_normalize_generated_output`, so the only variable under test is the model. Defaults to
> `claude-opus-4-8` at `effort=high` (override via `SYNTH_EVAL_ANTHROPIC_MODEL` /
> `SYNTH_EVAL_ANTHROPIC_EFFORT`). Zero-setup alternative: `-p openrouter` with
> `SYNTH_EVAL_OPENROUTER_MODEL=anthropic/claude-opus-4-8`. (Productizing a native Anthropic
> provider inside LCT's `generate_lct_json` is a separate follow-up.) The generator
> (`generate.py`) currently supports `openai`/`openrouter`/`gemini`/`local`, not `claude`.

Model ids are overridable via env: `SYNTH_EVAL_OPENAI_MODEL`,
`SYNTH_EVAL_OPENROUTER_MODEL`, `SYNTH_EVAL_GEMINI_MODEL`. Local timeout:
`SYNTH_EVAL_LOCAL_TIMEOUT` (seconds, default 180).

The harness calls the **same** production function the import/STT pipeline uses
(`services.transcript_llm_callers.generate_lct_json`) — it measures the real extractor,
not a reimplementation.

## Authoring conversations

A conversation is one JSON file in `conversations/` (see `schema.py` for the contract).
Turn ids (`t0`, `t1`, …) are the stable anchors; every ground-truth flag / claim / edge
references a turn id, validated on load.

Two ways to add them:

- **By hand** — copy `conversations/ai-safety-pause.json` and edit. Best ground-truth quality.
- **Generated** — `generate.py` authors both the dialogue and the answer key via a frontier LLM:

  ```bash
  OPENAI_API_KEY=... python -m lct_python_backend.synthetic_eval.generate \
      --topic "Should we adopt a four-day work week?" --speakers 3 --slug four-day-week -p openai

  # or batch a few built-in topics:
  python -m lct_python_backend.synthetic_eval.generate --count 3 -p openrouter
  ```

## Scoring methodology (`score.py`)

Extracted nodes are chunks/ideas spanning ≥1 turn, so we align each node to the
ground-truth **turns** it covers (token containment of turn text in the node's
excerpt/summary), then grade in turn-space:

- **Flag recall** = fraction of ground-truth-flagged turns whose covering node carries the flag.
- **Flag precision** = fraction of flagged nodes that cover ≥1 ground-truth-flagged turn.
- **Edges** are scored per relation type, **direction-agnostic** by default (extraction
  direction is unreliable); a stricter directed score is also reported.
- **Claims**: only **factual** claims are scored, because the generation prompt's `claims`
  field is explicitly "fact-checkable assertions, be conservative". Normative / worldview
  claims are recorded in ground truth but belong to the separate three-layer claim detector
  (out of scope for generate-mode — flagged in the report's NOTES).

Known limitations (documented, not hidden): token-containment can mis-assign very short
turns (mitigated by a minimum-overlap floor); a node that merges a tangent with an
on-topic turn inflates recall. **Inspect the `--verbose` per-item detail, not just the
headline F1.**

## Current status / what's NOT done

- **Tier 1 harness, scorer, generator, and 2 hand-authored seeds: built and validated**
  (the `mock` provider reproduces exactly the injected errors; the real
  `generate_lct_json` integration is exercised — connections + auth confirmed).
- **A live frontier baseline is gated on credentials**: at build time the local model
  exceeded its 180s timeout, the OpenAI key's account was over quota (HTTP 429), and no
  OpenRouter/Gemini key was set. Supply any working key (or a faster/longer-timeout local
  model) and the numbers populate.
- **generate-mode only**: the streaming accumulate→chunk→generate pipeline (live STT path)
  is a noisier superset and is a deliberate Tier-1.5 follow-up.
- **Tier 2 (TTS → STT → diarization) not built.** Plan: render these same conversations to
  multi-speaker audio with a pluggable, Dia-default backend, push through
  `/api/import/upload` or `/ws/transcripts`, and stress the diarizer (overlap, rapid turns,
  over-segmentation crumbs).
