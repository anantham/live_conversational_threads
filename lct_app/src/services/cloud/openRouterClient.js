import { createRecordingTranscript } from './recordingTranscript.js';
import { createRecordingThreads } from './recordingThreads.js';
import { validateThreadsArtifact } from '../threadsArtifact.js';
import { recordSitesCostEntry } from './sitesCostStore.js';

export const MAP_PROVIDERS = {
  openrouter: { option: 'OpenRouter', name: 'OpenRouter', recipient: 'OpenRouter and the selected model provider' },
  gemini: { option: 'Gemini · Google AI Studio', name: 'Gemini', recipient: 'Google Gemini through Google AI Studio' },
  anthropic: { option: 'Claude · Anthropic', name: 'Anthropic', recipient: 'Anthropic (Claude)' },
};
const uncertain = 'No new map is available. The attempt may remain counted; check setup and allowance before retrying.';
const generationFailures = {
  provider_refused: 'The AI provider refused this generation request. Your audio and transcript are preserved; the attempt remains counted.',
  invalid_completion: 'The AI provider returned an incomplete or invalid map. Your audio and transcript are preserved; the attempt remains counted.',
  no_model_route: 'No approved AI model currently has a route through the selected provider. Your audio and transcript are preserved; the attempt remains counted.',
  provider_unreachable: 'The AI provider could not be reached. Your audio and transcript are preserved; the attempt remains counted.',
};
const messages = {
  401: 'Sign in for the current generation test. Public browsing and local downloads remain available.',
  403: 'Confirm permission to send this transcript to the selected inference provider.',
  408: 'The AI provider did not finish within the time limit, so the request was stopped. The attempt remains counted; check the activity log for how long it ran.',
  429: 'The shared generation limit is reached or another attempt is starting. Wait and check setup before retrying; unresolved attempts may need owner review.',
  503: 'Generation is unavailable. Check provider setup and spending limits before retrying.',
};
// Fixed copy chosen by the provider's status code; the Worker never forwards provider text.
function refusalDetail(status) {
  if (!Number.isInteger(status) || status < 400 || status > 599) return '';
  if (status === 402) return ' The provider account is out of credits.';
  if (status === 401 || status === 403) return ' The provider refused the API key.';
  if (status === 429) return ' The provider is rate-limiting requests.';
  return status >= 500 ? ` The provider had an internal error (HTTP ${status}).` : ` The provider rejected the request (HTTP ${status}).`;
}
const anthropicRefusals = {
  anthropic_spend_limit: 'Anthropic reported a workspace spend or credit limit.',
  anthropic_schema: 'Anthropic rejected the structured-output schema.',
  anthropic_token_limit: 'Anthropic rejected a token or context limit in the request.',
  anthropic_invalid_request: 'Anthropic rejected the request parameters.',
};
const diagnosticRequestId = value => typeof value === 'string' && /^req_[A-Za-z0-9]{8,100}$/.test(value) ? value : null;

function providerDiagnosticDetail(payload) {
  const reason = Object.hasOwn(anthropicRefusals, payload.upstream_reason) ? anthropicRefusals[payload.upstream_reason] : '';
  const id = diagnosticRequestId(payload.upstream_request_id);
  return (reason ? ' ' + reason : '') + (id ? ' Anthropic request ID ' + id + '.' : '');
}

function unreadable() { return new Error(`Generation returned an unreadable or oversized response. ${uncertain}`); }

async function readJSON(response, signal, limit) {
  if (signal?.aborted) { void response.body?.cancel().catch(() => {}); throw new DOMException('Aborted', 'AbortError'); }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) { void response.body?.cancel().catch(() => {}); throw unreadable(); }
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    void response.body?.cancel().catch(() => {}); throw unreadable();
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  const stop = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    if (signal?.aborted) stop();
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw unreadable();
      chunks.push(value);
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw unreadable();
    return payload;
  } catch { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); throw unreadable(); }
  finally { signal?.removeEventListener('abort', stop); stop(); }
}

