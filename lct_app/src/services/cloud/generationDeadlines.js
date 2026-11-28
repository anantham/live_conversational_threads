// The browser's whole generate call (upload, admission, provider wait, response)
// must outlive the Worker's input and provider windows together, so a slow model
// ends in the Worker's counted 408 rather than an unexplained client abort.
export const MAP_INPUT_WINDOW_MS = 30_000;
export const MAP_PROVIDER_WINDOW_MS = 90_000;
export const MAP_CLIENT_DEADLINE_MS = 125_000;

// An unfinished attempt older than this cannot still be running in a Worker (both windows have
// closed, plus a margin), so the Worker stops counting it as holding a concurrent slot. The browser
// keeps retrying an admission refusal at least this long, so a slot held by a stuck or refused
// attempt is released before the run gives up. The Worker (sites/openRouterPolicy.js) uses this same value.
export const STALE_ATTEMPT_MS = MAP_INPUT_WINDOW_MS + MAP_PROVIDER_WINDOW_MS + 180_000;
