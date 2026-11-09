# Pinned local storage image

The configured Docker Hub release is unavailable, and the pinned Quay manifest
refuses anonymous access. Package the same official MinIO release locally rather
than substitute an unverified image or change storage provider. This is only the
new isolated recovery stack; no old volume is adopted or modified.

Download the official compressed Debian asset (41,324,592 bytes):
https://github.com/minio/minio/releases/download/RELEASE.2025-04-22T22-12-26Z/minio_20250422221226.0.0_amd64.deb

SHA256: `d8898351831761e083e7ba6b74ea7ec478b9a6680794fe92e5e838145341c9c5`.
Its release source is `0d7408fc9969caf07de6a8c3a84f9fbb10a6739e`.
Actual package metadata confirms `./usr/local/bin/minio`; no path is inferred.

Use a fresh public-only build directory containing this Dockerfile and verified
asset named minio.deb. No runtime.env, credentials or recording data belong there.
Build with `docker build --pull=false -t lct-minio:recovery-20250422 .` in the
existing interactive Docker account. The exact Ubuntu base was verified against
the original Attendee build manifest and cached from Docker's ECR Public mirror.
The build extracts only the binary, executes no Debian maintainer scripts, makes
no package-network request, and the final image runs as UID1000 with default
Docker restrictions. A failed checksum stops the build.

First run only `docker run --rm --network none lct-minio:recovery-20250422 --version`.
Require the exact release before starting the isolated service. Then require the
actual private bucket write/read/range and anonymous-refusal checks before any
meeting. A version response or image build alone is not storage acceptance.
Compose uses pull_policy=never: a missing local image fails instead of contacting
an unrelated registry tag. Do not overwrite generated runtime.env. When updating
the six-file runtime, preserve all secret bytes and back up its public Compose
file before replacing only that file. Stop this stack without --volumes to roll
back; retained recordings are never deleted. Vendor software remains subject to
its existing upstream license; this packaging grants no additional rights.
