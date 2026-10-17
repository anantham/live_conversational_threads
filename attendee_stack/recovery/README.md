# Isolated Asus Attendee recovery

Prepare a fresh directory outside Git/build context with `python prepare.py <new-directory>`.
This does not start services, copy old data, join a meeting, or enable public access.
On Windows, restrict that new directory to the current owner and SYSTEM before using it.
Keep `runtime.env` private; never include it in source, reviews, archives or console output.

The image `lct-attendee:recovery-500168b1` must first be built from exact upstream
`500168b15b105576ebc11cc43bdaed3eb87d39da`, without a runtime `.env` in its build context.
Use the existing interactive Windows session for Docker credential-helper access.
Check native exit status before interpreting an empty inventory or claiming success.

Every command below runs **from the generated runtime directory** and explicitly
passes `--env-file runtime.env`: service `env_file` is not Compose interpolation.

1. `docker compose --env-file runtime.env -f compose.json config --quiet`
2. `docker compose --env-file runtime.env -f compose.json up -d postgres redis minio`
3. `docker compose --env-file runtime.env -f compose.json run --rm app python manage.py migrate --noinput`
4. `docker compose --env-file runtime.env -f compose.json run --rm app python /recovery/bootstrap.py`
5. `docker compose --env-file runtime.env -f compose.json up -d app`

Stop on any failure. Bootstrap can be retried after a storage startup failure with
the same generated credentials; it refuses unexpected keys/limits or existing bots.
Verify the real API rejects anonymous calls, accepts the generated API credential,
lists no bots, and the private bucket is writable/readable before enabling workers.
The API publishes only `127.0.0.1:8088`; Redis, Postgres and MinIO have no host ports.
There is no scheduler, public ingress, or meeting auto-start.

The worker is opt-in with `--profile bot up -d worker` only after readiness checks.
Its upstream entrypoint is intentional: it starts the required PulseAudio null sink
for recording. Chrome's sandbox remains enabled. Verify a local headless Chrome
probe before a meeting; do not disable the sandbox or add broad privileges to make
a failing probe pass. Namespace/seccomp compatibility is not yet established.

All three volumes have the unique `lct-meet-recovery-20261017_` prefix. Before first
startup, verify these names do not already exist; an existing name requires inspection,
not adoption as an empty fixture. Preserve the earlier anonymous Docker volume.
Use `down` without `--volumes` to stop this stack. Never prune or delete old volumes.

This stack is preparation only. Site owner authorization, caption delivery,
audio playback, live thread generation, cancellation and reconnect remain separate
acceptance checks; an image build or mocked test is not end-to-end proof.
