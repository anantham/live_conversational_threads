# Test intent: local conversation retention

- Default guest recording durably stores audio chunks, finalized transcript/source timing, map/threads and segment completion, and reopens from the device library after a page reload without a server call.
- Ephemeral selection persists only a preference; it never creates conversation/chunk records. Existing saved copies and explicit downloads are not deleted.
- Transaction completion controls Saved; quota/unavailable/blocked/aborted writes show failure, retain current data for retry/download, and never lose queued chunks to an older acknowledgement.
- Recovery preserves incomplete audio as partial, keeps separate conversations and paused parts, and never resumes a microphone/provider without fresh action and consent.
- Explicit private saving and public publication boundaries remain unchanged. Test against a dedicated synthetic browser origin and injected disposable stores, never an existing user database.
