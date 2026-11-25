// Test intent:
// - Stores content-free per-call quality metrics (audit recall, contradictions, user flags,
//   boundary corrections, reactions) locally in localStorage, upserting by conversationId.
// - Never stores transcript text, quotes, or API keys.

import { auditSummary } from './mapAudit.js';

const STORAGE_KEY = 'lct_quality_ledger_v1';
const MAX_ENTRIES = 100;

export function readQualityLedger() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function clearQualityLedger() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
  } catch { /* Safe no-op. */ }
}

/** Upsert a content-free quality snapshot for one conversation map. */
export function recordQualitySnapshot(bundle) {
  if (!bundle || typeof bundle !== 'object') return readQualityLedger();
  const summary = auditSummary(bundle);
  const conversationId = String(bundle.conversation_id || bundle.conversation_title || 'untitled').slice(0, 120);
  const cov = bundle.coverage;
  const coveragePct = cov?.total_turns ? Math.round((cov.covered_turns / cov.total_turns) * 100) : null;
  const recallPct = summary.points > 0 ? Math.round((summary.represented / summary.points) * 100) : null;
  const models = Array.isArray(bundle.built_by)
    ? [...new Set(bundle.built_by.map(b => b?.model).filter(Boolean))].slice(0, 4)
    : [];

  const row = {
    conversationId,
    title: String(bundle.conversation_title || conversationId).slice(0, 80),
    updatedAt: Date.now(),
    nodeCount: Array.isArray(bundle.graph_data) ? bundle.graph_data.length : 0,
    coveragePct,
    points: summary.points,
    represented: summary.represented,
    missed: summary.missed,
    recallPct,
    contradictions: summary.contradictions,
    entitySplits: summary.entitySplits,
    userFlags: summary.userFlags,
    boundaryCorrections: Array.isArray(bundle.boundary_corrections) ? bundle.boundary_corrections.length : 0,
    reactions: Array.isArray(bundle.reaction_markers) ? bundle.reaction_markers.length : 0,
    models,
  };

  const existing = readQualityLedger().filter(item => item.conversationId !== conversationId);
  const next = [row, ...existing].slice(0, MAX_ENTRIES);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch { /* Quota/private-mode safe. */ }
  return next;
}

export function summarizeQualityLedger(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const withRecall = list.filter(r => typeof r.recallPct === 'number');
  const avgRecallPct = withRecall.length
    ? Math.round(withRecall.reduce((sum, r) => sum + r.recallPct, 0) / withRecall.length)
    : null;
  return {
    callsTracked: list.length,
    avgRecallPct,
    totalContradictions: list.reduce((sum, r) => sum + (r.contradictions || 0), 0),
    totalUserFlags: list.reduce((sum, r) => sum + (r.userFlags || 0), 0),
    totalBoundaryCorrections: list.reduce((sum, r) => sum + (r.boundaryCorrections || 0), 0),
    totalReactions: list.reduce((sum, r) => sum + (r.reactions || 0), 0),
    rows: list,
  };
}