async function request(path, signal, body, backend) {
  if (!Object.hasOwn(MAP_PROVIDERS, backend)) throw new Error('Select a supported AI provider before generation.');
  const response = await fetch(`/api/cloud/${backend}${path}`,  { method: body ? 'POST' : 'GET',
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
    ...(body ? { headers: { 'Content-Type': 'application/json', [`X-LCT-${MAP_PROVIDERS[backend].name}-Consent`]: 'generate-v1' }, body } : {}),
  });
  const payload = await readJSON(response, signal, body ? 2 * 1024 * 1024 + 1024 : 8192);
  if (!response.ok) throw failure(response.status, payload);
  return payload;
}

const STAGE_LABELS = /^[a-z_]{1,40}$/;
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : null;

// Fixed copy from the Worker's allow-listed labels and integers; never model text.
export function invalidCompletionDetail(payload) {
  const outputTokens = tokenCount(payload.output_tokens), cap = tokenCount(payload.max_output_tokens);
  if (payload.stop_reason === 'max_tokens') {
    return ` The response was cut off at the output limit${outputTokens && cap ? ` (${outputTokens} of ${cap} tokens)` : ''}, so the map JSON was incomplete.`;
  }
  if (payload.stop_reason === 'refusal') return ' The model declined to answer.';
  const stage = typeof payload.validation_stage === 'string' && STAGE_LABELS.test(payload.validation_stage) ? payload.validation_stage : null;
  if (!stage) return '';
  const rule = ['hierarchy', 'edges'].includes(stage) && typeof payload.validation_rule === 'string' && STAGE_LABELS.test(payload.validation_rule)
    ? `/${payload.validation_rule}` : '';
  const stop = typeof payload.stop_reason === 'string' && STAGE_LABELS.test(payload.stop_reason) && payload.stop_reason !== 'end_turn'
    ? `, stop reason ${payload.stop_reason}` : '';
  return ` Validation failed at ${stage}${rule}${stop}${outputTokens ? ` after ${outputTokens} output tokens` : ''}.`;
}

const ATTEMPT_FIELDS = { backend: 'string', model: 'string', task: 'string', outcome: 'string', stage: 'string', rule: 'string',
  reason: 'string', stop_reason: 'string', request_id: 'string', error_name: 'string', error_cause: 'string',
  duration_ms: 'number', input_tokens: 'number', output_tokens: 'number', max_output_tokens: 'number', upstream_status: 'number' };

/** The Worker's content-free attempt records, keeping only known fields of the expected type. */
export function publicAttempts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).filter(a => a && typeof a === 'object').map(a => Object.fromEntries(Object.entries(ATTEMPT_FIELDS)
    .filter(([key, type]) => typeof a[key] === type && (type !== 'string' || a[key].length <= 120)).map(([key]) => [key, a[key]])));
}

function failure(status, payload) {
  const code = status === 502 && Object.hasOwn(generationFailures, payload.code) ? payload.code : null;
  const failedAttempt = publicAttempts(payload.attempts).at(-1);
  const detail = code === 'provider_refused' ? refusalDetail(payload.upstream_status)
    : code === 'invalid_completion' ? invalidCompletionDetail(payload)
      : code === 'provider_unreachable' && failedAttempt?.error_name ? ` (${failedAttempt.error_name}${failedAttempt.error_cause ? ' ' + failedAttempt.error_cause : ''}).` : '';
  const error = new Error(code ? generationFailures[code] + detail + providerDiagnosticDetail(payload) : messages[status] || uncertain);
  error.status = status;
  if (code) error.code = code;
  // Lets the windowed pipeline split a window whose map was cut off at the output cap.
  if (code === 'invalid_completion' && payload.stop_reason === 'max_tokens') error.stopReason = 'max_tokens';
  const attempts = publicAttempts(payload.attempts);
  if (attempts.length) error.attempts = attempts;
  if (code === 'invalid_completion' && typeof payload.validation_stage === 'string' && STAGE_LABELS.test(payload.validation_stage)) {
    error.validationStage = payload.validation_stage;
    if (typeof payload.validation_rule === 'string' && STAGE_LABELS.test(payload.validation_rule)) error.validationRule = payload.validation_rule;
  }
  return error;
}

