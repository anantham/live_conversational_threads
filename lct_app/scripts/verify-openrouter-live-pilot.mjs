import { readFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ORIGIN = 'https://threads-adityaarpitha-cloud.avalokai.chatgpt.site';
const ADAPTER = new URL('../src/services/cloud/openRouterClient.js', import.meta.url);
const DISCUSSION = new URL('../src/components/discussion/discussionModel.js', import.meta.url);
const READER = new URL('../src/services/threadsArtifact.js', import.meta.url);
const SHA = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(code); };
const CODES = new Set(['preflight_arguments', 'adapter_drift', 'status_not_ready', 'status_unreadable',
  'request_refused', 'artifact_unusable', 'overall_timeout', 'canceled', 'attempt_already_claimed',
  'network_refused']);
export function classifyPilotFailure(error) {
  if (error?.code === 'EEXIST') return 'attempt_already_claimed';
  return CODES.has(error?.message) ? error.message : 'unknown';
}

// The source is fixed in this program. It has no input path, audio, or participant data.
export const SYNTHETIC_SOURCE = Object.freeze({ recordingId: 'synthetic-openrouter-once',
  startedAt: Date.UTC(2026, 9, 14), complete: true, finalTokens: [
    { text: 'A paper map can link an idea to its exact sentence.', speaker: 'synthetic-a', startMs: 0, endMs: 3100 },
    { text: ' A second idea can answer that sentence.', speaker: 'synthetic-b', startMs: 3200, endMs: 5800 },
  ] });

