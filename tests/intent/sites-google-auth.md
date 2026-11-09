# Optional Google identity — test intent

- Exercise public Worker requests with synthetic RSA-signed Google ID tokens and a fixture JWKS response at the pinned Google endpoint; use no real account, credential, network request, or persistent store.
- Prove a valid challenge and token establish an HttpOnly, Secure, short-lived app session, then reject forged signatures, wrong audience or issuer, expired tokens, and mismatched or replayed nonces without creating a session.
- Prove browser write defenses: absent or mismatched challenge cookie, cross-origin or missing custom write header, tampered or expired app session, and logout all leave the visitor unauthenticated.
- Preserve cookie-free public entry and the exact legacy ChatGPT session contract when Google is disabled. With Google enabled, two distinct synthetic `sub` values must produce distinct private principals through the Worker boundary; caller-supplied owner headers cannot confer either identity.
- In the existing real-SQLite/private-byte harness, prove Google A/B and legacy ChatGPT separation for list/read/recovery/delete, including identical raw subject IDs; quotas remain per provider/account and revoked cookies cannot reserve or touch storage.
- Bound streamed credentials by size and time; cancellation and retry leave no session behind. Preserve legacy rows with an additive migration and no automatic email linking.
- Private guest/expired-session actions lead to the shared available sign-in controls; recording copy requires identity without implying ChatGPT is the only provider. Keep real Google configuration and two-account native proof as acceptance dependencies.
