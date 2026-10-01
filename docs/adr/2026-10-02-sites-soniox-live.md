# Soniox live transcription for the existing Site

Date: 2026-10-02. Status: implementation within the approved cloud migration; paid activation pending limits and native proof.

## Intent and constraints

Anyone should be able to open the app while the owner's computers are off. ChatGPT identity is optional for the public flow and required for private saves. The chosen STT provider is Soniox; the owner's permanent provider key must stay in a Site secret. No owner recordings/history/identities enter technical review or synthetic tests. The legacy local/Vercel flow stays available during migration.

Hypothesis: a separate browser Soniox stream and Sites recording flow can replace the Python WebSocket dependency for the hosted journey. Prediction: protocol/capture/issuer behavior passes with synthetic transports, and the deployed disabled issuer makes no provider request. Confidence0.85; fallback keep paid activation disabled and preserve browser-local audio/transcript until the observed failure is fixed. This is a stage toward real cloud recordings/graphs, not completion of that goal.

## Credential and admission decision

Mint only `transcribe_websocket` temporary keys, single-use,60-second start expiry and a configured15–900-second connection limit. Require same-origin explicit Soniox-transcription consent before minting; audience is an explicit public or authenticated policy. Use an unrelated random session ID for provider usage correlation, never account identity or audio context. Each mint reserves a durable anonymous D1 row atomically before network access. Enforce configured lifetime count (at most200), a10-second global mint interval and at most two potentially live keys/sessions. Keep reservations after every uncertain outcome; no automatic mint retry/reconnect or reclaim of possibly issued keys. This trades some preview availability for a known issuance bound without persisting temporary keys.

Runtime activation requires all explicit values: enabled flag, secret, maximum sessions, session duration, audience and a provider-project-budget confirmation. None is configured by this source change. That confirmation records an activation prerequisite; it does not assert a mathematically exact dollar ceiling. The confirmed billing policy must be checked separately before activation.

Lease amendment before publication: successful admission stays potentially live until the provider's actual key-start expiry plus the maximum connection duration. Do not measure it from request start, which excludes provider latency. Unknown/timed-out/cancelled or unreadable successful mints retain a null lease and consume a concurrency slot indefinitely; two such outcomes close admission pending owner review. A definitive non201refusal may end only its concurrency lease; its lifetime count remains. No temporary key is persisted. The initial generated0003table and companion0004nullable lease migration are both unapplied when this note is written; existing applied migrations stay immutable.

## Cost evidence and open question

Soniox documents `max_session_duration_seconds` as connection duration; temporary-key expiry controls new connections and does not end active streams. Real-time pricing is token based; the displayed equivalent hourly estimate is not a maximum cost per session. A session-minute reservation therefore cannot prove an exact dollar cap. Provider monthly-budget errors document refusal of further requests, without establishing an atomic ceiling or immediate termination of in-flight streams. Never display estimated spend as measured cost. A real smoke needs approved limits, a checked separate provider project budget and a clear residual-overrun policy; the source stays inactive until then.

Primary sources read2026-10-02: [temporary-key API](https://soniox.com/docs/api-reference/auth/create_temporary_api_key), [key limits](https://soniox.com/docs/guides/temporary-api-keys), [WebSocket protocol](https://soniox.com/docs/api-reference/stt/websocket-api), [pricing](https://soniox.com/pricing), [budget errors](https://soniox.com/docs/api-reference/errors). No billable call or credential read is part of this decision.
