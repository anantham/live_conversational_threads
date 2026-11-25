import { createRecordingTranscript } from './recordingTranscript.js';
import { createRecordingThreads } from './recordingThreads.js';
import { generateOrderedRecordingMap } from './openRouterClient.js';

export const DEFAULT_WINDOW_MAX_WORDS = 2800;
export const DEFAULT_WINDOW_MAX_SECONDS = 900; // 15 minutes
export const DEFAULT_WINDOW_INTERVAL_MS = 10_500;

function countWords(text) {
  return String(text || '').match(/\S+/g)?.length || 0;
}

/**
 * Split a full recording source into contiguous utterance windows so long transcripts
 * (e.g. 60-90 min meetings) produce rich multi-tier maps without hitting output-token limits.
 */
export function splitSourceIntoWindows(source, { maxWords = DEFAULT_WINDOW_MAX_WORDS, maxSeconds = DEFAULT_WINDOW_MAX_SECONDS } = {}) {
  const { document } = createRecordingTranscript(source);
  const utterances = document.utterances;
  const totalWords = utterances.reduce((sum, u) => sum + countWords(u.text), 0);
  const firstStart = utterances[0]?.timestamp_start ?? 0;
  const lastEnd = utterances.at(-1)?.timestamp_end ?? utterances.at(-1)?.timestamp_start ?? firstStart;
  const totalSeconds = Math.max(0, lastEnd - firstStart);

  if (totalWords <= maxWords && totalSeconds <= maxSeconds) {
    return [{
      index: 0,
      source,
      startMs: Math.round(firstStart * 1000),
      endMs: Math.round(lastEnd * 1000),
      utteranceCount: utterances.length,
      wordCount: totalWords,
      globalUtteranceIds: utterances.map(u => u.id),
    }];
  }

  const windows = [];
  let bucket = [];
  let bucketWords = 0;
  let bucketStartSec = firstStart;

  const flush = () => {
    if (!bucket.length) return;
    const index = windows.length;
    const finalTokens = bucket.map((utterance, i) => ({
      text: (i === 0 ? '' : '\n') + utterance.text.trim(),
      speaker: utterance.speaker_id,
      startMs: utterance.timestamp_start != null ? Math.round(utterance.timestamp_start * 1000) : null,
      endMs: utterance.timestamp_end != null ? Math.round(utterance.timestamp_end * 1000) : null,
    }));
    const startSec = bucket[0].timestamp_start ?? bucketStartSec;
    const endSec = bucket.at(-1).timestamp_end ?? bucket.at(-1).timestamp_start ?? startSec;
    windows.push({
      index,
      source: {
        recordingId: `${source.recordingId}-w${index + 1}`,
        startedAt: source.startedAt,
        finalTokens,
        complete: true,
      },
      startMs: Math.round(startSec * 1000),
      endMs: Math.round(endSec * 1000),
      utteranceCount: bucket.length,
      wordCount: bucketWords,
      globalUtteranceIds: bucket.map(u => u.id),
    });
    bucket = [];
    bucketWords = 0;
  };

  for (const utterance of utterances) {
    const words = countWords(utterance.text);
    const startSec = utterance.timestamp_start ?? bucketStartSec;
    const spanSec = Math.max(0, startSec - bucketStartSec);
    if (bucket.length && (bucketWords + words > maxWords || spanSec >= maxSeconds)) {
      flush();
      bucketStartSec = startSec;
    }
    bucket.push(utterance);
    bucketWords += words;
  }
  flush();
  return windows;
}

function remapNodeId(prefix, id) {
  return id == null ? null : `${prefix}${id}`;
}

/**
 * Assemble multiple window-level generated `.threads` bundles back onto the single
 * canonical full conversation source, preserving exact global utterance IDs & timestamps.
 */
