import { OpenRouterError } from './openRouterPolicy.js';

/** Deadline and delivered abort handling; neither proves provider-side billing stopped. */
export async function openRouterWait(signal, milliseconds, operation) {
  const controller = new AbortController();
  let reason = 'cancelled';
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const deadline = setTimeout(() => { reason = 'timeout'; abort(); }, milliseconds);
  let rejectOnAbort;
  const interrupted = new Promise((_, reject) => {
    rejectOnAbort = () => reject(new OpenRouterError(408, reason,
      'Generation stopped or timed out. Any reserved attempt remains counted; no automatic retry was made.'));
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
    if (controller.signal.aborted) rejectOnAbort();
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new OpenRouterError(408, reason, 'Generation was cancelled before processing.');
      return operation(controller.signal);
    }), interrupted]);
  } finally {
    clearTimeout(deadline);
    controller.signal.removeEventListener('abort', rejectOnAbort);
    controller.abort();
    signal.removeEventListener('abort', abort);
  }
}

export async function readOpenRouterJSON(message, signal, maximum, upstream = false) {
  const status = upstream ? 502 : 400;
  const error = () => new OpenRouterError(status, upstream ? 'provider_response' : 'source_body',
    upstream ? 'OpenRouter returned an unusable completion. The attempt remains counted.' : 'Supply a bounded valid JSON recording source. No attempt was requested.');
  const declared = message.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    void message.body?.cancel().catch(() => {});
    throw new OpenRouterError(upstream ? 502 : 413, 'body_limit', 'The generation body exceeds its size limit. No usable map was returned.');
  }
  const reader = message.body?.getReader();
  if (!reader) throw error();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      if (signal.aborted) throw new OpenRouterError(408, 'cancelled', 'Generation was interrupted. Any reserved attempt remains counted.');
      const part = await reader.read();
      if (signal.aborted) throw new OpenRouterError(408, 'cancelled', 'Generation was interrupted. Any reserved attempt remains counted.');
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) throw new OpenRouterError(upstream ? 502 : 413, 'body_limit', 'The generation body exceeds its size limit. No usable map was returned.');
      chunks.push(part.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
    catch { throw error(); }
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
