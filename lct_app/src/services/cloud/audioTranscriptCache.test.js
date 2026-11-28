// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  audioCacheKey,
  hashAudioFile,
} from './audioTranscriptCache.js';
import { readCachedAudioTranscript } from './localConversationStore.js';

describe('audioTranscriptCache', () => {
  it('hashes identical audio bytes deterministically and distinguishes different bytes', async () => {
    const a = new File([new Uint8Array([1, 2, 3, 4])], 'a.wav', { type: 'audio/wav' });
    const b = new File([new Uint8Array([1, 2, 3, 4])], 'b.wav', { type: 'audio/wav' });
    const c = new File([new Uint8Array([1, 2, 3, 5])], 'c.wav', { type: 'audio/wav' });

    const ha = await hashAudioFile(a);
    const hb = await hashAudioFile(b);
    const hc = await hashAudioFile(c);

    expect(ha).toMatch(/^[0-9a-f]{64}$/);
    expect(ha).toBe(hb);
    expect(ha).not.toBe(hc);
    expect(audioCacheKey({ sha256: ha, provider: 'm5_tailnet', diarize: true })).toBe(`${ha}:m5_tailnet:d1`);
    expect(audioCacheKey({ sha256: ha, provider: 'soniox', diarize: false })).toBe(`${ha}:soniox:d0`);
  });

  it('degrades gracefully when IndexedDB is unavailable', async () => {
    expect(await readCachedAudioTranscript('abc:m5_tailnet:d1')).toBeNull();
  });
});