export async function getRecordingMapStatus(signal, backend = 'openrouter') {
  const status = await request('/status', signal, undefined, backend);
  if (status.backend !== backend || ['enabled', 'available', 'configured', 'schema_ready'].some(key => typeof status[key] !== 'boolean')
    || ![null, 'public', 'authenticated'].includes(status.audience)
    || ['model', 'provider'].some(key => status[key] != null && (typeof status[key] !== 'string' || status[key].length > 160))) throw unreadable();
  // Older Site deployments omit the list; that means no fallback, not an unknown one.
  const fallbacks = status.fallback_models ?? [];
  if (!Array.isArray(fallbacks) || fallbacks.length > 3
    || fallbacks.some(model => typeof model !== 'string' || !model || model.length > 160)) throw unreadable();
  return { ...status, fallback_models: fallbacks };
}

/** The consent-time description of every model that may receive the transcript. */
export function describeModelRoute(status) {
  if (!status?.model) return null;
  const fallbacks = status.fallback_models || [];
  const models = fallbacks.length ? `${status.model}, or ${fallbacks.join(', then ')} if it is unavailable` : status.model;
  return `Model: ${models} · Provider: ${status.provider}`;
}

export async function generateRecordingMap(source, signal, backend = 'openrouter') {
  createRecordingTranscript(source);
  const body = JSON.stringify({ source });
  if (new TextEncoder().encode(body).byteLength > 512 * 1024) throw new Error('This finalized transcript is too large for generation. Keep its local download.');
  const payload = await request('/generate', signal, body, backend);
  return recordingMapResult(source, payload);
}

function recordingMapResult(source, payload) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.request_id)) throw unreadable();
  const artifact = payload.artifact;
  let result;
  try {
    validateThreadsArtifact(artifact);
    result = createRecordingThreads({ ...source, graph: { nodes: artifact?.graph_data, edges: artifact?.edges,
      metadata: { conversation_title: artifact?.conversation_title, executive_summary: artifact?.executive_summary },
      conversation_threads: artifact?.conversation_threads } });
    for (const key of ['conversation_id', 'recorded_at', 'transcription_complete', 'source_tokens', 'utterances', 'full_transcript']) {
      if (JSON.stringify(result.bundle[key]) !== JSON.stringify(artifact[key])) throw unreadable();
    }
  } catch { throw unreadable(); }
  // Validator signals (items dropped server-side) travel with the map; re-validation alone cannot see them.
  if (Array.isArray(artifact.audit_signals)) {
    const signals = artifact.audit_signals.slice(0, 500).filter(item => item && typeof item === 'object' && !Array.isArray(item))
      .map(item => Object.fromEntries(Object.entries(item).filter(([, v]) => ['string', 'number'].includes(typeof v))));
    result.bundle.audit_signals = [...(result.bundle.audit_signals || []), ...signals];
  }
  return result;
}


export function configuredMapRoutes(runtime) {
  if (runtime.credentialsReady === false) return [];
  const { preferences, keys } = runtime;
  const chain = Array.isArray(preferences.mapChain) && preferences.mapChain.length
    ? preferences.mapChain
    : (preferences.map || ['openrouter']).map(backend => ({
        backend,
        model: preferences.models?.[backend] || '',
        ...(backend === 'openrouter' && preferences.openrouterProvider ? { provider: preferences.openrouterProvider } : {}),
      }));
  return chain.map(({ backend, model, provider }) => keys[backend]
    ? { backend, key: keys[backend], model: model || preferences.models?.[backend] || '',
      ...(backend === 'openrouter' && provider ? { provider } : {}) }
    : { backend });
}

