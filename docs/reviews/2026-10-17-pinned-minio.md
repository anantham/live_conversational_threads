# Pinned local MinIO packaging — 17 October 2026

Scope: same official release, local image for only the new recovery storage
service. No old volume, credentials, account or provider change. Actual Debian
asset bytes41324592/SHA256d8898351831761e083e7ba6b74ea7ec478b9a6680794fe92e5e838145341c9c5
match the official release; package metadata verifies usr/local/bin/minio.

Independent family: Google Gemini, gemini-4-argon-medium, existing authenticated
AGY subscription, fresh plan/read-only review. Public source only: recovery
prepare.py,test_prepare.py,README.md,minio/Dockerfile,minio/README.md. Excludes
runtime.env, private runtime files/logs, old volumes, account/meeting data.
Packet18823bytes/SHA25699ee8dcfc92bcbff03ca55e80cf899646f5d5b1452496627a3a9c0c6200c5763.
Conversation224b0d30-9f8e-4ff2-9793-35c91c5c631e; SUCCESS/PASS,5.132s,one turn,
no findings. Practical no-tools request and plan mode; no exhaustive isolation claim.

Four focused preparation/range checks pass from the recovery directory. Initial
root invocation of both modules failed because audio_range is a sibling import;
correct working-directory invocation passes without source/test changes.
Dockerfile verifies checksum and extracts only binary, executes no maintainer
script, retains exact base digest, and runs UID1000. Compose pull_policy=never
prevents an implicit registry fallback. Build/version/private S3 read-write-range
and anonymous refusal are pending runtime evidence, not manufactured by review.
