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

## Prepared local verification experiment

`tools/probe_inspection_quality.py` pins the public artifact digest, verifies all
canonical source fields against it, checks page receipt identity and current
local consent, and prepares the complete 77-span first page with observations
4, 6 and 10. Default mode makes no model call; `--run` makes one local request
and saves a generated diagnostic under gitignored `tmp/public-inspection-quality`.
It does not publish, mutate canonical rows, or replace the original observations.

Prepared request: 12,368 UTF-8 bytes, hash
`9a41f7e6199c282e47537e80872f5dd55fd945db6618c3d36a510e6e45ca4095`.
Full-envelope validation passed at 32,768 conservative capacity units with
4,096 output reserve and 512 headroom. The fixed model remains qwen3.8:27b-mlx.
The diagnostic is repair-oriented and selected after manual inspection, not a
blind baseline or throughput benchmark. Its raw response requires manual source
assessment before any result can be accepted.

## Local verifier result

Session 3965 completed successfully. Raw response remains gitignored at
`tmp/public-inspection-quality/1788814825908375000.json`. All three input IDs were
reviewed once, statuses were recognized and cited span IDs belonged to the page.
Two were marked supported and one revise. These structural checks are not
semantic acceptance.

- **Attribution case (observation 10): useful repair.** The verifier identified
  that the turtle detail belonged to the guest's machine label, not the host's,
  and proposed wording that separates their contributions. The proposed wording
  accords with the supplied source labels. Human speaker identity remains
  dependent on unverified diarization.
- **Degree citation case (observation 4): verifier miss.** The verifier marked
  the observation supported and attributed the full degree discipline to span
  14. The continuation is actually in span 15. It neither acknowledged the
  selected-evidence gap nor added that span to its evidence. Merely asking for
  an audit is not a sufficient claim-entailment gate.
- **Academic-history case (observation 6): inconclusive.** The verifier accepted
  the literal source as compatible with subject-specific difficulty. That is a
  possible reading; the earlier manual audit identified a tension, not a proven
  falsehood. Do not score this as a definitive model error without audio/source
  adjudication, and do not silently correct the transcript.

Next experiment should require each atomic claim's supporting source spans and
separately report source ambiguity. Preserve both original and verifier output.
One successful attribution repair does not establish reliable verification over
the conversation, and these three selected cases do not yield an accuracy rate.

## Atomic-claim follow-up result

Session 13714 completed; raw output is retained in
`tmp/public-inspection-quality/1788815187645607000.json`. Same request source and
observation selection, atomic prompt fingerprint
`881cfa84785fb34ed948ef4241a42779c81d7a0433cf1055ca60ef7824b6c15d`.

The model produced eight atomic claims and correctly located the degree
continuation in span 15. It also added span 35 for the specific language names.
However, it labelled both expanded citation sets as selected, even though those
spans were absent from their original observations' citations. The deterministic
lexical audit caught both mismatches and marks those two observations as requiring
citation revision, regardless of the model's overall supported status.

The attribution case again receives a useful proposed correction separating
speakers. All proposed quotes were found in their stated source spans. Neither
that check nor the decomposition proves every claim was covered or entailed.
The academic-history ambiguity is still unresolved; no audio was inspected.

Implication: separate model-proposed evidence discovery from code-verified
source location and from semantic acceptance. Do not use the verifier's supported
label to skip a required citation revision. Original observations and source
remain unchanged. This is a focused experiment, not a fair frontier comparison.
