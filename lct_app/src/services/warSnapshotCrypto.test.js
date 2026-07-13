import { describe, expect, it } from "vitest";

import {
  decryptSnapshot,
  encryptSnapshot,
  fromBase64Url,
  generateKeyBytes,
  toBase64Url,
} from "./warSnapshotCrypto";

describe("warSnapshotCrypto", () => {
  it("round-trips a payload", async () => {
    const key = generateKeyBytes();
    const payload = { v: 1, title: "Test", nodes: [{ id: "a", node_name: "Claim — with unicode ‎marks" }] };
    const cipher = await encryptSnapshot(payload, key);
    expect(cipher.length).toBeGreaterThan(12);
    const back = await decryptSnapshot(cipher, key);
    expect(back).toEqual(payload);
  });

  it("rejects the wrong key (GCM auth failure)", async () => {
    const cipher = await encryptSnapshot({ secret: true }, generateKeyBytes());
    await expect(decryptSnapshot(cipher, generateKeyBytes())).rejects.toThrow();
  });

  it("rejects tampered ciphertext", async () => {
    const key = generateKeyBytes();
    const cipher = await encryptSnapshot({ secret: true }, key);
    cipher[cipher.length - 1] ^= 0xff;
    await expect(decryptSnapshot(cipher, key)).rejects.toThrow();
  });

  it("base64url survives the fragment round-trip", () => {
    const key = generateKeyBytes();
    const encoded = toBase64Url(key);
    expect(encoded).not.toMatch(/[+/=]/); // fragment-safe alphabet
    expect(fromBase64Url(encoded)).toEqual(key);
  });
});
