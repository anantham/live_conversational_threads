// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_M5_TAILNET_URL,
  isAllowedTailnetUrl,
  M5TailnetFileSession,
  parseM5Segments,
} from './m5TailnetFileSession.js';

describe('m5TailnetFileSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows only HTTPS credential-free *.ts.net URLs', () => {
    expect(isAllowedTailnetUrl(DEFAULT_M5_TAILNET_URL)).toBe(true);
    expect(isAllowedTailnetUrl('http://adityas-macbook-pro.tail4741ad.ts.net:5443/v1/audio/transcriptions')).toBe(false);
    expect(isAllowedTailnetUrl('https://evil.example.com/v1/audio/transcriptions')).toBe(false);
    expect(isAllowedTailnetUrl('https://user:pass@adityas-macbook-pro.tail4741ad.ts.net/v1')).toBe(false);
    expect(isAllowedTailnetUrl('https://attacker-box.tailEVIL.ts.net/v1/audio/transcriptions')).toBe(false);
  });

  it('parses diarized M5 segments into timed finalTokens', () => {
    const tokens = parseM5Segments({
      segments: [
        { start: 0.5, end: 3.2, speaker: 'SPEAKER_00', text: 'First turn.' },
        { start: 3.5, end: 6.0, speaker: 'SPEAKER_01', text: 'Second turn.' },
      ],
    });
    expect(tokens).toEqual([
      { text: 'First turn.', speaker: 'SPEAKER_00', startMs: 500, endMs: 3200 },
      { text: '\nSecond turn.', speaker: 'SPEAKER_01', startMs: 3500, endMs: 6000 },
    ]);
  });

  it('marks unreachable M5 tailnet errors with canTryNext=true so Sites falls back to Soniox', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')));
    const stages = [];
    const session = new M5TailnetFileSession({
      onStage: s => stages.push(s.stage),
      onAudio: vi.fn(),
      onTranscript: vi.fn(),
    });
    const file = new File([new Uint8Array([1, 2, 3])], 'sample.wav', { type: 'audio/wav' });
    let caught;
    try {
      await session.start({ file });
    } catch (err) {
      caught = err;
    }
    expect(caught?.canTryNext).toBe(true);
    expect(caught?.message).toContain('Tailscale');
    expect(stages).toContain('error');
  });
});