export async function getOrderedMapStatus(signal, routes) {
  const response = await fetch('/api/cloud/map/status', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
  if (!response.ok) throw unreadable();
  const value = await readJSON(response, signal, 8192);
  if (typeof value.available !== 'boolean' || typeof value.personal !== 'boolean' || !value.providers) throw unreadable();
  const ready = routes.filter(({ backend, key, model }) => key
    ? value.personal && model
    : value.providers[backend]?.enabled);
  const models = routes.flatMap(({ backend, key, model, provider }) => {
    if (key && model) return [`${MAP_PROVIDERS[backend].name} · ${model}${provider ? ' · ' + provider : ''}`];
    const info = value.providers[backend];
    return info?.model ? [describeModelRoute(info)] : [];
  });
  return { enabled: Boolean(ready.length), available: Boolean(ready.length && value.available), audience: value.audience, models };
}

async function readClientEventStream(response, signal, onEvent) {
  if (!response.body) throw unreadable();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let currentEvent = 'message';
  let completedPayload = null;
  let streamError = null;
  const stop = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', stop, { once: true });

  const dispatch = (eventName, rawData) => {
    let data;
    try { data = JSON.parse(rawData); } catch { return; }
    if (eventName === 'complete') completedPayload = data;
    else if (eventName === 'error') streamError = data;
    else onEvent?.({ type: eventName, ...data });
  };

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let ev = currentEvent;
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length) dispatch(ev, dataLines.join('\n'));
      }
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    stop();
  }
  if (streamError) throw failure(streamError.status || 502, streamError);
  if (!completedPayload || typeof completedPayload !== 'object') throw unreadable();
  return completedPayload;
}

export async function generateOrderedRecordingMap(source, signal, routes, guidance, context = {}) {
  createRecordingTranscript(source);
  const body = JSON.stringify({ source, routes, guidance, ...(context.task ? { task: context.task } : {}),
    ...(context.topics ? { topics: context.topics } : {}), ...(context.glossary ? { glossary: context.glossary } : {}) });
  if (new TextEncoder().encode(body).byteLength > 512 * 1024) throw new Error('This finalized transcript is too large for generation. Keep its local download.');
  const startedAt = Date.now();
  let ttftMs = null;
  const wantsStream = typeof context.onEvent === 'function';
  const wrappedOnEvent = wantsStream ? (ev) => {
    if (ev?.type === 'stage' && ev.stage === 'connected' && typeof ev.ttftMs === 'number') ttftMs = ev.ttftMs;
    context.onEvent(ev);
  } : null;
  try {
    const response = await fetch('/api/cloud/map/generate', { method: 'POST',
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', 'X-LCT-Map-Consent': 'generate-v1',
        ...(wantsStream ? { Accept: 'text/event-stream' } : {}) }, body });
    const isEventStream = wantsStream && response.ok && response.headers.get('content-type')?.toLowerCase().includes('text/event-stream');
    const payload = isEventStream
      ? await readClientEventStream(response, signal, wrappedOnEvent)
      : await readJSON(response, signal, 2 * 1024 * 1024 + 1024);
    if (!response.ok) throw failure(response.status, payload);
    if (!routes.some(route => route.backend === payload.backend)) throw unreadable();
    const notes = Array.isArray(payload.boundary_notes) ? payload.boundary_notes : null;
    const result = recordingMapResult(source, payload);
    const cov = result.bundle.coverage;
    const coveragePct = cov?.total_turns ? Math.round((cov.covered_turns / cov.total_turns) * 100) : null;
    recordSitesCostEntry({
      provider: payload.backend, model: payload.model, usage: payload.usage, kind: context.task || 'map',
      requestId: payload.request_id, ttftMs, durationMs: Date.now() - startedAt, outcome: 'ok',
      nodes: result.bundle.graph_data?.length ?? null, coveragePct,
    });
    return { ...result, backend: payload.backend, model: payload.model,
      ...(payload.usage ? { usage: payload.usage } : {}),
      ...(notes ? { boundaryNotes: notes, stubTopicIds: Array.isArray(payload.stub_topic_ids) ? payload.stub_topic_ids : [] } : {}),
      ...(Array.isArray(payload.glossary) ? { glossary: payload.glossary } : {}), attempts: publicAttempts(payload.attempts) };
  } catch (err) {
    if (err?.name !== 'AbortError') {
      const first = routes[0];
      recordSitesCostEntry({
        provider: first?.backend || 'unknown', model: first?.model || 'site-default', kind: context.task || 'map',
        ttftMs, durationMs: Date.now() - startedAt, outcome: 'error', errorCode: err?.code || String(err?.status || 'failed'),
      });
    }
    throw err;
  }
}

