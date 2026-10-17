# Proposed Chrome namespace permission — inactive

Actual non-root Chrome 134 probe exits 134 with namespace creation denied under
the installed Docker 29.5.3 built-in seccomp filter. Kernel user namespaces are
enabled, UID 1000 has zero effective capabilities, and no meeting was contacted.

This candidate retains every rule from the exact engine dependency
`github.com/moby/profiles/seccomp v0.2.3` and appends only an allow rule for
`clone`, `setns`, and `unshare`. The engine build commit and immutable module
origin are in profile-provenance.json. This follows Playwright's documented
namespace approach while retaining the current engine's stock rules, rather
than using its older complete profile. Upstream profile license is retained.

These calls expose additional kernel functionality inside the selected container.
Chrome remains non-root and sandboxed; no administrator capability, host network,
Docker socket or old data mount is added. The proposed overlay changes only the
worker; app, database and storage keep their defaults. Nothing here is activated.

Reserved human judgment: kernel permission expansion requires explicit approval
under docs/AUTONOMY_AND_AUTHORITY_POLICY.md H1. Prior permission for six runtime
file ACLs does not authorize this change. Recommendation: approve one isolated
no-network probe first, then the one-bot five-minute synthetic pilot only if it
passes. Confidence 0.9; fallback leave the worker stopped if it fails, without
further widening. Defer/native VM hosting remains available for a later decision.

On approval, copy the candidate to the private runtime's parent as
chrome-namespace-profile.json and use the overlay only for the worker. Probe has
no network or data mounts and a 25-second process bound. Verify actual HostConfig
and UID/sandbox readiness before enabling any meeting. Stop the worker and omit
the overlay to restore Docker's built-in profile; retained recordings are not
deleted. Production use beyond this synthetic pilot needs its own scope decision.

References:
- https://playwright.dev/docs/docker#crawling-and-scraping
- https://raw.githubusercontent.com/moby/moby/285b47192d4b2f183aba5dd360a92cd52d723004/go.mod
- https://github.com/moby/profiles/tree/836ae4d37ef2ec995c77c99fc55f5b5f3af3a897/seccomp
