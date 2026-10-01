# Parallel Site build and identity endpoint — independent review

Status: source independently approved and the parallel Site is published. The browser has passed ChatGPT sign-in and reached the app; authenticated identity response verification is pending. This is milestone 1 infrastructure for the staged migration, not completion of private recordings, Soniox, cloud intelligence or the custom-domain cutover.

## Exact source scope

- lct_app/.openai/hosting.json
- lct_app/package.json
- lct_app/sites/README.md
- lct_app/sites/build.mjs
- lct_app/sites/export-source.mjs
- lct_app/sites/frontend.config.mjs
- lct_app/sites/worker.js
- lct_app/src/services/serverless/sitesSource.test.js
- lct_app/src/services/serverless/sitesWorker.test.js
- lct_app/tests/intent/sites-parallel-site.md

Packet:29,889bytes, SHA256 `f7930fabe6577e5a6f828c5cac463469c4a1acb011e23ddfe4f21a1eeedd6628`. Exact staged diff plus full bounded Sites modules and the specification/validation were included. No operational worklog, environment files, credentials, private artifacts, actual identities, recordings or transcripts were sent. The Site project ID is public technical metadata. Credential-pattern scan passed; ignored raw packet/receipts remain local.

## Validation

- Serverless regression suite49/49 tests in8files passed, including the session endpoint, service-token rejection, SPA fallback and source-export boundaries.
- Scoped ESLint and staged whitespace checks passed.
- Complete Sites build passed: client22.07seconds, Worker8.41kB. The existing client large-chunk warning remains.
- Synthetic ambient VITE auth-token/backend-origin markers were absent from the client JS. Client output contains only index.html, favicon.svg and compiled assets.
- Compiled Worker smoke passed without a Node process global or external network: synthetic identity200, no identity401, HTML deep-link shell and API404.
- Actual bounded source export contains243files; unrelated public artifacts, environment files and operational history are excluded. Locked dependency installation passed in the clean standalone source copy.
- Sites registration was verified owner-private with one allowed user, zero groups and zero external visitors; a sign-in client is provisioned. This metadata does not prove the actual browser sign-in or dispatch spoof protection.

## Independent result

Google Gemini3.1Pro (`gemini-3.1-pro-high`) through the authenticated AGY CLI returned **PASS, no actionable findings**. One turn took117.3seconds. The isolated all-tool denial hook was checked before sending the packet, and the actual review made zero tool calls. Existing AGY credits were used; no API-key fallback was used.

No findings were fixed or rejected, and no disputed finding requires arbitration. The review described the export destination as outside the repository; the actual checked contract is outside the frontend source directory, with empty destination and source symlink rejection. The clean Site checkout intentionally lives in the parent worktree's ignored tmp directory. Do not broaden the review's approval beyond that contract.

## Remaining native evidence

- Published standalone source commit `1b4fe21847a5c29787b60a69197ac05a104131aa`: deployment `appgdep_6abe9d6fe3a481919aa28d05b9f6e334` returned terminal succeeded at the parallel Site URL. Its archive contained compiled app assets, Worker, favicon and hosting metadata only; no owner artifacts or history.
- Verify actual managed sign-in, the resulting identity response and caller identity-header stripping. Anonymous and service access cannot stand in for a signed-in user.
- Reforecast milestone 1 after this checkpoint. Storage, Soniox, private-network-independent creation/exploration and spending gates remain subsequent work.

## Follow-up: check both build outputs

The initial output check covered the client only. The standalone export had already limited public files to favicon, so the published archive contained no unrelated artifacts. The canonical Worker configuration nevertheless inherited Vite's public-directory copy. Disabled that copy and made the build refuse unexpected entries in either client or Worker output; added the contract to test intent.

Exact three-file packet: 7,972 bytes, SHA256 `57ce694f40c2a1a7cccbfd07ea69d59937b30dfe80a027989070bb527921c990`. Google Gemini 3.1 Pro (`gemini-3.1-pro-low`) through authenticated AGY returned **PASS**, no findings, one turn in 6.5 seconds, zero tool calls. The checked all-tool denial hook remained active. No credentials or private artifacts were sent; existing credits only. No findings were fixed or rejected.

Validation: complete client/Worker build passed the new both-output gate (client 22.40 seconds, Worker 39 ms); compiled Worker/ambient-marker smoke, scoped lint and whitespace passed. Required full-suite pre-push validation is recorded in the worklog after completion. This follow-up has not yet been republished at this note's checkpoint.

## User-directed public access checkpoint

The user explicitly clarified public app access with opt-in ChatGPT identity for private storage. Native access mode was changed from custom to public (revision 2). Anonymous HTTP checks returned root 200, session 401/authenticated false, and forged caller identity 401/authenticated false. Browser login reached the app, but navigation to the raw JSON session endpoint was blocked by the browser client; a product session indicator will verify identity without relying on that navigation. No public save route, real data, paid provider or domain cutover is enabled.
