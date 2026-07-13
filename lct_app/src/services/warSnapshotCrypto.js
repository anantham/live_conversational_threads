/**
 * Encrypted war-report snapshots — the share format for /war/s.
 *
 * Format: 12-byte random IV || AES-256-GCM ciphertext, as one binary blob.
 * The key travels ONLY in the share link's #fragment (base64url), which
 * browsers never send to any server — so the host stores bytes it cannot
 * read, and the full link is the capability, same trust shape as a group
 * invite link.
 *
 * Isomorphic on WebCrypto: works in the browser and in Node >= 19
 * (globalThis.crypto), so the export script and the page share one
 * implementation instead of two dialects that can drift.
 */

const subtle = () => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto unavailable in this environment");
  return c;
};

export function toBase64Url(bytes) {
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text) {
  const b64 = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export function generateKeyBytes() {
  return subtle().getRandomValues(new Uint8Array(32));
}

async function importKey(keyBytes, usage) {
  return subtle().subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [usage]);
}

/** JSON object -> Uint8Array(iv || ciphertext). */
export async function encryptSnapshot(payload, keyBytes) {
  const iv = subtle().getRandomValues(new Uint8Array(12));
  const key = await importKey(keyBytes, "encrypt");
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await subtle().subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext)
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return out;
}

/** Uint8Array(iv || ciphertext) -> JSON object. Throws on a wrong key
 * (GCM authentication fails) or corrupted bytes. */
export async function decryptSnapshot(bytes, keyBytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length < 13) throw new Error("snapshot too short");
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const key = await importKey(keyBytes, "decrypt");
  const plaintext = await subtle().subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}
