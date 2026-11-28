// Test intent: lct_app/tests/intent/map-audit.md. All source is synthetic.
import { describe, expect, it, vi } from 'vitest';
import { auditFromGeneratedText } from './auditTask.js';
import { auditSummary, chooseAuditRoute, decideSignal, modelFamily, planAuditSpans, recordUserFlag, runMapAudit } from './mapAudit.js';
import { recordingThreadsFromGeneratedText } from './openRouterGeneration.js';

const texts = ['We will launch on the forum.', 'Agreed.', 'Actually, no: email instead.', 'Budget is ten thousand.'];
const source = { recordingId: 'synthetic-audit', startedAt: Date.UTC(2026, 10, 25), complete: true,
  finalTokens: texts.map((text, i) => ({ text: (i ? '\n' : '') + text, speaker: i % 2 ? 'B' : 'A', startMs: i * 1000, endMs: i * 1000 + 900 })) };
const u = n => `utterance-000${n}`;
const { bundle: base } = recordingThreadsFromGeneratedText(source, JSON.stringify({ hierarchy_format: 'skeleton-ranges-v1', glossary: [],
  metadata: { conversation_title: 'Launch', executive_summary: 'Channel and budget.' }, edges: [], conversation_threads: [],
  nodes: [{ id: 'channel', semantic_level: 3, semantic_type: 'topic', node_name: 'Launch channel', summary: 'They launch on the forum.', salience: 'core',
    source_ranges: [{ from: u(1), to: u(3) }], parent_id: null, secondary_parent_ids: [] },
  { id: 'budget', semantic_level: 3, semantic_type: 'topic', node_name: 'Budget', summary: 'Ten thousand.', salience: 'aside',
    source_ranges: [{ from: u(4), to: u(4) }], parent_id: null, secondary_parent_ids: [] }] }), { task: 'skeleton' });

describe('map audit', () => {
  it('picks an auditor from a different model family, or none', () => {
    const claude = { backend: 'anthropic', model: 'claude-x', key: 'k' };
    expect(modelFamily({ backend: 'openrouter', model: 'openai/gpt-x' })).toBe('openai');
    expect(chooseAuditRoute([claude, { backend: 'gemini', model: 'gemini-x', key: 'k' }], claude).backend).toBe('gemini');
    expect(chooseAuditRoute([claude, { backend: 'openrouter', model: 'anthropic/claude-y', key: 'k' }], claude)).toBeNull();
    // Review findings 9 and 10: every builder family is excluded, and a meta-router never qualifies.
    expect(chooseAuditRoute([claude, { backend: 'openrouter', model: 'openrouter/auto', key: 'k' }], claude)).toBeNull();
    const gemini = { backend: 'gemini', model: 'gemini-x', key: 'k' };
    expect(chooseAuditRoute([claude, gemini], [claude, { backend: 'gemini', model: 'gemini-x' }])).toBeNull();
    expect(chooseAuditRoute([claude, gemini, { backend: 'openrouter', model: 'openai/gpt-x', key: 'k' }], [claude, gemini]).model).toBe('openai/gpt-x');
  });

  it('audits core spans independently and records missed points, contradictions and decisions', async () => {
    const spans = planAuditSpans(base);
    expect(spans.map(s => s.utteranceIds)).toEqual([[u(1), u(2), u(3)]]);
    const request = vi.fn(async (segmentSrc, _signal, route, nodes) => {
      expect(nodes.map(n => [n.id, n.ranges])).toEqual([['3:channel', [{ from: u(1), to: u(3) }]]]);
      const reply = JSON.stringify({ format: 'audit-v1', entity_splits: [],
        independent_points: [
          { kind: 'decision', note: 'Launch on the forum.', range: { from: u(1), to: u(2) }, represented_by: '3:channel' },
          { kind: 'reversal', note: 'Switched to email.', range: { from: u(3), to: u(3) }, represented_by: null },
          { kind: 'claim', note: 'Invented credit.', range: { from: u(2), to: u(2) }, represented_by: '3:not-shown' }],
        contradictions: [{ node_id: '3:channel', note: 'Final channel was email, not the forum.', range: { from: u(3), to: u(3) } }] });
      const ids = segmentSrc.finalTokens.map((_, i) => u(i + 1));
      const parsed = auditFromGeneratedText(ids, reply, nodes.map(n => n.id));
      expect(parsed.unknownNodes).toBe(1);
      return { ...parsed, backend: route.backend, model: 'gemini-x' };
    });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const audited = await runMapAudit({ source, bundle: base, route: { backend: 'gemini', model: 'gemini-x' }, request, intervalMs: 0 });
    const kinds = audited.audit_signals.map(s => [s.kind, s.decision, s.utterance_ids]);
    expect(kinds).toEqual([
      ['represented', 'not_needed', [u(1), u(2)]], ['missed', 'pending', [u(3)]], ['missed', 'pending', [u(2)]],
      ['contradiction', 'pending', [u(3)]]]);
    const missed = audited.audit_signals.find(s => s.kind === 'missed');
    const decided = recordUserFlag(decideSignal(audited, missed.id, 'accepted'), '3:budget', 'irrelevant');
    expect(auditSummary(decided)).toMatchObject({ points: 3, represented: 1, missed: 2, contradictions: 1, accepted: 1, pending: 2, userFlags: 1 });
    expect(() => recordUserFlag(decided, '3:absent', 'irrelevant')).toThrow('not in this map');
  });

  // Lower-tier review: an uncovered stretch at the end of a long call must still be audited.
  it('audits uncovered turns first even when they come after the span limit', () => {
    const long = 'word '.repeat(2000).trim();
    const utterances = Array.from({ length: 7 }, (_, i) => ({ id: `t${i + 1}`, text: long }));
    const topic = (id, i, extra = {}) => ({ id: `3:${id}`, semantic_level: 3, node_name: id, salience: 'core',
      source_ref: { utterance_ids: [`t${i}`] }, ...extra });
    const bundle = { utterances, graph_data: [topic('a', 1), topic('b', 2), topic('c', 3), topic('d', 4), topic('e', 5), topic('f', 6),
      topic('gap', 7, { generated_gap: true, salience: undefined })] };
    const spans = planAuditSpans(bundle);
    expect(spans).toHaveLength(4);
    expect(spans.flatMap(s => s.utteranceIds)).toContain('t7');
    // Chosen spans stay in timeline order for the consent text.
    expect(spans.map(s => s.utteranceIds[0])).toEqual(['t1', 't2', 't3', 't7']);
  });

  // Review finding 3: a span only placeholders cover is still audited, with no nodes to credit.
  it('audits a span no node covers, so every point there is a miss', () => {
    const parsed = auditFromGeneratedText([u(1)], JSON.stringify({ format: 'audit-v1', contradictions: [], entity_splits: [],
      independent_points: [{ kind: 'decision', note: 'Ship Friday.', range: { from: u(1), to: u(1) }, represented_by: null }] }), []);
    expect(parsed.findings).toEqual([expect.objectContaining({ kind: 'missed', utterance_ids: [u(1)] })]);
  });
});
