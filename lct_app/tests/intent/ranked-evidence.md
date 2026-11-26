# Test intent: ranked evidence on landscape cards

UX fix plan (5 November review), "Rank the evidence": show the few lines that best support a
node's summary, with filler left out and the full passage one step away. Owner approved the
rule below on 2026-11-27.

## The rule (no model calls)

1. Candidates are the transcript lines a node cites, or, for a node that cites none of its own,
   the lines its descendants cite (the same set its passages open to).
2. Lines of five content words or fewer are left out (`BACKCHANNEL_WORDS`, the generation side's
   backchannel threshold). Fillers such as "um" and "uh" don't count as words.
3. Lines are ranked by, in order:
   - the salience of the topic they come from: core, then supporting or unmarked, then aside;
   - how many of the node's title and summary words they share;
   - length, up to 40 words (a longer line usually carries more of the point).
   Ties keep transcript order.
4. Lines next to an already chosen line (within two turns) are skipped, so the picks come from
   different stretches when the node has them.
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
- Untrusted input (cycles in parent links, missing utterances, non-string text) does not throw.
- On a card, the lines show in the detail area with speaker and time, and each opens the passage at
  that line through the existing `onOpenVisit`.
