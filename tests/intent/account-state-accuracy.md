# Account-state accuracy

- Only the session endpoint's valid JSON contract may confirm signed-in or signed-out; network, HTML, timeout, malformed and server errors remain unknown.
- Unknown/checking states show neutral account wording and connection recovery, with no sign-in/reset actions or automatic account change. Valid guest and authenticated states retain their existing actions.
- Meeting errors offer sign-in only for a JSON authentication refusal; non-auth failures preserve the form/history but disable joins until a fresh readiness check succeeds.
- Verify actual failed-preview UI and signed-in cloud UI separately. All test identities and responses are synthetic; no bot, media, production data, credential or paid request.
