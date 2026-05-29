# Feature: Multilingual & Code-Switch (Manglish) Transcription

**Status:** Proposed / **deferred** (designed, not built) · **Decision date:** 2026-05-29
**Decision:** Ship **English-only transcription by default.** Multilingual + intra-sentence code-switch ("Manglish") is captured here as a designed future feature, gated behind an explicit **transcription mode**, to be built when there's real demand.

---

## Why deferred (the decision)

English-only is the right v1 default because:
- Most sessions are English; the fast on-device English engines are already excellent (see [STT benchmark](#stt-benchmark-reference)).
- **Indic ASR is still immature**, especially the hard cases this feature targets: intra-sentence code-switch and Sanskrit/Pali. Vendor WER claims dominate the space and are systematically distorted for Indic scripts (matra-stripping normalization inflates error rates).
- Building it into v1 adds engine sprawl, larger models, and a transliteration/post-processing layer that the default user never exercises.

So we **document the design now** (cheap, preserves intent) and **build when triggered** (see [Build triggers](#build-triggers)). This matches the project's "don't over-build; documentation is design" principle.

---

## Concept: transcription modes

A session (or the app default) selects a **mode** that picks the ASR engine + post-processing chain:

| Mode | Status | Engine | Post-processing | Output |
|------|--------|--------|-----------------|--------|
| `english` | **default, now** | parakeet-mlx / mlx-whisper-turbo (CoreML on memory-constrained devices) | none | plain English |
| `multilingual` | future | Whisper large-v3 / IndicConformer / Qwen3-ASR | none | native script per language |
| `manglish` (code-switch) | future | multilingual ASR (no forced language) | token-detect → transliterate → LLM dual-script | `english text … roman (മലയാളം) … english text` |

The mode is a setting on the STT runtime (parallels the existing provider/runtime selection); diarization is **language-agnostic** and works in every mode.

---

## English mode (shipping default)

Backed by the on-device benchmark on this fleet:

- **M5 Pro / high-RAM:** `parakeet-mlx` (~46× realtime, cleanest punctuation) or `mlx-whisper-turbo` (~56× realtime). Either gives 40–55× headroom — STT is never the live bottleneck.
- **Memory-constrained devices (e.g. M2 Air, 8 GB):** prefer **CoreML/ANE** paths — **WhisperKit** (streaming Whisper on the Neural Engine) or **FluidAudio** (Parakeet + diarization on ANE, ~66 MB vs ~2 GB on GPU). MLX-GPU paths can blow the memory budget on an 8 GB Air.

> Engine choice is **device-tier-aware** and composes with [IndrasNet compute brokering](INDRASNET_INTEGRATION.md): heavy multilingual models can be offloaded to the RTX box / fleet rather than run on a thin client.

---

## Manglish / code-switch mode (future feature)

### The problem
ASR decoders condition on a single language (Whisper auto-detects one language per ~30 s window; Parakeet is English/European-only). Intra-sentence switches fall through: the embedded Malayalam word is either anglicized, dropped, or the whole window flips to Malayalam script. Most engines force "fully English or fully Malayalam."

### The desired rendering
Keep English in Latin; render each Malayalam word as **Roman/Manglish transliteration with the native script in parentheses**:

> "I was feeling a lot of **sankadam (സങ്കടം)** about it."

This preserves the *sound* (readable inline) and the *exact word* (native script) — directly serving the vision principle **"preserve specificity, resist abstraction."** The native Malayalam word *is* the pre-formal specificity worth keeping.

### The pipeline (split "recognize" from "render")
```
1. ASR (multilingual, language NOT forced; optional initial_prompt seeded with a Manglish example)
       → English in Latin, Malayalam words in Malayalam script
2. Detect Malayalam tokens     → trivial: Unicode block U+0D00–U+0D7F
3. Transliterate to Roman      → AI4Bharat IndicXlit / indic-transliteration (sanscript) / aksharamukha
4. LLM dual-script render       → local qwen3.5 / glm / gpt-oss: format "roman (നേറ്റീവ്)",
                                   and fix words the ASR anglicized, using context
```
**Key fit:** step 4 is a *prompt addition to the transcript→graph LLM step LCT already runs* — no new infrastructure. Transliteration can be a deterministic library (reliable) or folded into the LLM (handles ASR slips too); library-first is safer.

### Indic-capable ASR shortlist (for steps 1)
| Engine | License | Indic coverage | Apple-Silicon | Notes |
|--------|---------|----------------|---------------|-------|
| **Whisper large-v3 / turbo** | MIT | 99 langs incl. Hindi, **Malayalam** | mlx-whisper, whisper.cpp, WhisperKit | pragmatic broad baseline; already benchmarked (~56× turbo) |
| **AI4Bharat IndicConformer-600M** | MIT | 22 Indian langs incl. Hindi, **Malayalam, Sanskrit**, Tamil | PyTorch/ONNX (no MLX); gated HF | only free open model covering Malayalam **and** Sanskrit in one checkpoint |
| **Qwen3-ASR 0.6B** | Apache-2.0 | 52 langs incl. Hindi (**no Malayalam**) | native `mlx-qwen3-asr` | fast on-device; great if Hindi-only |
| **IndicWhisper** | open | 12 Indian langs incl. Hindi | mlx-whisper-compatible | Whisper-medium fine-tune; strong Hindi |
| **Meta Omnilingual ASR 300M/1B** | Apache-2.0 | 1,600+ langs incl. Hindi, **Malayalam** | PyTorch (300M viable on 8 GB) | long-tail / Sanskrit-adjacent; zero-shot new langs |

**Recommended future default for Malayalam code-switch:** **Whisper large-v3** (broad, Malayalam-capable, already in our stack) for capture, with **IndicConformer-600M** as the higher-Indic-fidelity option when Malayalam/Sanskrit accuracy matters. Transliteration via **IndicXlit**.

### Sanskrit / Pali — experimental
Genuinely immature: existing models approach ~99% WER on Vedic/poetic Sanskrit; Pali has no production-grade open model. IndicConformer and Omnilingual *list* Sanskrit, but treat it as research-grade and **budget for fine-tuning + validation on real audio** before promising it.

### Measurement caveat
Report **CER alongside WER** for Indic, and use consistent text normalization across engines — Whisper-style normalization strips matras and inflates Indic WER, making cross-engine comparison misleading otherwise. (Same "agreement, not ground truth" honesty as the STT benchmark.)

---

## Build triggers

Promote from deferred → build when any of:
- Real sessions show meaningful code-switched / non-English usage (instrument language-mix in transcripts).
- A user explicitly opts into a non-English mode.
- IndicConformer / Qwen3-ASR / Whisper-multilingual quality on *our* audio clears a usability bar in a quick spike.

When built: add the mode toggle to STT runtime settings, wire the ASR shortlist behind it, add the transliteration + LLM dual-script step to the transcript pipeline, and add a small Manglish eval set (CER + dual-script correctness).

---

## STT benchmark reference

On-device, 120 s clip, M5 (warm): `mlx-whisper-turbo` ~56×, FunASR/SenseVoice ~51×, `parakeet-mlx` ~46×, `whisper.cpp` (Metal) ~39×, `mlx-qwen3-asr` ~12×, `openai-whisper` large-v3 (MPS) ~6×, `faster-whisper` (CPU) ~1.6×. Accuracy differences were dominated by punctuation/casing style, not word errors. Full data: `.tmp/stt_bench/out/`. Diarization (language-agnostic): **Senko** ~742× realtime, clean 2-speaker result; FluidAudio (ANE) is the bundled STT+diar option.

## Related
- [INDRASNET_INTEGRATION.md](INDRASNET_INTEGRATION.md) — compute brokering across the Tailscale fleet (where heavy multilingual models can run).
- [VISION.md](VISION.md) — "preserve specificity, resist abstraction" (why keeping the native word matters).
- ADR-008 (local STT), ADR-014 (stage-based runtime settings — where the mode toggle would live).
