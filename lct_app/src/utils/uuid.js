/**
 * UUIDv4 generator that works in insecure contexts (plain http://, LAN IPs).
 *
 * `crypto.randomUUID()` is only exposed to secure contexts (https://,
 * localhost, 127.0.0.1, file://). Accessing it over a Tailscale IP like
 * http://100.81.65.74:43173 throws `TypeError: crypto.randomUUID is not
 * a function`, which crashed the /new page when used in useState
 * initializers.
 *
 * `crypto.getRandomValues()` IS available on every context (incl. plain
 * HTTP on LAN), so we use that to fill a 16-byte buffer and format it
 * per RFC 4122 §4.4 (version 4, variant 10xx).
 */
export function randomUUID() {
  // Prefer native when present — same output, slightly faster, observable
  // in DevTools as `randomUUID` rather than the polyfill path.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    // No Web Crypto at all — bail with a clear message so we don't ship
    // predictable IDs.
    throw new Error(
      "Web Crypto API not available — cannot generate a UUID. This should " +
      "be impossible in any modern browser; verify the JS runtime."
    );
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Version 4 (random): high nibble of byte 6 is 0100.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // Variant RFC 4122: high two bits of byte 8 are 10.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") + "-" +
    hex.slice(4, 6).join("") + "-" +
    hex.slice(6, 8).join("") + "-" +
    hex.slice(8, 10).join("") + "-" +
    hex.slice(10, 16).join("")
  );
}
