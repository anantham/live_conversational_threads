import { describe, expect, it, vi } from 'vitest';
import { createNodeScanner, readProviderStream } from '../../../sites/streamParser.js';

function sseResponse(lines) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('streamParser', () => {
  it('reassembles Anthropic SSE stream and emits discovered nodes incrementally', async () => {
    const discovered = [];
    const onFirstToken = vi.fn();
    const json1 = '{"nodes":[{"id":"a1","semantic_type":"arc","node_name":"Community Spaces"},';
    const json2 = '{"id":"t1","node_name":"Japan Akiya","semantic_type":"topic"}]}';
    const response = sseResponse([
      'event: message_start',
      `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1500 } } })}`,
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: json1 } })}`,
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: json2 } })}`,
      'event: message_delta',
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 420 } })}`,
    ]);

    const completion = await readProviderStream(response, {
      anthropic: true,
      onFirstToken,
      onNodeDiscovered: node => discovered.push(node),
    });

    expect(onFirstToken).toHaveBeenCalledTimes(1);
    expect(completion.type).toBe('message');
    expect(completion.stop_reason).toBe('end_turn');
    expect(completion.content[0].text).toBe(json1 + json2);
    expect(completion.usage).toEqual({ input_tokens: 1500, output_tokens: 420 });
    expect(discovered).toEqual([
      { semantic_type: 'arc', node_name: 'Community Spaces' },
      { semantic_type: 'topic', node_name: 'Japan Akiya' },
    ]);
  });

  it('reassembles OpenRouter/OpenAI SSE stream with usage and deduplicates scanned nodes', async () => {
    const discovered = [];
    const response = sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"nodes":[{"semantic_type":"chunk","node_name":"Intro"}]}' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 120, cost: 0.01 } })}`,
      'data: [DONE]',
    ]);
    const completion = await readProviderStream(response, {
      anthropic: false,
      onNodeDiscovered: node => discovered.push(node),
    });
    expect(completion.choices[0].finish_reason).toBe('stop');
    expect(completion.usage).toEqual({ prompt_tokens: 900, completion_tokens: 120, cost: 0.01 });
    expect(discovered).toEqual([{ semantic_type: 'chunk', node_name: 'Intro' }]);
  });

  it('scans nodes split across chunk boundaries without duplicates', () => {
    const found = [];
    const scan = createNodeScanner(node => found.push(node));
    const full = '{"semantic_type":"theme","node_name":"Embodied Presence"}';
    scan(full.slice(0, 28));
    scan(full);
    scan(full);
    expect(found).toEqual([{ semantic_type: 'theme', node_name: 'Embodied Presence' }]);
  });
});
