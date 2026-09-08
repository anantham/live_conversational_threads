# Public podcast comparison

Status: in progress; neither candidate accepted or published.

## Matched inputs and remaining confounds

- Public video: `6HmR9IaqM88`, 1263 immutable source utterances.
- Source SHA256: `e1c1b6236b3604740d83754823ffbe82dbdc1cd4eee365692b2dcf25f765093f`.
- Runtime code: `1fc787c`; later commits through this checkpoint are tests/docs.
- Local: `local-20260908-questions`, qwen3.8:27b-mlx, local-only.
- Frontier: `frontier-20260908-questions`, requested gpt-6-astra/high,
  explicitly permitted external processing of this public source only.
- Both use the same shared pipeline, source, 32768 context allowance and 8192
  output reserve. Qwen native counting is the common planning yardstick, not
  OpenAI's actual tokenizer. Frontier CLI adds instructions/decoding defaults;
  its served model is not independently attested. Local temperature is zero,
  but this is not a claim of deterministic identical generations.
- Preserve earlier runs as diagnostics, not interchangeable final artifacts.

## Evidence rubric

Review identical source witnesses in both artifacts. Separate model judgment
from exact source custody; an exact quote does not prove the judgment is right.

1. Source/speakers: unchanged utterance IDs, text, order, timing and original
   diarization uncertainty; no invented attribution certainty.
2. Interleaving: temporary topic changes do not imply abandonment. Verify both
   departures and returns against source, including distant callbacks.
3. Questions: distinguish questions merely mentioned in summaries from explicit
   tracked question events. Check openings, partial answers, explicit deferral,
   unresolved status and unjustified closure.
4. Relationships: source-supported edges and overlapping memberships, not just
   a temporal chain or extra graph density.
5. Abstraction: all five useful levels with traceable membership and no claims
   unsupported by their children. Tier count alone is insufficient.
6. Viewer: two no-sign-in URLs, working tier/thread navigation and YouTube seek.
7. Operational evidence: budget/consent checks, rejected-output recovery and
   restart integrity. Distinguish tested failure cases from events actually
   encountered in the full run.

## Interim source witnesses (2026-09-08)

These observations concern committed intermediate output, not the final graph.
Later reviewed projections must be inspected before deciding the final result.
No output is edited to equalize scores or hide model differences.

| Witness | Local committed output | Frontier committed output |
| --- | --- | --- |
| University improvements, source sequences 304–309; education discussion deferred at 333–339 | Discussion and transition appear in moment summaries, but no explicit education-question event in the first two checkpoints | Explicit opening event `indian-university-improvements`; final resolution/deferral still to inspect |
| Request for a high-level GPT explanation in the second passage | Explanation summarized, but no separate GPT-question event in the first two checkpoints | Explicit opening event `gpt-models-training`; source support and later answer judgment still to inspect |
| Broad AI-safety question at 346–347 | Opening plus partial answers, rather than declaring it answered immediately | Full state comparison still pending |

Coverage denominator at inspection: local committed through sequence637 in two
passages (15 moments); frontier had three passages (78 moments). These unequal
coverage counts are not a quality score. The table compares witnesses that both
have already processed.

Local has passed its previous second-passage failure point. Its observed
requests did not yet include validation feedback, so this run does not yet
prove real corrective retry. Separate diagnostic and synthetic tests establish
that narrower behavior. Whole-artifact semantic acceptance remains open.
