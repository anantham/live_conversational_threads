# Sites public entry and optional sign-in — independent review

Status: final bounded source independently approved. Native publication/browser verification is in progress at this checkpoint. Public/private cloud saves and Soniox remain subsequent stages.

Scope: lct_app/src/App.jsx, src/pages/Home.jsx, sites/frontend.config.mjs, src/components/SitesAccessPanel.jsx and its test, src/App.sites.test.jsx, src/pages/Home.sites.test.jsx, tests/intent/sites-optional-access.md, sites/README.md. Exact nine-file staged diff plus complete bounded App/Home/panel/config/readme/Worker context only; no credentials, user identities, data, recordings, transcripts or operational history.

Packet: 55,789 bytes; SHA256 `3c1387ee3513f025c62526c79019e123052e2d3f58612a5f5cfaeb87c95914c8`.

Google Gemini 3.1 Pro (`gemini-3.1-pro-low`) via authenticated AGY returned **PASS**, no actionable findings, one turn in 19.7 seconds, zero tool calls. Existing credits only. The previously verified all-tool denial hook was checked active before sending source. No findings were fixed or rejected; no actionable overclaim needs arbitration. The reviewer called the preview read-only/public-only; this approval applies to the actual diff and must not imply storage authorization exists. Existing BYOK proxy routes remain, and public/private cloud save routes are absent.

Root integration caught a session-schema mismatch before independent review: the UI expected a top-level id while the Worker returns user.id. Corrected it, added a malformed-shape rejection and made the successful UI test consume the actual Worker response with a synthetic identity. This was an integration finding, not a Gemini finding.

Validation:10/10 focused behavior tests pass (public shell without legacy health/key reads, actual Worker-to-panel contract, malformed/non-200 responses, retry, slow/timeout/unmount, bounded payload-free timing). Scoped ESLint and staged whitespace pass. Complete client/Worker build passes (client9.76seconds, Worker32ms), as do both-output checks, ambient-secret marker exclusion and compiled Worker identity/SPA smoke without external network. Existing large-chunk warning persists. Required full-suite pre-push result will be appended after completion.

Native HTTP boundary evidence: access mode public revision2; anonymous root200, anonymous session401/false, forged caller identity401/false, service bearer alone401/false and service bearer with forged identity401/false. No private records or real recordings were involved. Signed-in browser verification is pending the new visible session panel.