/**
 * Ask one provider route to audit transcript spans against map nodes. Findings come back in the
 * segment's local utterance IDs; the caller maps them to the full transcript.
 */
export async function auditRecordingMap(source, signal, route, nodes) {
  createRecordingTranscript(source);
  const body = JSON.stringify({ source, routes: [route], task: 'audit', nodes });
  if (new TextEncoder().encode(body).byteLength > 512 * 1024) throw new Error('This audit request is too large. Audit fewer spans.');
  const response = await fetch('/api/cloud/map/generate', { method: 'POST',
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', 'X-LCT-Map-Consent': 'generate-v1' }, body });
  const payload = await readJSON(response, signal, 2 * 1024 * 1024 + 1024);
  if (!response.ok) throw failure(response.status, payload);
  if (payload.task !== 'audit' || !Array.isArray(payload.findings) || payload.backend !== route.backend) throw unreadable();
  recordSitesCostEntry({ provider: payload.backend, model: payload.model, usage: payload.usage, kind: 'audit', requestId: payload.request_id });
  return { findings: payload.findings, backend: payload.backend, model: payload.model,
    ...(payload.usage ? { usage: payload.usage } : {}),
    droppedRanges: payload.dropped_ranges || 0, unknownNodes: payload.unknown_nodes || 0, malformed: payload.malformed || 0,
    attempts: publicAttempts(payload.attempts) };
}

/**
 * Quiet background epistemic extraction (cruxes, factual claims, normative assumptions) anchored
 * to canonical utterance IDs and known map node IDs.
 */
export async function extractEpistemicMap(source, signal, routes, nodes) {
  createRecordingTranscript(source);
  const body = JSON.stringify({ source, routes, task: 'epistemic', nodes });
  if (new TextEncoder().encode(body).byteLength > 512 * 1024) throw new Error('This epistemic analysis request is too large.');
  const startedAt = Date.now();
  const response = await fetch('/api/cloud/map/generate', { method: 'POST',
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', 'X-LCT-Map-Consent': 'generate-v1' }, body });
  const payload = await readJSON(response, signal, 2 * 1024 * 1024 + 1024);
  if (!response.ok) throw failure(response.status, payload);
  if (payload.task !== 'epistemic' || !payload.epistemic || !routes.some(route => route.backend === payload.backend)) throw unreadable();
  recordSitesCostEntry({ provider: payload.backend, model: payload.model, usage: payload.usage, kind: 'epistemic', requestId: payload.request_id, durationMs: Date.now() - startedAt, outcome: 'ok' });
  return { epistemic: payload.epistemic, backend: payload.backend, model: payload.model,
    ...(payload.usage ? { usage: payload.usage } : {}),
    droppedRanges: payload.dropped_ranges || 0, unknownNodes: payload.unknown_nodes || 0, malformed: payload.malformed || 0,
    attempts: publicAttempts(payload.attempts) };
}
