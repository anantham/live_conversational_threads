import { describe, expect, it } from 'vitest';
import { buildAnthropicGenerationRequest } from '../../../sites/anthropic.js';
import { withOpenRouterPromptCache } from '../../../sites/openRouter.js';

const sampleSource = {
  recordingId: 'rec-cache-1',
  startedAt: 1_700_000_000_000,
  complete: true,
  finalTokens: [
    { text: 'First speaker opens a topic about caching.', speaker: '1', startMs: 0, endMs: 2500 },
    { text: '\nSecond speaker replies with timing notes.', speaker: '2', startMs: 2600, endMs: 5000 },
  ],
};

describe('LLM prompt caching', () => {
  it('marks Anthropic system and user blocks with ephemeral cache_control', () => {
    const req = buildAnthropicGenerationRequest({
      source: sampleSource,
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 4096,
    });
    expect(Array.isArray(req.system)).toBe(true);
    expect(req.system[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } });
    expect(req.system[0].text.length).toBeGreaterThan(20);
    expect(Array.isArray(req.messages[0].content)).toBe(true);
    expect(req.messages[0].content[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } });
    expect(req.messages[0].content[0].text).toContain('First speaker opens a topic about caching.');
  });

  it('adds OpenRouter cache_control blocks only for anthropic/* models', () => {
    const messages = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Transcript body' },
    ];
    const claude = withOpenRouterPromptCache(messages, 'anthropic/claude-sonnet-4.5');
    expect(claude[0].content).toEqual([{ type: 'text', text: 'System prompt', cache_control: { type: 'ephemeral' } }]);
    expect(claude[1].content).toEqual([{ type: 'text', text: 'Transcript body', cache_control: { type: 'ephemeral' } }]);

    const gemini = withOpenRouterPromptCache(messages, 'google/gemini-2.5-pro');
    expect(gemini).toBe(messages);
  });
});
