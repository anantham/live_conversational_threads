import { afterEach, describe, expect, it, vi } from 'vitest';

import { callServerlessLlm } from './llmClient';
import { NeedsKeyError, startTrial } from './serverlessAuth';

// Pins the streaming chat contract (2026-07-06): callServerlessLlm requests
// stream:true and reassembles OpenAI's SSE deltas. This is the fix for the
// intermittent 504 the live e2e caught — a non-streaming call made the Edge
// proxy buffer a whole slow completion until its response window expired.

function sseStream(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

function sseResponse(chunks, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: sseStream(chunks),
  };
}

describe('callServerlessLlm streaming', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('requests stream:true and reassembles SSE delta content', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"{\\"nodes\\":"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"[]}"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
    );

    const result = await callServerlessLlm('sk-user', [{ role: 'user', content: 'hi' }], { jsonMode: true });

    // The request opted into streaming.
    const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sentBody.stream).toBe(true);
    // The reassembled '{"nodes":[]}' parsed via jsonMode.
    expect(result).toEqual({ nodes: [] });
  });

  it('handles deltas split across network chunks and ignores keep-alives', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel',   // frame split mid-way...
        'lo "}}]}\n\n',                                   // ...completed in the next chunk
        ': keep-alive comment\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
    );
    const result = await callServerlessLlm('sk-user', [{ role: 'user', content: 'hi' }]);
    expect(result).toBe('Hello world');
  });

  it('maps a 402 (trial exhausted) to NeedsKeyError before reading the stream', async () => {
    startTrial();
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 402, text: async () => '', headers: { get: () => null } });
    await expect(callServerlessLlm('', [{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(NeedsKeyError);
  });

  it('throws NeedsKeyError with no key and no active trial', async () => {
    await expect(callServerlessLlm('', [{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(NeedsKeyError);
  });

  it('falls back to a buffered JSON body when the proxy does not stream', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({ choices: [{ message: { content: 'buffered reply' } }] }),
    });
    const result = await callServerlessLlm('sk-user', [{ role: 'user', content: 'hi' }]);
    expect(result).toBe('buffered reply');
  });

  // --- dual-review hardening cases (grok+codex) ---

  it('throws on an in-stream error frame instead of returning empty content', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
        'data: {"error":{"message":"context length exceeded","type":"invalid_request_error"}}\n\n',
      ])
    );
    await expect(callServerlessLlm('sk-user', [{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/context length exceeded/);
  });

  it('tolerates CRLF (\\r\\n\\r\\n) frame separators', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\n',
        'data: {"choices":[{"delta":{"content":"b"}}]}\r\n\r\n',
        'data: [DONE]\r\n\r\n',
      ])
    );
    const result = await callServerlessLlm('sk-user', [{ role: 'user', content: 'hi' }]);
    expect(result).toBe('ab');
  });

  it('flushes a final frame that arrives without a trailing blank line', async () => {
    // Truncated / non-conformant upstream: last data line, no closing \n\n.
    global.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"one "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"two"}}]}',
      ])
    );
    const result = await callServerlessLlm('sk-user', [{ role: 'user', content: 'hi' }]);
    expect(result).toBe('one two');
  });

  it('reassembles a multibyte UTF-8 char split across network chunks', async () => {
    // '★' (U+2605) encodes to 3 bytes E2 98 85. Split the frame right inside
    // those bytes so TextDecoder({stream:true}) must buffer the partial
    // sequence across two reads.
    const full = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"★"}}]}\n\n');
    const star = full.indexOf(0xe2); // first byte of ★
    const parts = [full.slice(0, star + 1), full.slice(star + 1)]; // split after E2
    let i = 0;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
      body: new ReadableStream({
        pull(controller) {
          if (i < parts.length) controller.enqueue(parts[i++]);
          else controller.close();
        },
      }),
    });
    const result = await callServerlessLlm('sk-user', [{ role: 'user', content: 'hi' }]);
    expect(result).toBe('★');
  });
});
