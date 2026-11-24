# Claude map diagnostics

- Return only an allowlisted reason and a validated provider request ID when Anthropic refuses a generation request.
- Check a fixed synthetic transcript against a minimal schema and the production map schema using the same model and shared admission. Stop after any rejection.
- Preserve consent, provider fallback rules, and transcript privacy. Reject arbitrary content at the diagnostic endpoint.
- Verify the Claude wire schema uses the SDK-supported nullable form and one node shape. Reject invalid tier combinations and unsupported evidence in the actual Worker response.
- Permit one full-schema retest after the minimal control has passed, without resending the control.
