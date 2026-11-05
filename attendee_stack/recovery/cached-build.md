# Bounded public-package cache build

The unchanged upstream image reached the118.5MB Zoom SDK wheel but failed with a
PyPI ReadTimeoutError after92.9MB. No dependency incompatibility was observed at
that boundary. A plain retry loses the failed Docker RUN layer's package cache.

prepare_cached_build.ps1 writes one new public Dockerfile outside the clean
upstream context. It requires absolute paths and refuses an output nested in the source context.
It retains exact source500168b and requirements bytes, replacing
only the pip requirements RUN line with a dedicated BuildKit package cache,
120-second read timeout and one HTTP retry. It does not disable TLS, change an
index/provider/version, add privileges, modify the source checkout or start Docker.
Only public downloaded packages go in this new named build cache, no credentials
or recordings. Upstream sentry-sdk already has a version range; this repair does
not add or tighten dependency constraints. Do not describe the derived recipe as
an unchanged upstream Dockerfile.

Run preparation with explicit SourceDirectory and a new OutputDirectory outside
that checkout. Keep runtime.env outside both paths. Validate prepared.json, actual
one-line delta, clean source and requirements hash before one bounded build:
`docker build --pull=false --progress=plain -f <new-Dockerfile> -t lct-attendee:recovery-500168b1 <clean-upstream-directory>`.
Use the existing limited interactive Docker account and a separate native exit/log
receipt with a two-hour task limit. Do not overwrite an existing image tag. On
failure, preserve cache/logs and stop this method rather than retrying automatically.
Success still requires actual imports, isolated API/S3 and worker readiness, not
only an image tag. Rollback omits the derived recipe; no data volume is deleted.

Test exception: this Windows-only public recipe constructor is checked with its
actual Windows parser and preparation receipt, plus explicit one-line structural
comparison. No new mock-only Pester suite or module installation is needed.
