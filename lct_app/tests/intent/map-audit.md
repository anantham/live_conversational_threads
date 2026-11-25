# Map audit and owner flags (2026-11-25)

- The auditor must be a different model family than the map's builder (family = whose model answers:
  anthropic, google, or the OpenRouter model's vendor); no eligible route means no audit, never a same-family one.
- It reads chosen spans independently first (decisions, reversals, commitments, claims, tangents,
  questions), then says which map node represents each point. Unrepresented points are `missed`.
- A credit to a node it was not shown is discarded and counted, so a hallucinated credit cannot hide a miss.
- Every finding is saved in `audit_signals` with its global utterance evidence, provider/model and a
  decision (`pending`; represented points `not_needed`). The owner accepts or dismisses; owner flags
  (irrelevant, misfiled) are labelled false positives. `auditSummary` yields the counts for precision/recall.
- Spans: uncovered turns first, then core topics; a bounded number of segments per audit.
- Consent for the audit names its provider and the spans it receives, separately from map consent.
