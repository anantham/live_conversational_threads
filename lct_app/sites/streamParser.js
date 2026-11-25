// Upstream SSE reader and incremental node scanner for real-time map generation progress.
// Reassembles the exact non-streaming completion envelope so all existing validators run unchanged.

const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;

// Matches either key order inside compact or formatted JSON node objects as they stream in.
const NODE_TYPE_THEN_NAME = /"semantic_type"\s*:\s*"(chunk|idea|topic|theme|arc)"[^{}]{0,220}?"node_name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const NODE_NAME_THEN_TYPE = /"node_name"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]{0,220}?"semantic_type"\s*:\s*"(chunk|idea|topic|theme|arc)"/g;

function unescapeJsonString(raw) {
  try { return JSON.parse(`"${raw}"`); } catch { return raw; }
}

/**
 * Incrementally scan accumulated JSON text for newly completed node_name + semantic_type pairs.
 */
export function createNodeScanner(onNode) {
  const seen = new Set();
  let lastScanned = 0;

  return function scan(text) {
    if (!onNode || text.length <= lastScanned) return;
    // Overlap slightly so a match straddling two chunks is never missed.
    const start = Math.max(0, lastScanned - 260);
    const slice = text.slice(start);
    lastScanned = text.length;

    const emit = (type, rawName) => {
      const name = unescapeJsonString(rawName).trim().slice(0, 140);
      if (!name) return;
      const key = `${type}|${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      onNode({ semantic_type: type, node_name: name });
    };

    NODE_TYPE_THEN_NAME.lastIndex = 0;
    let m;
    while ((m = NODE_TYPE_THEN_NAME.exec(slice)) !== null) emit(m[1], m[2]);
    NODE_NAME_THEN_TYPE.lastIndex = 0;
    while ((m = NODE_NAME_THEN_TYPE.exec(slice)) !== null) emit(m[2], m[1]);
  };
}

/**
 * Parse a provider SSE response (Anthropic Messages stream or OpenAI/OpenRouter/Gemini stream)
 * into the standard completion JSON object while emitting fine-grained live callbacks.
 */
export async function readProviderStream(response, { anthropic, signal, onFirstToken, onDelta, onNodeDiscovered } = {}) {
  if (!response.body) throw new Error('Provider returned an empty stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const scanNodes = createNodeScanner(onNodeDiscovered);

  let buffer = '';
  let text = '';
  let byteCount = 0;
  let stopReason = null;
  let finishReason = null;
  let inputTokens = null;
  let outputTokens = null;
  let totalTokens = null;
  let costUsd = null;
  let firstTokenSeen = false;
  let lastProgressAt = 0;

  const stop = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', stop, { once: true });

  const handleDataLine = (rawData) => {
    const trimmed = rawData.trim();
    if (!trimmed || trimmed === '[DONE]') return;
    let event;
    try { event = JSON.parse(trimmed); } catch { return; }

    if (anthropic) {
      if (event.type === 'message_start' && event.message?.usage) {
        if (typeof event.message.usage.input_tokens === 'number') inputTokens = event.message.usage.input_tokens;
      } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        if (!firstTokenSeen) { firstTokenSeen = true; onFirstToken?.(); }
        text += event.delta.text;
        scanNodes(text);
        const now = Date.now();
        if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
          lastProgressAt = now;
          onDelta?.({ chars: text.length, approxTokens: Math.max(1, Math.round(text.length / 4)) });
        }
      } else if (event.type === 'message_delta') {
        if (typeof event.delta?.stop_reason === 'string') stopReason = event.delta.stop_reason;
        if (typeof event.usage?.output_tokens === 'number') outputTokens = event.usage.output_tokens;
      }
      return;
    }

    // OpenAI / OpenRouter / Gemini SSE format
    const choice = Array.isArray(event.choices) ? event.choices[0] : null;
    const chunk = choice?.delta?.content;
    if (typeof chunk === 'string' && chunk) {
      if (!firstTokenSeen) { firstTokenSeen = true; onFirstToken?.(); }
      text += chunk;
      scanNodes(text);
      const now = Date.now();
      if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        lastProgressAt = now;
        onDelta?.({ chars: text.length, approxTokens: Math.max(1, Math.round(text.length / 4)) });
      }
    }
    if (typeof choice?.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
    if (event.usage && typeof event.usage === 'object') {
      if (typeof event.usage.prompt_tokens === 'number') inputTokens = event.usage.prompt_tokens;
      if (typeof event.usage.completion_tokens === 'number') outputTokens = event.usage.completion_tokens;
      if (typeof event.usage.total_tokens === 'number') totalTokens = event.usage.total_tokens;
      if (typeof event.usage.cost === 'number') costUsd = event.usage.cost;
    }
  };

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > MAX_STREAM_BYTES) throw new Error('Provider stream exceeded the bounded output size.');
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.startsWith('data:')) handleDataLine(line.slice(5));
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith('data:')) handleDataLine(buffer.slice(5));
  } finally {
    signal?.removeEventListener('abort', stop);
    stop();
  }

  scanNodes(text);
  if (text.length) onDelta?.({ chars: text.length, approxTokens: Math.max(1, Math.round(text.length / 4)) });

  if (anthropic) {
    return {
      type: 'message',
      role: 'assistant',
      stop_reason: stopReason,
      content: [{ type: 'text', text }],
      usage: {
        ...(inputTokens != null ? { input_tokens: inputTokens } : {}),
        ...(outputTokens != null ? { output_tokens: outputTokens } : {}),
      },
    };
  }
  return {
    choices: [{
      message: { role: 'assistant', content: text },
      finish_reason: finishReason,
    }],
    ...(inputTokens != null || outputTokens != null || totalTokens != null || costUsd != null ? {
      usage: {
        ...(inputTokens != null ? { prompt_tokens: inputTokens } : {}),
        ...(outputTokens != null ? { completion_tokens: outputTokens } : {}),
        ...(totalTokens != null ? { total_tokens: totalTokens } : {}),
        ...(costUsd != null ? { cost: costUsd } : {}),
      },
    } : {}),
  };
}
