# Direct Anthropic generation test intent

- Exercise the Worker with synthetic input and an intercepted Anthropic Messages endpoint. Verify the request has only the configured model, bounded tokens, server-side authentication, and the evidence needed for a source-linked map.
- Prove Anthropic requires its own consent and configuration and shares quota, cooldown, and failed-attempt accounting with the existing map providers.
- Refuse truncated, refused, and invalid maps without another provider call. Check model availability without sending transcript content.
- Select Claude in the recording and audio import flows. Require fresh consent before dispatch and keep Soniox on transcription.
