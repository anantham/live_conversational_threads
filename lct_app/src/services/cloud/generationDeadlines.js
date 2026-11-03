// The browser's whole generate call (upload, admission, provider wait, response)
// must outlive the Worker's input and provider windows together, so a slow model
// ends in the Worker's counted 408 rather than an unexplained client abort.
export const MAP_INPUT_WINDOW_MS = 30_000;
export const MAP_PROVIDER_WINDOW_MS = 90_000;
export const MAP_CLIENT_DEADLINE_MS = 125_000;
