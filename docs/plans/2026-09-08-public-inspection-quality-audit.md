# Public source inspection: semantic quality audit

## Scope and limits

Source artifact SHA-256:
`e1c1b6236b3604740d83754823ffbe82dbdc1cd4eee365692b2dcf25f765093f`.
Replay `fc002eff-150f-5666-8263-2a18328f6420`, source inspection page 0,
77 source spans and 11 observations, read from committed database receipt.
Model: qwen3.8:27b-mlx. This page predates the later 32-span request partitioning;
do not attribute these findings to that newer request configuration.

Manual source-text assessment by the implementing assistant, not independent
review or audio verification. No claim of overall precision/recall from one page.
Do not overwrite the source, inferred speaker names, or saved model response.

## Findings

| Evidence location | Assessment | Required treatment |
| --- | --- | --- |
| Observation 10; spans 63, 69, 71 | Programming recollections from two speaker labels are compressed into one sentence. The host's generalization and the guest's turtle recollection are not clearly separated. Citation provenance retains the distinction, but prose blurs it. | Score atomic speaker attribution, not just presence of valid citations. Preserve who supplied which detail in a revised observation. |
| Observation 6; spans 30, 32–35 | The source contains an apparent tension between academic success and anxiety about merely passing exams. The observation reports the success/language-difficulty combination without marking the broader ambiguity. This could be an ASR problem or an intended distinction, not something the model may silently settle. | Preserve the inconsistency as uncertainty; compare audio before changing source wording. Do not label either interpretation as established fact. |
| Source span 3, continuing into span 4 | Text appears to include both host introduction and guest response under one speaker label. This is a source diarization/segmentation concern independent of downstream grouping quality. | Verify against audio before asserting human speaker identities. Keep existing source IDs and attribution revision history if repaired. |
| Observation 4; spans 13–15 | The description includes the degree discipline's continuation, but selected citations stop before all of that continuation. Evidence is available on the inspected page, yet the selected citation set is narrower than the claim. | Assess claim entailment by selected evidence separately from source availability in the prompt. |
| Source spans 27–33 versus observation 6 | The contrast between current self-image and childhood experience is mostly compressed away. | Track this as a possible recall loss relevant to the narrative, not a mechanically provable error or mandatory extra node. |

## Acceptance implications

- Exact quote validation is necessary provenance checking, not claim entailment.
- Every semantic comparison should separately assess source fidelity, atomic
  attribution, uncertainty retention, important-detail recall, and invented links.
- Keep source transcription/diarization quality separate from model interpretation
  quality in the local/frontier comparison. Both models must receive the same
  source revision; do not repair source for only one condition.
- A source ambiguity may legitimately remain unresolved. Correct handling is
  visible qualification, not a forced answer or an invented speaker identity.
- This page is not sufficient to accept the full artifact. Continue sampling
  later callbacks, disagreements and partial answers, including newer partitions.

## Next executable checks

1. Inspect later pages for the same attribution and selected-evidence gaps.
2. Include these cases in the public local/frontier evaluation with a shared
   source revision and blinded output ordering where practical.
3. Test a source-grounded observation verification/revision stage on these cases;
   retain original output and revision rationale rather than erasing failures.
4. Verify suspected diarization defects against audio before changing canonical
   source labels. No source repair has been performed by this audit.
