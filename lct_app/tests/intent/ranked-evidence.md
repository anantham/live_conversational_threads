# Test intent: ranked evidence on landscape cards

UX fix plan (5 November review), "Rank the evidence": show the few lines that best support a
node's summary, with filler left out and the full passage one step away. Owner approved the
rule below on 2026-11-27.

## The rule (no model calls)

1. Candidates are exactly the lines the card's passages open to (`sourceVisitsById`): the lines a
   node cites (`source_ref.utterance_ids`, else legacy `utterance_ids`), or, for a node that cites
   none of its own, the lines its descendants cite.
2. Lines of five words or fewer are left out (`BACKCHANNEL_WORDS`, the generation side's
   backchannel threshold). Words are counted as the generation side counts them (split on spaces,
   so "that’s" is one word), except that fillers such as "um" and "uh" don't count.
3. Lines are ranked by, in order:
   - salience: core, then supporting or unmarked, then aside. A line's salience is the best among
     the marked nodes in the card's subtree (the card included) that cite it, each node taking the
     nearest mark at or above it. Generated maps mark topics, and generated parents repeat their
     topics' citations, so an arc card still ranks by its topics' salience;
   - how many of the node's title and summary words they share;
   - length, up to 40 words (a longer line usually carries more of the point).
   Ties keep transcript order.
4. Lines next to an already chosen line (within two turns) are skipped on a first pass, so the
   picks come from different stretches when the node has them. If that pass finds fewer lines than
   the limit, the best remaining lines fill the gap, even near a chosen line: the owner asked for
   the top three, and spreading is a preference, not a reason to show fewer.
5. The chosen lines are shown in transcript order, verbatim.

## Behaviour to test

- A node that cites only filler shows no key lines, and nothing breaks.
- Filler and backchannel lines never appear, even when they are the only lines that mention a
  summary word.
- A line from a core topic outranks a line from an aside topic that shares more summary words.
- On maps without salience, summary overlap decides.
- An upper-tier node with no citations of its own gets lines from its descendants.
- Picks are spread out: two adjacent strong lines don't both appear when a third, distant line exists.
- Output is in transcript order and is at most the limit.
- Untrusted input (cycles in parent links, missing utterances, non-string text, values whose
  string conversion throws) does not throw.
- A line cited by both an aside and a core topic ranks as core, whatever order the topics are walked in.
- On a generated arc (citations derived upward by `deriveParentEvidence`), a core topic's line still
  outranks an aside's.
- Legacy top-level `utterance_ids` give key lines, as they give passages.
- The candidate lines are exactly the lines the card's passages open to, also when citations sit at
  several tiers.
- Contractions count as one word and an emoji counts as one (as on the generation side); plurals
  match their singular ("rates", "houses", "buses", "statuses", "classes", "stories"); two-letter
  title terms ("AI") count; common false folds are avoided ("notes" is not "not", "uses" is not
  "us"). Plural folding is a heuristic and will miss some irregular words; it only orders lines
  that tie on salience.
- Speaker names come from the viewer's display-name Map; only string names render.
- On a card, the lines show in the detail area with speaker and time, and each opens the passage at
  that line through the existing `onOpenVisit`.
