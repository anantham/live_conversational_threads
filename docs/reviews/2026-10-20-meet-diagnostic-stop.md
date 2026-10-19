# Exact-worker diagnostic stop reviews

Existing Google Gemini 3.8 Flash Low through AGY subscription; code/synthetic-only read-only reviews under the standing authorization. No real room URL, credentials, participants, transcripts, private logs, raw artifacts/media, personal memory or unrelated source. Fresh clean review directories; sandbox/new conversation/no slash commands; plan control is best-effort as previously documented. No purchase or metered proxy.

## Initial guard — bbd8bfe908ba02696bbf6d3ac9032a310a686a19

Four complete tracked operational files: stop_diagnostic_worker.ps1, check_stop_guard.ps1, create_diagnostic_once.py, run_diagnostic_once.ps1. Packet 17,328 bytes; SHA256 c709cbdfb2fed9b3c186894be4d9c87c6371b802656fc91836ca1b6bf67f841f. Conversation 7cbab019-73ea-4f83-a2f3-650bc74c571c, 21.55 seconds, SUCCESS/PASS/findings[]. Real dry-run schema/identity/refusal checks passed before activation.

Actual diagnostic later exposed an operational design defect despite PASS: clock began before preflight/dispatch, leaving the bot only 54.778 seconds before stop. Actual stop and retention succeeded. Parent reported false failure using a nullable cached Start-Process ExitCode. The stopped bot yielded no first-failed UI artifact. Review receipt does not imply capture success.

## Dispatch-clock repair — 3b42a790cb2350714a8a7b4a996dd15c40cd6c9b

Five complete tracked operational files above plus test_stop_handshake.ps1 and tests/intent/meet-diagnostic-window.md. Packet 24,017 bytes; SHA256 89aadc0d198c40c0388435aac7c8e500e9a7349cb905be175595aca68992e0d8. Conversation fa6be998-5a13-48af-8cc1-bd0f05c14063, 15.71 seconds, SUCCESS/PASS/findings[].

Change: wait at most 120 seconds idle for one explicit Begin; acknowledge an 85-second dispatch deadline before UI Join; retain exact supervisor identity and active-deadline checks. Preserve old guard directory with a new v2 path. Determine completion from exact persisted stop receipt and actual Docker state. Same image/user/sandbox/service/key/routes; actual stopped-holder precondition refuses.

Validation: actual check exit0/16.10s; PowerShell syntax; real four-terminal-bot serializer/deepcopy/wire; stopped-holder refusal; isolated production handshake prefix valid, missing, wrong worker, 100-second and 1-second deadlines. No actual v2 timer, restart, bot or inference call. Synthetic handshake ends before unchanged Docker action; prior actual exact-worker stop independently verifies that action. Product/9UI tests unchanged; passing 1106 combined/build and9UI evidence reused within their scope. Additional bot still requires an explicit allowance; this review is not deployment/runtime permission or final Meet acceptance.
