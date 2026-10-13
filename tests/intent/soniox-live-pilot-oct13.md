# Soniox synthetic live pilot — test intent (2026-10-13)

- Refuse an absent arm flag, wrong public origin or asset identity, inactive Soniox, active OpenRouter, and invalid/non-PCM/oversized/too-long WAV before any mint.
- A valid synthetic fixture permits exactly one same-origin, consent-tagged session POST after a durable once-only guard; refusal, timeout, and cancellation never retry.
- Stream bounded WAV frames through the existing adapter, pace by byte rate, observe incremental callbacks before finish, and report only counts, timings, and known-keyword checks.
- Finalization, failure, and cancellation close the stream and never expose temporary keys or transcript text in CLI output.
