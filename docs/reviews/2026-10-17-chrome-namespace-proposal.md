# Inactive Chrome namespace proposal — 17 October 2026

Scope: only the new isolated recovery worker; no live activation. The actual
non-root Chrome probe refused namespace creation (exit134), while user namespaces
are enabled in the kernel. Sandbox remains enabled. See proposed/README.md for
risk, explicit H1 permission boundary, bounded probe/pilot and rollback.

Independent family: Google Gemini, gemini-4-argon-medium, existing authenticated
AGY subscription, fresh plan/read-only review. Public code/design packet only;
no runtime files, credentials, private logs, accounts, participants or Meet URL.
Files: proposed README.md, profile-provenance.json, compose-overlay.json,
chrome-namespace-profile.json and stock-chrome-profile.json.
Packet34844bytes; SHA2569f314d133f1d866dbb5c3c70c2a7d1983dd4f328d286364ba26195ec6e128a52.
Conversation292dce5a-efed-469e-a63d-8b60c1a02a7b; SUCCESS/PASS,25.698s,one turn.
No findings. Practical no-tools request and plan mode used; no exhaustive client
context-isolation claim is made. The subsequent README edit changes spacing only.

Local structural assertion proves all33 baseline syscall blocks, architecture
map and other fields are retained semantically, with exactly one appended rule
allowing clone,setns,unshare. Reviewer prose incorrectly called the baseline28
blocks; use the actual local assertion, not that count. Existing clone3 ENOSYS
rule is unchanged. Provenance binds installed engine285b471 and its seccomp
v0.2.3 dependency to immutable origin836ae4d.

No profile is applied and no sandbox-success claim follows from review. Human
approval is pending for a25-second no-network/no-data-mount probe and at most one
five-minute synthetic pilot, followed by actual HostConfig and UID checks. A
failure leaves the worker stopped without further permission widening.
