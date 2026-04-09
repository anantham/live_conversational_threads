# ADR-025: WSL WhisperX Launcher Ownership and Line-Ending Durability

- Status: Approved
- Date: 2026-04-09
- Group: integration / runtime operations

## Context

The live Whisper websocket path for LCT depends on an actual WhisperX service running on the remote Windows host's WSL Ubuntu instance at port `8001`.

During live-STT validation, there were two sources of operational drift:

- the real runtime behind `8001` was a long-running WSL `uvicorn whisperx_server:app` process that could remain stale after code changes landed on disk
- restart paths were inconsistent: some code launched inline `uvicorn`, while the checked-in service launcher was `services/transcription/run_whisperx_server.sh`

When the launch path was standardized, a second durability bug surfaced immediately: the WSL-mounted `run_whisperx_server.sh` file on the Windows host had CRLF line endings, so `bash` failed on `set -euo pipefail` even though the repository copy was valid. That made the "canonical" launcher non-durable until line-ending handling was made explicit.

## Decision

IndrasNet will treat `services/transcription/run_whisperx_server.sh` as the canonical launch contract for the remote WhisperX WSL service.

All repo-owned start and restart paths that manage the WSL WhisperX service must route through that script instead of embedding ad hoc `uvicorn whisperx_server:app` launch strings.

The repository will also enforce LF endings for shell launchers via `.gitattributes` so WSL-mounted startup scripts do not regress into CRLF-broken state.

## Positions Considered

### 1. Keep inline `uvicorn` launch strings in multiple places

Rejected.

This makes runtime drift likely because one path can restart a different command than the one operators believe owns the service.

### 2. Use the checked-in shell launcher as the single source of truth

Accepted.

This keeps startup semantics in one file and makes validation of the actual runtime path much easier.

### 3. Ignore line-ending policy and rely on local editors/tools

Rejected.

The failure mode is silent until WSL tries to execute the file. Shell launchers need repository-level protection.

## Rationale

- A single launch contract is easier to inspect, restart, and document than multiple embedded commands.
- The WSL runtime is operationally separate from the Windows web server, so restart ownership must be explicit.
- `.gitattributes` is the least surprising durable place to protect shell launchers from CRLF regressions.

## Consequences

### Positive

- Remote WhisperX restart behavior is now aligned with the checked-in launcher script.
- Future code syncs are less likely to leave `8001` serving stale logic after a restart.
- Shell launcher portability is improved for WSL-mounted execution.

### Negative

- The launcher story is still split across Windows Scheduled Task startup for `7777` and WSL startup for `8001`; there is not yet one top-level supervisor for both.
- Manual file syncs performed outside Git can still reintroduce CRLF on the remote host if they bypass the repository checkout.

## Implementation Notes

- Canonical WSL launch path:
  - `TemporalCoordination/grimoire/IndrasNet/services/transcription/run_whisperx_server.sh`
- Repo-owned callers updated to use that script:
  - `TemporalCoordination/grimoire/IndrasNet/agents/routes/services.py`
  - `TemporalCoordination/grimoire/IndrasNet/core/gpu_backends.py`
- Line-ending guardrail:
  - `TemporalCoordination/.gitattributes`

## Follow-ups

- Add an explicit operator-visible way to restart and inspect the WSL WhisperX service from IndrasNet UI or service controls.
- Investigate whether the WSL `8001` service should be supervised more formally instead of relying on detached shell launch.
- Confirm the remote host's normal code-sync path uses Git checkout semantics so `.gitattributes` protection is actually applied in practice.
