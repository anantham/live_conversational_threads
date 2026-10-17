# New Windows runtime ACL correction — 17 October 2026

Root prepared a fixed-path, no-write-by-default repair for only the new isolated runtime directory and its six enumerated files. It preserves the original ACLs in an exclusive backup, grants only the verified interactive account SID and SYSTEM, sets ownership, checks the resulting two-account DACL and compares runtime.env hashes. It starts no service. Actual application is pending the user response required by the repository startup loop limit.

Existing authenticated Google Gemini4ArgonMedium reviewed saved public source/README only; no credential contents, recording data or private logs. First packet9359bytes/SHA25694fa20c948823bc3833349267c3200e1fae63c00a3bad3497801f38baa8292d1 returned conditional findings. Supported repairs explicitly require the existing elevated SSH session to be the same user as the limited interactive task and reject reparse points in every parent. Protected explicit child DACLs and refusal to overwrite a prior rollback after partial failure are intentional; they do not grant broader access or silently retry.

Final fresh review PASS11.78seconds, conversation8ffb4bb1-c315-4487-8ee9-303b28faee9a; packet10212bytes/SHA256a0f342fb94d007d81c4667a9c2a2bfdfb2c6bee6f0aef5063cc14e859e155dd0. Actual Windows dry run passes with the verified adity account and exact six-file inventory; permissions/content remain unchanged. The post-apply actual limited-task file-open check, service startup and rollback behavior have not been exercised. This receipt is not runtime readiness.

Test exception: this one-time OS repair is tested by its actual no-write Windows preflight and mandatory fail-closed postconditions. It is not covered by the unrelated Python/React test counts.

## Source hashes

- `attendee_stack/recovery/repair_windows_acl.ps1`: `2a38779d6674466b7e427864b3a4d0a1268bc487d13af710f72f94599d6c4106`
- `attendee_stack/recovery/README.md`: `d7a6a0c05380a8e46142ba522dc0ed03aba1696603b594a152f91a3150e805dd`
