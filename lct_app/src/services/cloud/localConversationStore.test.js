// Intent: local-conversation-retention.md. Public store API, synthetic IndexedDB event boundary.
import { afterEach, expect, it, vi } from 'vitest';
import { saveLocalConversation } from './localConversationStore.js';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('waits for a committed transaction acknowledgement when a deadline cannot abort it', async () => {
  vi.useFakeTimers(); let tx, saved;
  const records = { get() { const request = { result: undefined }; Promise.resolve().then(() => request.onsuccess()); return request; }, put(record) { saved = record; } };
  const db = { close: vi.fn(), transaction() { tx = { objectStore: () => records, abort() { throw new DOMException('Already committed', 'InvalidStateError'); } }; return tx; } };
  vi.stubGlobal('indexedDB', { open() { const request = { result: db }; Promise.resolve().then(() => request.onsuccess()); return request; } });
  let outcome = 'pending';
  const pending = saveLocalConversation({ id: 'synthetic', recording: { id: 'synthetic' } }).then(value => { outcome = 'saved'; return value; }, error => { outcome = 'failed'; throw error; });
  await vi.advanceTimersByTimeAsync(5001); expect(outcome).toBe('pending'); expect(saved.revision).toBeTypeOf('string');
  tx.oncomplete(); expect(await pending).toBe(saved.revision); expect(outcome).toBe('saved');
});