export function mergeWindowedGraphs(fullSource, windowResults, { title = '', meetingMetadata = null, mediaRefs = [] } = {}) {
  const allNodes = [];
  const allEdges = [];
  const allThreads = [];
  const summaries = [];

  for (const item of windowResults) {
    const { window: win, bundle } = item;
    const prefix = windowResults.length > 1 ? `w${win.label ?? win.index + 1}-` : '';
    const localUtterances = Array.isArray(bundle.utterances) ? bundle.utterances : [];
    const localToGlobal = new Map();
    for (let i = 0; i < localUtterances.length; i++) {
      const globalId = win.globalUtteranceIds[i];
      if (globalId) localToGlobal.set(localUtterances[i].id, globalId);
    }
    const mapEvidence = (ids) => [...new Set((ids || []).map(id => localToGlobal.get(id)).filter(Boolean))];

    if (bundle.executive_summary) summaries.push(bundle.executive_summary.trim());

    for (const node of bundle.graph_data || []) {
      const mapped = {
        id: remapNodeId(prefix, node.id),
        semantic_level: node.semantic_level,
        semantic_type: node.semantic_type,
        node_name: node.node_name,
        source_ref: { utterance_ids: mapEvidence(node.source_ref?.utterance_ids) },
        ...(node.summary ? { summary: node.summary } : {}),
        ...(node.source_excerpt == null ? {} : { source_excerpt: node.source_excerpt }),
        ...(node.thread_id ? { thread_id: remapNodeId(prefix, node.thread_id) } : {}),
        ...(node.speaker_id ? { speaker_id: node.speaker_id } : {}),
        ...(node.parent_id ? { parent_id: remapNodeId(prefix, node.parent_id) } : {}),
        ...(Array.isArray(node.children_ids) ? { children_ids: node.children_ids.map(id => remapNodeId(prefix, id)) } : {}),
        ...(Array.isArray(node.memberships) ? {
          memberships: node.memberships.map(membership => ({ ...membership, parent_id: remapNodeId(prefix, membership.parent_id) })),
        } : {}),
      };
      allNodes.push(mapped);
    }

    for (const edge of bundle.edges || []) {
      allEdges.push({
        ...edge,
        id: remapNodeId(prefix, edge.id),
        from_node_id: remapNodeId(prefix, edge.from_node_id),
        to_node_id: remapNodeId(prefix, edge.to_node_id),
      });
    }

    for (const thread of bundle.conversation_threads || []) {
      allThreads.push({
        id: remapNodeId(prefix, thread.id),
        title: thread.title,
        ...(thread.summary ? { summary: thread.summary } : {}),
        steps: (thread.steps || []).map(step => ({
          ...step,
          moment_id: remapNodeId(prefix, step.moment_id),
          evidence_utterance_ids: mapEvidence(step.evidence_utterance_ids),
        })),
      });
    }
  }

  const finalTitle = title || windowResults[0]?.bundle?.conversation_title || 'Conversation map';
  const assembled = createRecordingThreads({
    ...fullSource,
    graph: {
      metadata: {
        conversation_title: finalTitle,
        executive_summary: summaries.join('\n\n'),
      },
      nodes: allNodes,
      edges: allEdges,
      conversation_threads: allThreads,
    },
  });

  const bundle = {
    ...assembled.bundle,
    ...(mediaRefs?.length ? { media_refs: mediaRefs } : {}),
    ...(meetingMetadata ? { meeting_metadata: meetingMetadata } : {}),
  };
  return { ...assembled, bundle, json: JSON.stringify(bundle, null, 2) };
}

// Windows split this many times at most (a 15-minute window becomes quarters at worst).
export const MAX_WINDOW_SPLIT_DEPTH = 2;

/** Halve a window by utterances, keeping global IDs and timing; null when it cannot shrink further. */
export function splitWindowInHalf(win) {
  const depth = win.splitDepth ?? 0;
  if (depth >= MAX_WINDOW_SPLIT_DEPTH || win.utteranceCount < 2) return null;
  const tokens = win.source.finalTokens;
  const middle = Math.ceil(tokens.length / 2);
  return [tokens.slice(0, middle), tokens.slice(middle)].map((part, half) => {
    const finalTokens = part.map((token, i) => ({ ...token, text: i === 0 ? token.text.replace(/^\n/, '') : token.text }));
    const ids = half === 0 ? win.globalUtteranceIds.slice(0, middle) : win.globalUtteranceIds.slice(middle);
    const label = `${win.label ?? win.index + 1}${half === 0 ? 'a' : 'b'}`;
    return { ...win, label, splitDepth: depth + 1,
      source: { ...win.source, recordingId: `${win.source.recordingId}${half === 0 ? 'a' : 'b'}`, finalTokens },
      startMs: finalTokens[0].startMs ?? win.startMs, endMs: finalTokens.at(-1).endMs ?? win.endMs,
      utteranceCount: finalTokens.length, wordCount: finalTokens.reduce((sum, t) => sum + countWords(t.text), 0),
      globalUtteranceIds: ids };
  });
}

