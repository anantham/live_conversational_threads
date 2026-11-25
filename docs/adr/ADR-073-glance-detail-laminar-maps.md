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
