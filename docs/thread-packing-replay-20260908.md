# Public replay checkpoint, 2026-09-08

Thread-identity model requests previously consumed 44,349–44,404 Qwen reference
tokens. Omitting redundant utterance UUID membership lists reduces these measured
requests to 23,460–23,515 without removing source text or speaker offsets. The
canonical audit request retains membership; sources referenced by corrected
source_attributions retain membership even in the model projection. Runner
fingerprint version 2 distinguishes this rendering policy.

Validation: 29 thread-identity review/runner tests passed after the attribution
preservation correction. Earlier full unit run before that final correction:
2,382 passed, six skipped. This is not semantic acceptance or deployment proof.

Fresh UTF8 isolated replay targets use run IDs local-20260908-packed and
frontier-20260908-packed. Frontier process session 5577 remains live, returning
inference receipts. Local process was confirmed absent, then resumed with the
same immutable policy/source checks (session 31933). It exited 1 reproducibly:
question review expected event-1 and event-2 but its cached response additionally
assessed nonexistent event-3. Strict validation correctly rejected this output.
Evidence: tmp/public-pipeline/local-20260908-packed/1788849796675193000.
Next work: bounded, evidence-preserving validation recovery rather than deleting
the extra assessment or accepting fabricated event identity. Neither final
artifact is available or accepted for publication yet.

Independent review packet: /private/tmp/thread-packing-review.txt, 7,901 bytes,
SHA256 c1ace66322ec250e872f07a9c73a9935fb424ca0b72f08e840e28bd29840e927.
Contains only the inspected three-file source/test diff and review instructions;
no transcript, credentials, database, private artifact, or unrelated work.
Recipient Anthropic through existing Claude subscription, tools and MCP disabled.
Initial host rejection was retried after inspecting AGENTS.md and
REVIEW-EGRESS-A1 standing authorization. Retry was permitted but CLI returned
429/session limit, reset 11:50 Indian/Mauritius, zero reported token usage/cost.
No review verdict exists; this cannot satisfy the independent merge gate.
