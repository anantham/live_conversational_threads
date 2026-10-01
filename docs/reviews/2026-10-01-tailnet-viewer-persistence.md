# Tailnet viewer persistence review receipt

Final independent approval is **blocked**, so PR 204 remains a draft. The
runtime is serving and browser-verified; that is not a source-review verdict.

## Authorized packet

Base: `59dea4cb94f847af10b1b21c23c63df006177c96`.
Source heads: initial `1b4a72593f8f5bcfa7e1f0e541e42bc9f302a33d`, revised
`e68113da2b7bc2e0c58fdea6b67d3d0310880507`.

Exact tracked file inventory:

- `ops/tailnet-viewer/README.md`
- `ops/tailnet-viewer/install-task.ps1`
- `ops/tailnet-viewer/serve-viewer.mjs`
- `tests/intent/tailnet-viewer-persistence.md`

Each outgoing packet was manually inspected and scanned for credential/token
patterns. Excluded runtime files, recordings, transcripts, screenshots,
participant/customer data, credentials, unrelated files and private artifacts.
Only exact tracked source, intent and redacted validation summaries were sent
under REVIEW-EGRESS-A1. Reviewers had no repository tools or write authority.

## Anthropic Claude Sonnet5

- Existing authenticated Claude subscription; tool-free CLI with safe mode,
  custom system prompt, empty working directory and strict MCP configuration.
- Initial packet: 11,924 bytes; SHA-256
  `4f5e4978b53b3f74567070f4148ef9022ab964f8efabcfdb0c18da9010203166`.
- Verdict: findings. One supported low-severity race: the old timer could
  restart the task while the installer replaced it. The revised installer
  disables the owned task before stopping it and explicitly enables the new
  registration. Actual reinstallation passed afterward.
- Final packet: 12,451 bytes; SHA-256
  `5462ace853a2284e63b5d9e3650ad6f0b2c47d20c5184c18da9f8631f8ac3840`.
  No final verdict: the subscription's weekly limit prevented the review.
- Harness limitation: the CLI returned an event array. Its first completed
  report was recovered from the terminal result event after correcting the
  local parser; that review was not repeated to repair parsing.

## Alternative families

- xAI Grok CLI reported that it was not authenticated. No source packet sent.
- Google Gemini CLI was configured with an empty core-tool allowlist, no MCP
  servers/extensions, an absent context filename and a bounded custom system
  prompt; these controls were verified against the installed CLI source.
  Cached OAuth authentication was retained; API-key/Vertex credential variables
  were excluded. No new project, credential, permission or paid usage was added.
- Requested Gemini2.5 Pro; final source packet was identical to the revised
  Anthropic packet, plus a 232-byte system prompt (12,683 bytes total).
  Review did not run: ProjectIdRequiredError. No approved Google Cloud project
  was configured in process, user or machine environment. The user was asked
  for an existing approved project; no project was guessed or created.
- There are no disputed independent-review overclaims awaiting arbitration.
  The final approval itself remains outstanding.

## Validation and limits

Actual scheduled launch is owned by Windows' task service and uses a directory
visible to that process. Task stop releases its port without an orphan. A
forced serving-process exit recovered on the periodic trigger after36seconds;
healthy ticks retained the same process. Installer replacement passed after
the review finding was fixed. Missing Vite startup dependency logs its cause
and exits1. JavaScript and PowerShell syntax checks passed.

Chromium loaded the exact Tailnet conversation URL, switched to Discussion and
expanded an arc, with zero page errors/failing origin responses. The broader
browser suite had six passes, two failures, one skip; a separate existing
device-library save/navigation race is recorded in ISSUES.md. The mandatory
pre-push frontend unit gate passed446/446tests in72files (40.55seconds).

No actual reboot/logon was performed. Logon recovery is configured; the host
must be awake with the user signed in. Screenshots and runtime diagnostics stay
local and are excluded from review/publication. The dirty deploy checkout and
other services/routes were preserved.
