# Sites public entry and optional sign-in — independent review

Status: final bounded source independently approved. Native publication/browser verification is in progress at this checkpoint. Public/private cloud saves and Soniox remain subsequent stages.

Scope: lct_app/src/App.jsx, src/pages/Home.jsx, sites/frontend.config.mjs, src/components/SitesAccessPanel.jsx and its test, src/App.sites.test.jsx, src/pages/Home.sites.test.jsx, tests/intent/sites-optional-access.md, sites/README.md. Exact nine-file staged diff plus complete bounded App/Home/panel/config/readme/Worker context only; no credentials, user identities, data, recordings, transcripts or operational history.

Packet: 55,789 bytes; SHA256 `3c1387ee3513f025c62526c79019e123052e2d3f58612a5f5cfaeb87c95914c8`.

Google Gemini 3.1 Pro (`gemini-3.1-pro-low`) via authenticated AGY returned **PASS**, no actionable findings, one turn in 19.7 seconds, zero tool calls. Existing credits only. The previously verified all-tool denial hook was checked active before sending source. No findings were fixed or rejected; no actionable overclaim needs arbitration. The reviewer called the preview read-only/public-only; this approval applies to the actual diff and must not imply storage authorization exists. Existing BYOK proxy routes remain, and public/private cloud save routes are absent.

Root integration caught a session-schema mismatch before independent review: the UI expected a top-level id while the Worker returns user.id. Corrected it, added a malformed-shape rejection and made the successful UI test consume the actual Worker response with a synthetic identity. This was an integration finding, not a Gemini finding.

Validation:10/10 focused behavior tests pass (public shell without legacy health/key reads, actual Worker-to-panel contract, malformed/non-200 responses, retry, slow/timeout/unmount, bounded payload-free timing). Scoped ESLint and staged whitespace pass. Complete client/Worker build passes (client9.76seconds, Worker32ms), as do both-output checks, ambient-secret marker exclusion and compiled Worker identity/SPA smoke without external network. Existing large-chunk warning persists. Required full-suite pre-push result will be appended after completion.

Native HTTP boundary evidence: access mode public revision2; anonymous root200, anonymous session401/false, forged caller identity401/false, service bearer alone401/false and service bearer with forged identity401/false. No private records or real recordings were involved. Signed-in browser verification is pending the new visible session panel.

## 2026-10-02 native checkpoint and final navigation follow-up

- Optional-access source d903841 is pushed; its required pre-push gate was472/472tests in77files,28.96seconds. The exact source standalone commit553ebc61357798fc03f9ce752c7df25b75255749 was packaged without unrelated artifacts and published successfully as appgdep_6abea6ed2754819195d3b838be1d63f7, native version2. Public access persisted. Actual browser session panel shows Signed in and sign-out link; no identity is displayed. Anonymous root200/session401 and spoof/service checks remain verified.
- The owner-only combined publication helper saved the exact version but refused deployment because the Site was now public; its response explicitly stated no deployment started. Reused that returned saved-version ID with the standard deployment operation, which succeeded. This was a mechanical route mismatch, not missing human authorization; no audience was widened beyond the user's explicit request.
- Real Browse interaction identified inherited owner-audio requests and direct Browse refresh lost its path through a307same-origin-root redirect. Scoped follow-up excludes Sites owner sections/requests and handles canonical shell redirects internally, preserving auth/external/query/file/API outcomes. Exact seven-file diff plus full Browse/Worker technical context:49,052bytes, SHA256912e8e0e9881ad1ab96d6a67b52d5deecda47540b7f69bdc5246c30776db05a6. Google Gemini3.1Pro-low through AGY returned PASS/no findings,8.5seconds, zero tool calls; existing credits and verified denial hook only. No findings fixed/rejected or unresolved overclaims.
- Correct-cwd follow-up validation17/17tests (15Worker/2Browse), scopedlint, whitespace, client17.00s/Worker49ms build, both-output guard and compiled smoke pass. A parent-cwd test invocation failed due to the wrong JSX transform; corrected the invocation without product/test edits. Native deployment/URL verification follows.

## Final native verification — 2026-10-02

Standalone source17db1265664bb07446cbcdd27f354afb43702cdd was pushed, built and packaged by the official workflow; native version3/appgdep_6abeaa70185c8191911e77f04eee8c59 returned succeeded. Actual anonymous requests now return root200, /browse200 and /browse/200 without redirect; session401/false, caller-forged identity401/false and unsupportedAPI404 remain. This confirms the canonical-shell hypothesis for this deployment; no broader redirect behavior is inferred.

Actual browser refresh preserves /browse, excludes owner recording/server-history sections and shows the real Signed in session after its nonblocking check. Browse/Back interaction works. Desktop and narrow viewport were checked; at the narrow view the access panel remains within391px width and844px height, with no horizontal page overflow. Reset the temporary viewport and left the preview open. Screenshots outside source contain no actual user identifier/email or recording data.

Final canonical source4586d98 is pushed; its mandatory full gate passed476/476tests in78files,28.18seconds. No changed source remains unreviewed, no findings require fixes/rejections, and no overclaim awaits arbitration. Public/private storage and live creation remain outside this completed entry/identity checkpoint.
