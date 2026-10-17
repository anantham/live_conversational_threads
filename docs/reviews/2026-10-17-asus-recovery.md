# Asus recovery preparation review — 17 October 2026

Author/integration: OpenAI Codex/root. Independent reviewer: Google Gemini 4 Argon Medium through the existing authenticated AGY subscription. Bounded source-only packets, fresh conversations, plan mode and slash expansion disabled; requested no tools, edits or actions. No runtime credentials, backups, personal media or private logs were sent.

Initial packet: 13,830 bytes; SHA256 `a1b466107a2df8483bd44d4e585e37e9424998e1d2825ba86416e326845f4fa0`. One-turn review,17.86seconds. Supported fixes: refuse unexpected existing project bot limits; explicitly configure raw Boto3 path-style addressing with bounded timeouts. Document exact Compose interpolation invocation.

Unsupported claims were checked against exact recovered500168b source: worker entrypoint is required for PulseAudio; ApiKey has no key_prefix and get_or_create invokes save() to generate object_id. Chrome sandbox compatibility is an unverified runtime gate, not authority to disable the sandbox or add broad privileges.

Final packet:23,711bytes; SHA256 `24cb02255a9899fe2936f7cd5317dbeb9870651799514181280df4ce3fbc2311`. Includes final five files plus exact relevant upstream model/entrypoint definitions. Fresh conversation `a58a9092-1890-424e-bc84-a69578db7692`; reviewer returned PASS/no findings in22.43seconds/one turn. Local two preparation tests pass (exclusive destination/refusal, retained bytes, secret separation, volume/port/isolation defaults); no Docker/backend/network is imported by those tests.

Runtime acceptance still required: Compose parse, isolated DB/API/storage readiness, local sandboxed Chrome probe, then authorized Meet captions/audio/threads and owner/reconnect checks. No end-to-end acceptance or Site publication is claimed.

## Final file hashes

- `attendee_stack/recovery/README.md`: `23eab6509088ae3a6dc7ab26ba405e9ff31fdab86341c7cb4b4f0b667e1f6feb`
- `attendee_stack/recovery/bootstrap.py`: `3ce9a0a406d1b1b1cc8fb04379de7853dd4e42cd5c6f38b0d03bfdf0eaea5ae8`
- `attendee_stack/recovery/prepare.py`: `c920943228a5e5ccb4f8039cc895999e0e991146c1b917e5cd3760790d50a3e3`
- `attendee_stack/recovery/settings.py`: `596feeee101f0d06a5ae8849b9cf4bd0720c96389a36c5cbd3c9405d978cf9cd`
- `attendee_stack/recovery/test_prepare.py`: `0480be88742dc5322dfeba24b138a0a19195884a804458ad0088ccf242f93bfd`
