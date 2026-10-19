# Isolated Asus Attendee recovery

Prepare a fresh directory outside Git/build context with `python prepare.py <new-directory>`.
This does not start services, copy old data, join a meeting, or enable public access.
On Windows, restrict the actual runtime directory and its files to the explicit
interactive-user SID and SYSTEM before using it. Restricting only its parent is
insufficient: Python's Windows `mkdir(mode=0o700)` can produce a protected child
ACL owned by Administrators, which a limited interactive Docker task cannot read.
For this exact recovery path, `repair_windows_acl.ps1` defaults to a no-write dry
run. Its explicit `-Apply` operation saves the prior ACL, refuses unexpected files
or links, and verifies the credential file's bytes remain unchanged. Apply from the existing elevated SSH session of the same user only
inside the approved recovery envelope; the script verifies that identity matches
the limited interactive Docker task. A partial failure preserves the original ACL
backup and refuses automatic retry; inspect it before restoring or continuing. Then prove the actual Docker task account
can open the configuration before any service startup. Do not grant broad Users
or Everyone access or run the task elevated to evade the missing permission.
Keep `runtime.env` private; never include it in source, reviews, archives or console output.

The image `lct-attendee:recovery-500168b1` must first be built from exact upstream
`500168b15b105576ebc11cc43bdaed3eb87d39da`, without a runtime `.env` in its build context.
Use the existing interactive Windows session for Docker credential-helper access.
Check native exit status before interpreting an empty inventory or claiming success.

The local storage image must also be built and its release verified using
[minio/README.md](minio/README.md). Its checksum-pinned official package replaces
the unavailable registry tag; Compose refuses registry fallback.

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

## Existing Site relay

The reviewed follow-on source adds `cloud_api.py` and `audio_range.py` to the
read-only mounts. When updating an already prepared runtime, replace only those
public source files, `settings.py` and generated `compose.json`; preserve the
existing `runtime.env` byte-for-byte. Do not run preparation over that directory.
The credential is project-scoped and server-side. Only bot list/create/detail,
caption snapshot, leave and private MP3 range reads are exposed; no dashboard,
calendar, speech injection or deletion endpoints are served.

The Site relay is off unless its exact owner, existing Asus HTTPS path, private
key, test window and enabled flag are configured. Its additive meeting receipt
migration preserves uncertain joins and prevents duplicate bot creation. Configure
and validate the existing Site only after local API/storage and sandbox readiness.
One active or uncertain receipt and a five-minute bot maximum bound this pilot.
The Asus must remain online. Viewer disconnect does not stop recording; AI-map
updates run only while the browser view is open with provider consent.

## Actual non-recording readiness

check_runtime.py runs only inside the initialized dedicated recovery app after
bootstrap. It refuses a different database/host, root UID and storage endpoint,
validates the real caption/MP3/five-minute creation serializer without saving a
bot, compares actual empty API/DB state, and checks private S3 exact bytes/ranges
with anonymous refusal. One uniquely named tiny synthetic object is retained.
No bot is created, no quota/provider call is made, no recording is deleted.
Authenticated API probes refuse redirects so credentials stay on the local app.
Test exception: wrong-namespace refusal is checked as an actual subprocess;
positive API/schema/S3 checks require the real isolated image/runtime and must
never be reported passed from mocks or preparation alone.


## Read-only access checks before an operator handoff

A failed SSH client is evidence about that method, not proof the Asus is asleep
or that a human must inspect it. Before an operator-only handoff, record the
failed phase and bounded attempts, inspect the available control inventory, and
check an existing approved alternative such as a saved RustDesk session when it
needs no new credential or access grant. Respect the failed method's stop limit;
never route around a permission denial, install an access agent, restart a shared
service, or widen networking to obtain a diagnostic. If the alternative cannot
be used safely, record its concrete limitation rather than assert it was tried.

For native remote-desktop diagnostics, open a separate shell and preserve existing
terminals. Verify the exact visible command before execution. If typed text or
clipboard transport drops characters/modifiers, never execute the malformed line
or infer a server/API failure from it. A short literal `get-service sshd` can prove
service status; it does not prove usable SSH authentication, source transfer,
recorder readiness or meeting capture. Restore temporary input preferences and
close only the owned diagnostic shell. Keep unrelated desktop content, clipboard
contents, credentials and event logs out of repository/review packets.
