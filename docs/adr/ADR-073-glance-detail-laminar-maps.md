# ADR-073: Glance → detail generation on a laminar evidence backbone, with second-family audit

- Status: proposed (implemented on branch `claude/claude-map-failure-details`, 2026-11-25; awaiting live run and review)
- Group: data / generation
- Date: 2026-11-25

## Issue
A 93-minute Meet import failed at window 1 of 7: Claude stopped at 12,000 of 12,000 output tokens
(Anthropic `req_011ChNrTYYP6D7aVojqdY98S`). The prompt made every parent repeat all its children's
utterance IDs. Fixed 15-minute windows also produced seven independent readings, so the top tiers
(arcs, themes) described windows, not the conversation, which defeats zooming out.

## Decision
1. **Evidence is a laminar backbone.** Chunks cite one contiguous utterance range; every higher node's
   evidence is the union of its primary children's (child ⊆ parent; siblings disjoint). Secondary parents
   are cross-links that never widen evidence. A subject the conversation returns to is one node whose
   evidence is a union of separate stretches. Ranges on higher tiers are ignored and counted.
2. **Glance, then detail.** One call over the whole transcript writes arcs, themes and topics (topics cite
   one or more ranges), salience (core / supporting / aside) and an ASR glossary. Detail calls fill chunks
   and ideas for segments built from whole topics (word budget, not clock), filed under the glance's own
   topic ids, with an escape hatch (missed_topic, wrong_boundary, unfiled). Detail can run for all topics,
   core topics, none, or one topic on demand.
3. **Nothing is silently dropped.** Uncovered turns become explicit placeholders (excluded from coverage).
   Boundary notes, unfiled ideas and glance-vs-detail boundary shifts go to `audit_signals`.
4. **Semantic audit by another family.** The auditor reads spans independently first, then maps each point
   to a node or marks it missed; contradictions and name splits are listed. Findings keep their evidence
   and the owner's accept/dismiss decision; owner flags are labelled false positives.

## Positions considered
- Raise the output cap (16,384): treats the symptom; still repeats IDs; still seven readings.
- Smaller fixed windows: fewer truncations, more fragmented top tiers.
- Single-interval topics: break on callbacks (swallow the middle or split one subject in two).
- Numeric salience weights: models are poorly calibrated on scalars; a three-level tag plus counted turns is
  more honest.

## Consequences
- The saved `.threads` format is unchanged (ranges are expanded before saving); new optional fields:
  node `salience`, node `generated_gap`, bundle `glossary`, bundle `audit_signals`.
- The evidence-mismatch warning no longer fires for generated maps (parents contain their children by
  construction); authored maps are still counted.
- Privacy: the glance sends the whole transcript once to the map provider; the audit sends only the
  chosen spans plus node names and summaries to a second company, under its own consent naming that
  provider and the time spans.
- Cost: the transcript is read about twice (glance + detail), output is smaller; one extra call per import,
  plus audit calls when run.

## Open questions
- Viewer: one jump link per return to a revisited topic; flag buttons (irrelevant, misfiled) on nodes.
- Cross-run ledger of audit outcomes (precision/recall across conversations), beyond each file.
- Long recordings beyond one context window need a glance over overlapping windows plus a merge.
- Whether detail should send a short skeleton context of neighbouring topics.

## Review after one month
Compare audit recall (represented / independent points) and boundary-shift rates against the windowed maps.

## Addendum — 2026-11-27: review fixes to the detail pipeline (code aligned to this ADR)
- **Higher-tier ranges in the overview.** Decision 1 says ranges on higher tiers are ignored and counted.
  The overview path refused a theme or arc that cited a range (`node_evidence/range_shape`), and an overview
  refusal ends the run, so a cosmetic extra (Claude's schema variant cannot enforce `maxItems: 0`) cost the
  whole import. The code now follows the decision: such ranges are ignored, counted in the overview's
  coverage (`higherTierRangesIgnored`) and named in the activity log. Other overview refusals still end the
  run: without a skeleton there is nothing to detail or keep, so this is unchanged by design.
- **Nested topics.** A topic whose turns another topic already claims (nested or wholly overlapped) is now
  offered as a segment topic wherever its turns are sent, and judged on what the model files under it
  (turns it loses are a `boundary_shift`). Previously it was left out of every segment, kept turns another
  topic's chunks covered, and could be detailed again on demand. Expanding a topic with no turns left now
  says so. Limit: under `detail: 'core'`, a non-core topic nested in a core one is not offered.
- **Split segments** start without the parent's re-ask note and with their own re-ask and admission budgets.
- **Admission retries** now wait (doubling, capped at 30 s) until they cover the Worker's stale-attempt
  cutoff (`STALE_ATTEMPT_MS`, 300 s), the longest a stuck or refused attempt can hold a concurrent slot;
  before, five linear retries gave up after 30 s.
- **Merging.** A detail result that cannot be merged fails its own segment and is left out; other
  segments' details, including calls still in flight, stay in the partial map.
