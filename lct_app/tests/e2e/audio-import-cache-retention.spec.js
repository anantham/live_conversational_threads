import { test, expect } from '@playwright/test';

// Test intent: tests/intent/audio-import-cache-retention.md. Use real IndexedDB and a disposable browser context.
test('removing an import clears its cached words and legacy copies', async ({ page }) => {
  await page.goto('/view');
  const result = await page.evaluate(async () => {
    const { saveLocalConversation, readCachedAudioTranscript, deleteLocalConversation, readLocalConversation }
      = await import('/src/services/cloud/localConversationStore.js');
    const id = 'synthetic-import';
    const transcript = { finalTokens: [{ text: 'fixture' }], finalText: 'fixture', partialTokens: [], partialText: '' };
    const snapshot = { id, recording: { id, startedAt: 1 }, transcript, audioCacheKey: 'test:m5:d1', audioCacheTime: 1 };
    const revision = await saveLocalConversation(snapshot);
    const hit = await readCachedAudioTranscript(snapshot.audioCacheKey);
    const legacy = await new Promise((resolve, reject) => {
      const req = indexedDB.open('lct_audio_transcript_cache_v1', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('transcripts').put(transcript, 'test:m5:d1');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    let blockedMessage;
    try { await deleteLocalConversation(id); } catch (error) { blockedMessage = error.message; }
    const retainedOnError = Boolean(await readLocalConversation(id));
    legacy.close();
    await deleteLocalConversation(id);
    let stale;
    try { await saveLocalConversation(snapshot, [], revision); } catch (error) { stale = error.code; }
    return { hit: hit.finalText, blockedMessage, retainedOnError, stale, archive: await readLocalConversation(id),
      cached: await readCachedAudioTranscript(snapshot.audioCacheKey),
      legacyPresent: (await indexedDB.databases()).some(db => db.name === 'lct_audio_transcript_cache_v1') };
  });
  expect(result).toEqual({ hit: 'fixture', blockedMessage: expect.stringContaining('Close other LCT tabs'),
    retainedOnError: true, stale: 'archive_conflict', archive: null, cached: null, legacyPresent: false });
});
