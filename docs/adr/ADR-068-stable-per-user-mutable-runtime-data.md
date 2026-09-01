# ADR-068: Stable Per-User Mutable Runtime Data

- **Date:** 2026-09-01
- **Status:** Approved
- **Group:** Runtime data / durability / operations
- **Related:** ADR-063, ADR-067

## Issue

The attendee-session registry was stored below the repository as
`data/attendee_sessions.json`. A repository checkout is source code, not a
durable data boundary: changing branches or worktrees, pruning an old checkout,
running tests, or broadly staging files could move, overwrite, or disclose
mutable meeting-bot state. An archived checkout also retained older real
records, while the active checkout contained newer records mixed with six
known synthetic test fixtures. Selecting only one copy would lose state;
blindly unioning every record would promote test data into the canonical
registry.

## Decision

Mutable attendee-session state defaults to the operating system's conventional
per-user LCT data directory:

| Platform | Default LCT data root |
| --- | --- |
| Windows | `%LOCALAPPDATA%\LCT` |
| macOS | `~/Library/Application Support/LCT` |
| Linux | `$XDG_DATA_HOME/LCT`, falling back to `~/.local/share/LCT` |

The attendee registry lives at `data/attendee_sessions.json` below that root.
`ATTENDEE_SESSION_REGISTRY_PATH` remains the highest-precedence explicit
deployment and test override. Repository-local `/data/` is ignored and is not
the production default.

Migration is an explicit, backup-first operation rather than an application
startup side effect:

1. The operator supplies every preserved source. An existing destination is
   automatically included as the first input.
2. Every input must be UTF-8 JSON with a top-level object, object-valued
   records, and a `conversation_id` matching each record key.
3. Different records with the same identity stop the migration before backup
   creation or destination replacement. Identical duplicates are harmless.
4. Known synthetic records may be removed only through a validated,
   source-specific exclusion manifest. The manifest itself is backed up and
   cannot exclude records absent from that exact source.
5. Every source, prior destination, and exclusion manifest receives a
   byte-for-byte verified backup under the destination's
   `migration-backups/` directory.
6. The merged registry is written to a same-directory temporary file, flushed
   with `fsync`, atomically replaced, and read back for structural and content
   verification.
7. No source, destination backup, manifest, or excluded record is deleted.

The application reads the new path through one runtime-path function. Unit
tests always inject a temporary registry path, so test execution cannot write
synthetic state into a checkout.

## Considered positions

1. **Keep repository-relative storage and strengthen `.gitignore`.** Rejected:
   ignore rules reduce accidental commits but do not make branch/worktree
   cleanup a durable data lifecycle.
2. **Copy only the newest registry.** Rejected because file recency does not
   prove record completeness and would discard the archived history.
3. **Blindly merge every object.** Rejected because conflicting identities and
   known test fixtures would silently contaminate production state.
4. **Use a platform data directory with explicit fail-closed migration.**
   Chosen because source-code lifecycle and mutable-state lifecycle become
   independent, while every pre-migration byte remains recoverable.

## Consequences

- Branch and worktree cleanup no longer relocates or deletes the live attendee
  registry.
- Tests must supply `ATTENDEE_SESSION_REGISTRY_PATH` or use the shared isolated
  fixture; code that assumes a repository-relative registry is invalid.
- Operators must run the migration deliberately when adopting this decision.
  The service does not guess between multiple historical copies at startup.
- Backups retain excluded synthetic records and all prior copies. Disk usage is
  intentionally traded for reversibility until a separately reviewed retention
  policy exists.
- The path abstraction is cross-platform, while the completed production
  migration described below was performed on Windows.

## Migration evidence

The approved Windows migration preserved an archive containing 293 canonical
records and an active-checkout source containing 22 records. A validated
source-specific manifest quarantined six known test fixtures, leaving 16
canonical active records. The resulting per-user registry contains exactly 309
records. The current authoritative file is 92,392 bytes with SHA-256
`093ad41e26374e7746fad151eb83be8bc1989a47db75d86c6344fb87da2fefcc`.

All three inputs—the archive, active source, and exclusion manifest—were copied
and byte-verified in one run-specific directory below
`migration-backups/`. No source was deleted and no canonical identity conflict
was observed. A supervised backend restart subsequently read the stable path.

## Validation contract

- Platform-specific defaults and override precedence have public behavioral
  tests.
- Migration tests cover disjoint merge, existing-destination idempotency,
  byte-for-byte backups, source-specific exclusion, conflict failure, invalid
  input failure, source preservation, and atomic replacement cleanup.
- Attendee-bridge tests use a temporary registry and leave repository data
  untouched.
- Operational verification compares the authoritative registry's record count
  and SHA-256 before and after service restart and repository cleanup.

## Rollback

Set `ATTENDEE_SESSION_REGISTRY_PATH` to a selected preserved source or verified
backup, then restart the backend. Do not copy over or delete the per-user
registry during rollback. A future destructive cleanup requires a fresh
manifest, exact hashes, and separate human approval.