async function loadConsumers() {
  const load = async entry => {
    const compiled = await build({ entryPoints: [fileURLToPath(entry)], bundle: true, write: false,
      platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
    return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
  };
  const [adapter, reader, discussion] = await Promise.all([load(ADAPTER), load(READER), load(DISCUSSION)]);
  return { ...adapter, ...reader, ...discussion };
}

async function bounded(operation, signal) {
  if (signal.aborted) fail('canceled');
  let onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(new Error('canceled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation, stopped]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export async function runPilot(options, deps = {}) {
  const { origin, adapterSha256, guardPath, arm } = options;
  if (arm !== 'OPENROUTER_SYNTHETIC_ONCE' || origin !== ORIGIN ||
      !/^[a-f0-9]{64}$/.test(adapterSha256 ?? '') || typeof guardPath !== 'string' || !guardPath.trim()) {
    fail('preflight_arguments');
  }
  const fetcher = deps.fetcher ?? globalThis.fetch;
  const claim = deps.claim ?? (async path => { const file = await open(path, 'wx'); await file.close(); });
  const emit = deps.emit ?? (() => {});
  const now = deps.now ?? Date.now;
  const begun = now();
  const controller = new AbortController();
  const signal = controller.signal;
  let expired = false, canceled = false, stageName = 'preflight', postCount = 0;
  const stage = name => { stageName = name; emit({ stage: name, elapsedMs: Math.max(0, now() - begun), remaining: 'Time remaining unknown' }); };
  const onCancel = () => { canceled = true; controller.abort(); };
  const onExternalAbort = () => onCancel();
  const onTimeout = () => { expired = true; controller.abort(); };
  const deadline = setTimeout(onTimeout, deps.deadlineMs ?? 90_000);
  const progress = setInterval(() => stage(stageName), 1000);
  process.on('SIGINT', onCancel);
  process.on('SIGTERM', onCancel);
  deps.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (deps.signal?.aborted) onExternalAbort();
  const network = async (url, init) => {
    const route = url === '/api/cloud/openrouter/status' ? 'status'
      : url === '/api/cloud/openrouter/generate' ? 'generate' : null;
    if (!route || init?.method !== (route === 'status' ? 'GET' : 'POST') ||
        init?.redirect !== 'error') fail('network_refused');
    if (route === 'generate' && ++postCount !== 1) fail('network_refused');
    if (signal.aborted) fail('canceled');
    const response = await fetcher(origin + url, { ...init, signal, redirect: 'error',
      headers: { ...init.headers, Origin: origin } });
    if (response.redirected || response.status >= 300 && response.status < 400) fail('network_refused');
    return response;
  };
  const priorFetch = globalThis.fetch;
  try {
    stage('preflight');
    const bytes = await bounded((deps.read ?? readFile)(ADAPTER), signal);
    if (SHA(bytes) !== adapterSha256) fail('adapter_drift');
    const consumers = await bounded(deps.consumers ?? loadConsumers(), signal);
    globalThis.fetch = network;
    const status = await bounded(consumers.getRecordingMapStatus(signal), signal).catch(() => fail('status_unreadable'));
    if (signal.aborted) fail('canceled');
    if (status.enabled !== true || status.available !== true || status.configured !== true ||
        status.schema_ready !== true || status.audience !== 'public' ||
        status.model !== 'google/gemini-2.5-flash-lite' || status.provider !== 'google-vertex' ||
        status.max_output_tokens !== 8192) fail('status_not_ready');
    await bounded(claim(guardPath), signal); // Exclusive wx guard is retained on every outcome.
    if (signal.aborted) fail('canceled');
    stage('generating');
    const generated = await bounded(consumers.generateRecordingMap(SYNTHETIC_SOURCE, signal), signal)
      .catch(() => fail('request_refused'));
    if (signal.aborted) fail('canceled');
    stage('verifying');
    const opened = await consumers.readThreadsFile(generated.file).catch(() => fail('artifact_unusable'));
    const sourceText = SYNTHETIC_SOURCE.finalTokens.map(token => token.text).join('');
    const utterances = opened.utterances;
    const moments = opened.graph_data?.filter(node => node.semantic_level === 1) ?? [];
    const model = consumers.buildDiscussionModel(opened.graph_data, utterances);
    const linked = moments.filter(node => (model.utterancesByMoment.get(node.id) ?? []).some(id => model.utteranceById.has(id)));
    if (opened.full_transcript !== sourceText || opened.conversation_id !== SYNTHETIC_SOURCE.recordingId ||
        opened.transcription_complete !== true || JSON.stringify(opened.source_tokens) !== JSON.stringify(
          SYNTHETIC_SOURCE.finalTokens.map(token => ({ text: token.text, speaker: token.speaker,
            start_ms: token.startMs, end_ms: token.endMs }))) ||
        !Array.isArray(utterances) || utterances.length !== 2 ||
        utterances.map(row => row.text).join('') !== sourceText ||
        !Array.isArray(opened.conversation_threads) ||
        !moments.length || !linked.length || !model.rootIds.length ||
        !linked.every(node => node.source_ref.utterance_ids.every(id => model.utteranceById.has(id)))) fail('artifact_unusable');
    return { outcome: 'verified', postCount, elapsedMs: Math.max(0, now() - begun),
      nodeCount: opened.graph_data.length, momentCount: moments.length,
      linkedMomentCount: linked.length, utteranceCount: utterances.length, threadCount: opened.conversation_threads.length };
  } catch (error) {
    if (expired) fail('overall_timeout');
    if (canceled || signal.aborted) fail('canceled');
    throw error;
  } finally {
    globalThis.fetch = priorFetch;
    clearTimeout(deadline); clearInterval(progress);
    process.off('SIGINT', onCancel); process.off('SIGTERM', onCancel);
    deps.signal?.removeEventListener('abort', onExternalAbort);
    controller.abort();
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || !argv[index + 1] || args[argv[index].slice(2)]) fail('preflight_arguments');
    args[argv[index].slice(2)] = argv[index + 1];
  }
  if (Object.keys(args).some(key => !['origin', 'adapter-sha256', 'guard', 'arm'].includes(key))) fail('preflight_arguments');
  return { origin: args.origin, adapterSha256: args['adapter-sha256'], guardPath: args.guard, arm: args.arm };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => runPilot(parseArgs(process.argv.slice(2)),
    { emit: value => console.log(JSON.stringify(value)) }))
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(JSON.stringify({ outcome: 'failed', reason: classifyPilotFailure(error) })); process.exitCode = 1; });
}
