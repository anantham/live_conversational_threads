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
