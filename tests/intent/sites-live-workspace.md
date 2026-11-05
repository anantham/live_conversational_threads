# Live cloud conversation workspace

- One conversation survives pause/resume with finalized source tokens, monotonic segment timing, distinct speaker identities and separately playable audio; pause/cancel releases live resources and late callbacks cannot mutate a new segment.
- Finalized source feeds the graph during recording only after provider consent. Requests are serialized and bounded, never automatically retried after failure, and retain the last valid map while newer words arrive.
- Main canvas renders source-linked threads and collapsible exploration; one transcript panel expands/collapses and copies confirmed text without a duplicate textarea. Controls remain visible on narrow screens.
- Stop/export/private save retains exact evidence and prior identity/privacy/retention guards. Tests use synthetic media, source, provider and isolated storage only.