const clock = ms => {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map(v => String(v).padStart(2, '0')).join(':');
};

// One console line per window event: timing, sizes and outcome only, never transcript or map text.
function logWindow(event, win, position, total, details = {}) {
  try {
    const { message, ...rest } = details;
    console.info(`[lct-pipeline] window ${win.label} (${position + 1}/${total}, ${clock(win.startMs)}–${clock(win.endMs)}, `
      + `${win.utteranceCount} turns, ${win.wordCount} words) ${event}`, { ...rest, ...(message ? { error: message } : {}) });
  } catch { /* Logging must never change the pipeline result. */ }
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run the multi-tier generation pipeline across all windows of a transcript,
 * emitting live progress and assembling a single source-owned `.threads` bundle.
 */
export async function runLongTranscriptPipeline({
  source,
  routes,
  guidance = '',
  title = '',
  meetingMetadata = null,
  mediaRefs = [],
  signal,
  onProgress,
  generateWindow = generateOrderedRecordingMap,
  intervalMs = DEFAULT_WINDOW_INTERVAL_MS,
  windowOptions = {},
}) {
  const windows = splitSourceIntoWindows(source, windowOptions).map(win => ({ ...win, label: String(win.index + 1) }));
  const completed = [];
  let lastBackend = null;
  let lastModel = null;

  for (let i = 0; i < windows.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const win = windows[i];
    // Split halves wait too, even at position 0: the Worker admits one attempt per interval.
    if (i > 0 || win.splitDepth) {
      onProgress?.({ phase: 'waiting', windowIndex: i, totalWindows: windows.length, startMs: win.startMs, endMs: win.endMs, completedWindows: completed.length });
      await sleep(intervalMs, signal);
    }
    onProgress?.({ phase: 'generating', windowIndex: i, totalWindows: windows.length, startMs: win.startMs, endMs: win.endMs, completedWindows: completed.length });
    const startedAt = Date.now();
    logWindow('start', win, i, windows.length);
    let result;
    try {
      result = await generateWindow(win.source, signal, routes, guidance);
    } catch (error) {
      const halves = error?.stopReason === 'max_tokens' ? splitWindowInHalf(win) : null;
      logWindow(halves ? 'split' : 'failed', win, i, windows.length, { ms: Date.now() - startedAt, message: error?.message });
      if (!halves) throw error;
      // The map for this window did not fit the output cap: map each half instead.
      windows.splice(i, 1, ...halves);
      i -= 1;
      continue;
    }
    logWindow('done', win, i, windows.length, { ms: Date.now() - startedAt, nodes: result.bundle?.graph_data?.length,
      backend: result.backend, model: result.model });
    lastBackend = result.backend || lastBackend;
    lastModel = result.model || lastModel;
    completed.push({ window: win, bundle: result.bundle });
    const partial = mergeWindowedGraphs(source, completed, { title, meetingMetadata, mediaRefs });
    onProgress?.({
      phase: i === windows.length - 1 ? 'done' : 'window_complete',
      windowIndex: i,
      totalWindows: windows.length,
      startMs: win.startMs,
      endMs: win.endMs,
      completedWindows: completed.length,
      partialBundle: partial.bundle,
      backend: lastBackend,
      model: lastModel,
    });
  }

  const finalResult = mergeWindowedGraphs(source, completed, { title, meetingMetadata, mediaRefs });
  return { ...finalResult, backend: lastBackend, model: lastModel, windowCount: windows.length };
}
