// The browser's whole generate call outlives the Worker's provider window, so a
// slow model ends in the Worker's counted 408 rather than an unexplained abort.
export const MAP_PROVIDER_WINDOW_MS = 90_000;
export const MAP_CLIENT_DEADLINE_MS = 95_000;
