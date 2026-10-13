import { readFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SonioxStream } from '../src/services/cloud/sonioxStream.js';

const ORIGIN = 'https://threads-adityaarpitha-cloud.avalokai.chatgpt.site';
const SESSION = '/api/cloud/soniox/session';
const MAX_WAV = 2 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const refuse = code => { throw new Error(code); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const RUN_CODES = new Set(['preflight_arguments', 'invalid_wav', 'wav_identity', 'source_identity',
  'soniox_status', 'soniox_not_ready', 'openrouter_status', 'openrouter_not_off',
  'redirect_refused', 'oversized_response', 'mint_refused', 'invalid_session',
  'verification_failed', 'canceled', 'mint_timeout', 'overall_timeout']);
const PROVIDER_CODES = new Set(['organization_balance_exhausted', 'organization_monthly_budget_exhausted',
  'project_monthly_budget_exhausted', 'temp_api_key_session_expired', 'limit_exceeded',
  'permission_denied', 'unauthenticated', 'model_not_available', 'invalid_request',
  'request_timeout', 'max_duration_reached', 'internal_error', 'service_unavailable', 'unknown_error']);

export function classifyPilotFailure(error) {
  if (error?.code === 'EEXIST') return 'attempt_already_claimed';
  const message = error?.message;
  if (RUN_CODES.has(message)) return message;
  const provider = /^Live transcription provider error \(([a-z_]+)\)\.$/.exec(message ?? '');
  if (provider && PROVIDER_CODES.has(provider[1])) return `provider_${provider[1]}`;
  if (message === 'Live transcription connect timed out.') return 'connect_timeout';
  if (message === 'Live transcription finish timed out.') return 'finalization_timeout';
  if (['Live transcription connection failed.', 'Live transcription connection closed before completion.',
    'Live transcription could not open a connection.'].includes(message)) return 'connection_failed';
  if (message === 'Live transcription was canceled.') return 'canceled';
  return 'unknown';
}

async function abortable(operation, signal) {
  if (signal.aborted) refuse('canceled');
  let onAbort;
  const canceled = new Promise((_, reject) => {
    onAbort = () => reject(new Error('canceled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation, canceled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export function inspectSyntheticWav(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > MAX_WAV ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' ||
      bytes.readUInt32LE(4) + 8 !== bytes.length) refuse('invalid_wav');
  let fmt, audio, pos = 12;
  while (pos + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(pos + 4);
    const end = pos + 8 + length;
    if (end > bytes.length) refuse('invalid_wav');
    const name = bytes.toString('ascii', pos, pos + 4);
    if (name === 'fmt ') {
      if (fmt || length < 16) refuse('invalid_wav');
      fmt = { tag: bytes.readUInt16LE(pos + 8), channels: bytes.readUInt16LE(pos + 10),
        rate: bytes.readUInt32LE(pos + 12), byteRate: bytes.readUInt32LE(pos + 16),
        block: bytes.readUInt16LE(pos + 20), bits: bytes.readUInt16LE(pos + 22) };
      if (fmt.tag === 0xfffe) {
        if (length < 40 || bytes.readUInt16LE(pos + 32) !== 1 ||
            bytes.toString('hex', pos + 34, pos + 48) !== '000000001000800000aa00389b71') refuse('invalid_wav');
        fmt.tag = 1;
      }
    }
    if (name === 'data') {
      if (audio || !length) refuse('invalid_wav');
      audio = { length, offset: pos + 8 };
    }
    pos = end + (length & 1);
  }
  if (!fmt || !audio || pos !== bytes.length || fmt.tag !== 1 ||
      ![8, 16, 24, 32].includes(fmt.bits) || fmt.channels < 1 || fmt.channels > 2 ||
      fmt.rate < 8000 || fmt.rate > 48000 || fmt.block !== fmt.channels * fmt.bits / 8 ||
      fmt.byteRate !== fmt.rate * fmt.block || audio.length % fmt.block ||
      audio.length / fmt.byteRate > 20) refuse('invalid_wav');
  return { durationMs: Math.ceil(audio.length * 1000 / fmt.byteRate), byteRate: fmt.byteRate,
    audioBytes: audio.length, audioOffset: audio.offset };
}

async function boundedFetch(fetcher, url, options, signal, limit) {
  const response = await abortable(fetcher(url, { ...options, signal, redirect: 'manual' }), signal);
  if (response.redirected || response.status >= 300 && response.status < 400) refuse('redirect_refused');
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > limit) refuse('oversized_response');
  const bytes = Buffer.from(await abortable(response.arrayBuffer(), signal));
  if (bytes.length > limit) refuse('oversized_response');
  return { response, bytes };
}

export async function runPilot(options, deps = {}) {
  const { origin, assetPath, assetSha256, wavPath, wavSha256, guardPath, keywords, arm } = options;
  const fetcher = deps.fetcher ?? globalThis.fetch;
  const StreamClass = deps.StreamClass ?? SonioxStream;
  const read = deps.read ?? readFile;
  const claim = deps.claim ?? (async path => { const file = await open(path, 'wx'); await file.close(); });
  const wait = deps.wait ?? ((ms, signal) => new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(new Error('canceled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  }));
  const now = deps.now ?? Date.now;
  const emit = deps.emit ?? (() => {});
  const started = now();
  if (arm !== 'SONIOX_SYNTHETIC_ONCE' || origin !== ORIGIN ||
      !/^\/assets\/[\w.-]+\.js$/.test(assetPath) || !hex(assetSha256) || !hex(wavSha256) ||
      typeof wavPath !== 'string' || typeof guardPath !== 'string' ||
      !Array.isArray(keywords) || keywords.length < 1 || keywords.length > 8 ||
      keywords.some(k => !/^[a-z]{2,24}$/.test(k))) refuse('preflight_arguments');
  const controller = new AbortController();
  const signal = controller.signal;
  let deadline = null, providerFailure = null;
  const timer = setTimeout(() => { deadline = 'overall_timeout'; controller.abort(); }, 45_000);
  let currentStage = 'preflight';
  const stage = name => { currentStage = name; emit({ stage: name, elapsedMs: now() - started, remaining: 'Time remaining unknown' }); };
  const progress = setInterval(() => stage(currentStage), 1000);
  let stream, minted = false, frameCount = 0, incremental = 0, finalTokenCount = 0;
  let finalText = '';
  try {
    stage('preflight');
    const wav = await read(wavPath);
    if (digest(wav) !== wavSha256) refuse('wav_identity');
    const wave = inspectSyntheticWav(wav);
    const asset = await boundedFetch(fetcher, origin + assetPath, { method: 'GET' }, signal, 10 * MAX_WAV);
    if (asset.response.status !== 200 || digest(asset.bytes) !== assetSha256) refuse('source_identity');
    const status = await boundedFetch(fetcher, origin + '/api/cloud/soniox/status', { method: 'GET' }, signal, 8192);
    if (status.response.status !== 200) refuse('soniox_status');
    const soniox = JSON.parse(status.bytes.toString('utf8'));
    if (soniox.enabled !== true || soniox.audience !== 'public' || soniox.max_session_seconds !== 300) refuse('soniox_not_ready');
    const other = await boundedFetch(fetcher, origin + '/api/cloud/openrouter/status', { method: 'GET' }, signal, 8192);
    if (other.response.status !== 200) refuse('openrouter_status');
    const openrouter = JSON.parse(other.bytes.toString('utf8'));
    if (openrouter.enabled !== false || openrouter.schema_ready !== true) refuse('openrouter_not_off');
    if (signal.aborted) refuse('canceled');
    await claim(guardPath); // exclusive wx: an attempt is permanently spent even if mint refuses
    minted = true;
    stage('authorizing');
    const mintDeadline = setTimeout(() => { deadline = 'mint_timeout'; controller.abort(); }, 15_000);
    let session;
    try {
      session = await boundedFetch(fetcher, origin + SESSION, { method: 'POST', credentials: 'same-origin',
        headers: { Origin: origin, 'X-LCT-Soniox-Consent': 'transcribe-v1' } }, signal, 8192);
    } finally { clearTimeout(mintDeadline); }
    if (session.response.status !== 201) refuse('mint_refused');
    const ticket = JSON.parse(session.bytes.toString('utf8'));
    if (typeof ticket.api_key !== 'string' || !ticket.api_key.startsWith('snx_temp_') ||
        ticket.api_key.length > 4096 || !Number.isFinite(Date.parse(ticket.expires_at)) ||
        Date.parse(ticket.expires_at) <= Date.now() || ticket.max_session_seconds !== 300 ||
        typeof ticket.session_id !== 'string' || !ticket.session_id) refuse('invalid_session');
    stage('connecting');
    stream = new StreamClass({ onTranscript: snapshot => {
      if (typeof snapshot?.finalText !== 'string' || !Array.isArray(snapshot.finalTokens)) return;
      if (snapshot.finalText !== finalText || snapshot.partialTokens?.length) incremental++;
      finalText = snapshot.finalText;
      finalTokenCount = snapshot.finalTokens.length;
    }, onFailure: error => { providerFailure = error; controller.abort(); } });
    const connection = stream.connect({ apiKey: ticket.api_key, expiresAt: ticket.expires_at,
      maxSessionSeconds: ticket.max_session_seconds, signal });
    ticket.api_key = null;
    await abortable(connection, signal);
    if (signal.aborted || providerFailure) refuse('canceled');
    stage('streaming');
    const frameBytes = Math.max(wave.audioOffset + wave.byteRate / 2, wave.byteRate / 2);
    const size = Math.min(262144, Math.floor(frameBytes));
    for (let offset = 0; offset < wav.length; offset += size) {
      if (signal.aborted || providerFailure) refuse('canceled');
      stream.sendAudio(wav.subarray(offset, Math.min(offset + size, wav.length)).buffer.slice(
        wav.byteOffset + offset, wav.byteOffset + Math.min(offset + size, wav.length)));
      frameCount++;
      if (offset + size < wav.length) await wait(Math.ceil(Math.min(size, wav.length - offset) * 1000 / wave.byteRate), signal);
    }
    const beforeFinish = incremental;
    stage('finalizing');
    await abortable(stream.finish(), signal);
    if (signal.aborted || providerFailure) refuse('canceled');
    const normalized = finalText.toLowerCase().replace(/[^a-z]+/g, ' ');
    const matches = Object.fromEntries(keywords.map(k => [k, normalized.split(' ').includes(k)]));
    if (beforeFinish < 1 || finalTokenCount < 1 || Object.values(matches).some(value => !value)) refuse('verification_failed');
    return { outcome: 'finished', minted, durationMs: wave.durationMs, elapsedMs: now() - started,
      frameCount, incrementalBeforeFinish: beforeFinish, finalTokenCount, keywords: matches };
  } catch (error) {
    if (deadline) refuse(deadline);
    if (providerFailure) throw providerFailure;
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(progress);
    controller.abort();
    stream?.cancel();
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1]) refuse('preflight_arguments');
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return { origin: args.origin, assetPath: args['asset-path'], assetSha256: args['asset-sha256'],
    wavPath: args.wav, wavSha256: args['wav-sha256'], guardPath: args.guard,
    keywords: args.keywords?.split(','), arm: args.arm };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => runPilot(parseArgs(process.argv.slice(2)),
    { emit: status => console.log(JSON.stringify(status)) }))
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(JSON.stringify({ outcome: 'failed', reason: classifyPilotFailure(error),
      detail: 'Pilot stopped; inspect local preflight and session counts before any further action.' })); process.exitCode = 1; });
}
