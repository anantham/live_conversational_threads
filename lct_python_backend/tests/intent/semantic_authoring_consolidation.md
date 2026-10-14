# Shared transcript-grounded relationship authoring

Approved goal, 2026-10-12: consolidate imports and `.threads` experiments on the
existing relationship extractor. Preserve source identities and graph membership.

- The provider request contains exact text and IDs of the endpoint source turns;
  invented, omitted, or undisclosed citations never become accepted relationships.
- Supported directed relationships, including distant callbacks, survive shared
  extraction, compilation, artifact export/reload, and the reader's relationship
  inspection. Summary text and a brief acknowledgement do not constitute evidence.
- Compilation preserves valid existing edges and thread-return metadata without
  manufacturing a second relationship list from that metadata.
- Empty successful extraction differs from provider/schema/grounding failure;
  failure preserves the previous artifact/relationships and is reported explicitly.
- Exercise the real adapters with synthetic source data and a boundary provider
  stub; isolate all storage before imports. No production DB or provider calls.

Review follow-up, 2026-10-14:

- Optional retrieved context must never crowd out exact source evidence; omit
  context that will not fit and still perform the grounded scan.
- Compiler failures expose a bounded diagnostic and finish within a bounded
  timeout; compilation does not block the CLI status loop.
- Replacing an existing artifact preserves its permission mode. A new artifact
  retains the temporary file's private default permissions.
- The canonical prompt's output example includes required source citations, so
  a provider following that example produces the same contract the parser needs.

Complete-passage repair approved, 2026-10-14:

- Every nonblank referenced source turn, including evidence after turn twelve,
  reaches the existing extractor with its exact text and endpoint association.
  Broad ancestors share the passages in the current request; they cannot force
  an unbounded prompt or a silent prefix cutoff.
- Requests remain deterministic and within the existing node/text budgets,
  preserve overlapping memberships, and show both sides of adjacent moments.
  Whole turns are indivisible; an impossible budget fails before calls.
- A late visible citation is accepted; a real but undisclosed citation is refused.
  A failed later passage retains the previous artifact. A valid empty complete
  scan remains successful.
- Verify coverage separately from semantic precision. Hold public replacement
  until real positive/negative meaning checks pass on the private provider.
