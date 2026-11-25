import { describe, expect, it } from 'vitest';
import { FACT_CHECK_FORMAT, factCheckFromGeneratedText, sanitizeClaimText } from './factCheckTask.js';
import { buildRecordingGenerationMessages } from './openRouterGeneration.js';

const dummySource = {
  recordingId: 'claim-check-only',
  startedAt: 1790000000000,
  complete: true,
  finalTokens: [{ text: 'PRIVATE TRANSCRIPT WORDS MUST NOT LEAVE', speaker: 'Private Speaker', startMs: 0, endMs: 1000 }],
};

describe('factCheckTask', () => {
  it('parses valid fact-check results and strips unsafe non-http URLs', () => {
    const parsed = factCheckFromGeneratedText(JSON.stringify({
      format: FACT_CHECK_FORMAT,
      status: 'contested',
      note: 'Historical records show a different figure.',
      sources: [
        { title: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Example' },
        { title: 'XSS attempt', url: 'javascript:alert(1)' },
      ],
    }));
    expect(parsed.status).toBe('contested');
    expect(parsed.sources).toEqual([{ title: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Example' }]);
  });

  it('sends ONLY the single confirmed claim in the user message — zero transcript words or speakers', () => {
    const [, user] = buildRecordingGenerationMessages(dummySource, 1024, '', {
      task: 'fact_check',
      claim: 'Ooty is at roughly 2,240 meters elevation.',
    });
    expect(user.content).toContain('Ooty is at roughly 2,240 meters elevation.');
    expect(user.content).not.toContain('PRIVATE TRANSCRIPT WORDS');
    expect(user.content).not.toContain('Private Speaker');
    expect(() => sanitizeClaimText('   ')).toThrow();
  });
});
