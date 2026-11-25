// Test intent: lct_app/tests/intent/map-audit.md
import { createRecordingTranscript } from './recordingTranscript.js';
import { auditRecordingMap } from './openRouterClient.js';
import { planSegments, segmentSource } from './glanceDetailPipeline.js';

export const DEFAULT_AUDIT_SEGMENTS = 4;

/** The model family behind a route: the company whose model answers, not the client or router. */
export function modelFamily(route) {
  if (!route) return null;
  if (route.backend === 'anthropic') return 'anthropic';
  if (route.backend === 'gemini') return 'google';
  // A meta-router (openrouter/auto) can answer with any family, so its family is unknown.
  const vendor = String(route.model || '').split('/')[0].toLowerCase();
  return !vendor || vendor === 'openrouter' || !String(route.model).includes('/') ? UNKNOWN : vendor;
}
const UNKNOWN = 'unknown';

/**
 * First configured route whose family differs from every family that wrote any part of the map
 * (glance and every detail call, including fallbacks), or null. Unknown families never qualify.
 */
export function chooseAuditRoute(routes, builders) {
  const built = new Set((Array.isArray(builders) ? builders : [builders]).filter(Boolean).map(modelFamily));
  if (!built.size || built.has(UNKNOWN)) return null;
  return routes.find(route => { const family = modelFamily(route); return family !== UNKNOWN && !built.has(family); }) || null;
}

/** Spans to audit: uncovered turns first, then core topics (all topics for maps without salience). */
export function planAuditSpans(bundle, { maxSegments = DEFAULT_AUDIT_SEGMENTS } = {}) {
  const utteranceById = new Map(bundle.utterances.map(u => [u.id, u]));
  const topics = bundle.graph_data.filter(n => n.semantic_level === 3);
  const gaps = topics.filter(n => n.generated_gap);
  const core = topics.filter(n => n.salience === 'core');
  const chosen = new Set([...gaps, ...(core.length ? core : topics)].map(n => n.id));
  return planSegments(bundle, utteranceById, { topicIds: chosen }).slice(0, maxSegments);
}

/** Map nodes whose evidence touches a segment, with their evidence as local ranges. */
export function auditNodesFor(bundle, segment) {
  const local = new Map(segment.utteranceIds.map((id, i) => [id, i]));
  return bundle.graph_data.flatMap(node => {
    const positions = node.source_ref.utterance_ids.map(id => local.get(id)).filter(i => i !== undefined).sort((a, b) => a - b);
    if (!positions.length || node.generated_gap) return [];
    const ranges = [];
    for (const p of positions) {
      if (ranges.length && ranges.at(-1)[1] === p - 1) ranges.at(-1)[1] = p; else ranges.push([p, p]);
    }
    return [{ id: node.id, semantic_level: node.semantic_level, node_name: node.node_name, summary: node.summary || '',
      ranges: ranges.map(([a, b]) => ({ from: `utterance-${String(a + 1).padStart(4, '0')}`, to: `utterance-${String(b + 1).padStart(4, '0')}` })) }];
  });
}

const signalId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

/**
 * Audit the planned spans with one route and append every finding to audit_signals with its evidence
 * and a pending decision. Represented points are kept too: they are the recall denominator.
 */
export async function runMapAudit({ source, bundle, route, segments = planAuditSpans(bundle), signal, onProgress,
  request = auditRecordingMap, intervalMs = 10_500 }) {
  const utteranceById = new Map(createRecordingTranscript(source).document.utterances.map(u => [u.id, u]));
  const signals = [...(bundle.audit_signals || [])];
  const run = signalId();
  for (const [i, segment] of segments.entries()) {
    if (i > 0) await sleep(intervalMs, signal);
    onProgress?.({ phase: 'audit', segmentIndex: i, totalSegments: segments.length });
    const segmentSrc = segmentSource(source, segment, utteranceById);
    if (createRecordingTranscript(segmentSrc).document.utterances.length !== segment.utteranceIds.length) {
      throw new Error(`Audit span ${segment.label} did not keep one utterance per turn; it was not sent.`);
    }
    const result = await request(segmentSrc, signal, route, auditNodesFor(bundle, segment));
    const toGlobal = new Map(segment.utteranceIds.map((id, k) => [`utterance-${String(k + 1).padStart(4, '0')}`, id]));
    for (const finding of result.findings) {
      signals.push({ id: signalId(), source: 'audit', run, provider: result.backend, model: result.model, segment: segment.label,
        ...finding, ...(finding.utterance_ids ? { utterance_ids: finding.utterance_ids.map(id => toGlobal.get(id)).filter(Boolean) } : {}),
        decision: finding.kind === 'represented' ? 'not_needed' : 'pending' });
    }
    try { console.info('[lct-pipeline] audit segment done', { segment: segment.label, findings: result.findings.length,
      dropped: result.droppedRanges, unknownNodes: result.unknownNodes, model: result.model }); } catch { /* never changes the result */ }
  }
  onProgress?.({ phase: 'audit_done', totalSegments: segments.length });
  return { ...bundle, audit_signals: signals };
}

/** Record the owner's accept/dismiss decision on one finding. */
export function decideSignal(bundle, id, decision) {
  if (!['accepted', 'dismissed', 'pending'].includes(decision)) throw new Error('Unknown decision.');
  return { ...bundle, audit_signals: (bundle.audit_signals || []).map(s => (s.id === id ? { ...s, decision, decided_at: new Date().toISOString() } : s)) };
}

/** The owner flags a node as irrelevant or misfiled (a labelled false positive). */
export function recordUserFlag(bundle, nodeId, kind) {
  if (!['irrelevant', 'misfiled'].includes(kind)) throw new Error('Unknown flag.');
  if (!bundle.graph_data.some(n => n.id === nodeId)) throw new Error('That node is not in this map.');
  return { ...bundle, audit_signals: [...(bundle.audit_signals || []), { id: signalId(), source: 'user', kind, node_id: nodeId,
    decision: 'accepted', decided_at: new Date().toISOString() }] };
}

/** Counts that turn findings into a measurable record: recall and decision rates per kind. */
export function auditSummary(bundle) {
  const audit = (bundle.audit_signals || []).filter(s => s.source === 'audit');
  const points = audit.filter(s => ['represented', 'missed'].includes(s.kind));
  const decided = audit.filter(s => ['accepted', 'dismissed'].includes(s.decision));
  return { points: points.length, represented: points.filter(s => s.kind === 'represented').length,
    missed: points.filter(s => s.kind === 'missed').length,
    contradictions: audit.filter(s => s.kind === 'contradiction').length,
    entitySplits: audit.filter(s => s.kind === 'entity_split').length,
    accepted: decided.filter(s => s.decision === 'accepted').length, dismissed: decided.filter(s => s.decision === 'dismissed').length,
    pending: audit.filter(s => s.decision === 'pending').length,
    userFlags: (bundle.audit_signals || []).filter(s => s.source === 'user').length };
}
