// Tiny localStorage shim for the Home page "New" button behavior.
//
// When `autostart_on_new` is true (default), Home's New button navigates to
// `/new?autostart=true` so mic capture kicks off immediately. When false,
// Home navigates to `/new` and the user lands on the live-session page with
// the FileUpload affordance still visible (i.e. they can choose between mic
// and upload before committing to a recording).
//
// This is a per-device preference — not synced — because the choice depends
// on what the operator's primary input pattern is on this browser/device.

const KEY = "lct.autostart_on_new";

export function getAutostartOnNew() {
  try {
    const raw = window.localStorage.getItem(KEY);
    // Default to true: existing users had autostart=true hard-coded in Home,
    // so flipping the default to false would change their muscle memory
    // without warning.
    if (raw === null) return true;
    return raw === "true";
  } catch {
    return true;
  }
}

export function setAutostartOnNew(value) {
  try {
    window.localStorage.setItem(KEY, value ? "true" : "false");
  } catch {
    // localStorage might be unavailable (private browsing, etc.) —
    // silently fall back; the in-memory state in the card still works
    // for this session.
  }
}
