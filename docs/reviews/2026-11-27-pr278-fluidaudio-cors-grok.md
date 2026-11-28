# PR #278 independent review — FluidAudio STT CORS

- Date: 2026-11-27 IST
- Author family: Anthropic (Claude). Reviewer family: xAI.
- Reviewer: Grok 4.5 through the `grok-review -m grok-4.5` tool (self-reported "Grok 4.5 (xAI)"), existing subscription.
- First choice was Gemini 4 Argon (High) through Antigravity; it refused with HTTP 429, individual quota reached, so no Gemini review ran.
- Reviewed head: `08b3847a`. Packet: review brief, `git diff origin/main...HEAD` for `local_stt/fluidaudio_stt`, the full `main.swift`, and four Swifter 1.5.0 excerpts. Code only, scanned for secrets. SHA256 `4f0f3306d4624bece9df9d4c6d0f00332fe0ec48ca4289fbc2ca3d660c1c439e`, unchanged after the run.
- Verdict: FINDINGS (6). Three accepted and fixed in the follow-up commit, two rejected, one left to the owner.

| # | Finding | Severity given | Decision |
|---|---|---|---|
| F1 | The 204 preflight reply has no `Content-Length`; a proxy might stall on it | should-fix | Rejected. HTTP forbids `Content-Length` on a 204, and the reply closes the connection. Not yet observed through Tailscale Serve; check at deploy. |
| F2 | `Access-Control-Allow-Headers` is fixed at `Authorization, Content-Type`; another custom header would fail preflight | should-fix | Rejected as a code change. The only client (`m5TailnetFileSession.js`) sends `Authorization` at most. README now states the limit. |
| F3 | `*` mixed with other entries allowed no origin at all | should-fix | Accepted. A list containing `*` now allows any origin, as `local_stt/server.py` does. Checked on port 5097. |
| F4 | An allowlist entry with a trailing slash never matched | nit | Accepted. Trailing slash is dropped. Checked on port 5097. |
| F5 | Default `*` plus `Access-Control-Allow-Private-Network` lets any website open on a tailnet device call the server and read replies | should-fix (security) | Left to the owner. The owner chose the wildcard default before implementation. The reviewer's claim that replies expose "sensitive audio text" does not hold: the server stores nothing, so a reply describes only the audio the calling page sent. What is real is that such a page can use the M5's compute, and that the private-network grant may let through requests Chrome would otherwise block. README now says so and names the allowlist as the remedy. |
| F6 | README implied allow-origin always accompanies a preflight | nit | Accepted. README reworded. |

Checked and found sound by the reviewer: header-name case handling, both routes wrapped, callers without `Origin` unchanged, the `OPTIONS` middleware's scope, the `.raw` pattern match and header merge, globals read from GCD threads, the port parse, `Vary: Origin`.

Not established by the reviewer: parity with `server.py` (not in the packet), Tailscale Serve's handling of the 204.

The follow-up commit (F3, F4, F6 and README notes) has not been reviewed by a second family.
