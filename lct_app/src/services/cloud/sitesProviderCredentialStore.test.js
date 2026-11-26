// Test intent:
// - A saved personal key round-trips through real AES-GCM (Web Crypto) and the browser database, and the
//   stored record never holds the key as text.
// - A record whose ciphertext is moved to another provider's slot does not decrypt (the provider id is
//   bound as additional data); it is reported as unreadable and the other keys still load.
// - A model list written for an older key revision is ignored, so a replaced key never inherits it.
// - Deleting a key removes it.
// The database is a small in-memory stand-in for IndexedDB; the crypto is the real Web Crypto API.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteSavedProviderKey, readSavedProviderCredentials, writeSavedProviderKey, writeSavedProviderModels } from './sitesProviderCredentialStore.js';

function memoryIndexedDB() {
  const rows = new Map();
  const later = fn => queueMicrotask(fn);
  const store = () => ({
    getAll() { const request = {}; later(() => { request.result = [...rows.values()]; request.onsuccess?.(); }); return request; },
    get(id) { const request = {}; later(() => { request.result = rows.get(id); request.onsuccess?.(); }); return request; },
    put(record) { rows.set(record.id, record); },
    delete(id) { rows.delete(id); },
  });
  const db = {
    createObjectStore() {},
    close() {},
    transaction() {
      const tx = { objectStore: store };
      // Completes after queued request callbacks have run, as a real transaction does.
      later(() => later(() => later(() => tx.oncomplete?.())));
      return tx;
    },
  };
  return {
    rows,
    open() {
      const request = { result: db };
      later(() => { request.onupgradeneeded?.(); request.onsuccess?.(); });
      return request;
    },
  };
}

const KEY_A = 'sk-or-v1-' + 'a'.repeat(64);
const KEY_B = 'sk-ant-api03-' + 'b'.repeat(90);
let fakeDb, original;

beforeEach(() => { original = globalThis.indexedDB; fakeDb = memoryIndexedDB(); globalThis.indexedDB = fakeDb; });
afterEach(() => { globalThis.indexedDB = original; });

describe('saved provider keys', () => {
  it('round-trips a key through real encryption without storing it as text', async () => {
    await writeSavedProviderKey('openrouter', KEY_A);
    const stored = fakeDb.rows.get('openrouter');
    expect(new TextDecoder().decode(stored.ciphertext)).not.toContain(KEY_A);
    expect(stored.wrappingKey.extractable).toBe(false);
    const { entries, unreadable } = await readSavedProviderCredentials();
    expect(unreadable).toBe(false);
    expect(entries.openrouter).toMatchObject({ key: KEY_A, models: [], modelsFetchedAt: 0 });
  });

  it('refuses a ciphertext moved to another provider slot and still loads the rest', async () => {
    await writeSavedProviderKey('openrouter', KEY_A);
    await writeSavedProviderKey('anthropic', KEY_B);
    fakeDb.rows.set('gemini', { ...fakeDb.rows.get('openrouter'), id: 'gemini' });
    const { entries, unreadable } = await readSavedProviderCredentials();
    expect(unreadable).toBe(true);
    expect(Object.keys(entries).sort()).toEqual(['anthropic', 'openrouter']);
  });

  it('ignores a model list written for a replaced key, and deletes keys', async () => {
    await writeSavedProviderKey('openrouter', KEY_A);
    const { revision: old } = (await readSavedProviderCredentials()).entries.openrouter;
    await writeSavedProviderKey('openrouter', KEY_A);
    expect(await writeSavedProviderModels('openrouter', old, [{ id: 'vendor/model-x', label: 'X' }])).toBe(false);
    const { revision } = (await readSavedProviderCredentials()).entries.openrouter;
    expect(await writeSavedProviderModels('openrouter', revision, [{ id: 'vendor/model-x', label: 'X' }])).toBe(true);
    expect((await readSavedProviderCredentials()).entries.openrouter.models).toEqual([{ id: 'vendor/model-x', label: 'X' }]);
    await deleteSavedProviderKey('openrouter');
    expect((await readSavedProviderCredentials()).entries).toEqual({});
  });
});
