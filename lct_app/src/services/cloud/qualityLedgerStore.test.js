// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearQualityLedger,
  readQualityLedger,
  recordQualitySnapshot,
  summarizeQualityLedger,
} from './qualityLedgerStore.js';

describe('qualityLedgerStore', () => {
  beforeEach(() => {
    clearQualityLedger();
  });

  it('records and upserts content-free quality snapshots across calls', () => {
    recordQualitySnapshot({
      conversation_id: 'call-1',
      conversation_title: 'Andre Catch up',
      graph_data: [{ id: '1' }, { id: '2' }],
      coverage: { covered_turns: 80, total_turns: 100 },
      built_by: [{ backend: 'anthropic', model: 'claude-sonnet-5-5' }],
      audit_signals: [
        { id: 'a1', source: 'audit', kind: 'represented', decision: 'not_needed' },
        { id: 'a2', source: 'audit', kind: 'missed', decision: 'pending' },
        { id: 'a3', source: 'audit', kind: 'contradiction', decision: 'pending' },
        { id: 'u1', source: 'user', kind: 'misfiled', decision: 'accepted' },
      ],
      boundary_corrections: [{ id: 'bc-1', kind: 'merge' }],
      reaction_markers: [{ id: 'rx-1', kind: 'energized' }],
    });

    // Upsert same conversation with improved recall and a second flag
    recordQualitySnapshot({
      conversation_id: 'call-1',
      conversation_title: 'Andre Catch up',
      graph_data: [{ id: '1' }, { id: '2' }],
      audit_signals: [
        { id: 'a1', source: 'audit', kind: 'represented', decision: 'not_needed' },
        { id: 'a2', source: 'audit', kind: 'represented', decision: 'not_needed' },
        { id: 'u1', source: 'user', kind: 'misfiled', decision: 'accepted' },
        { id: 'u2', source: 'user', kind: 'irrelevant', decision: 'accepted' },
      ],
      boundary_corrections: [{ id: 'bc-1', kind: 'merge' }, { id: 'bc-2', kind: 'split' }],
    });

    const rows = readQualityLedger();
    expect(rows).toHaveLength(1);
    const summary = summarizeQualityLedger(rows);
    expect(summary).toMatchObject({
      callsTracked: 1,
      avgRecallPct: 100,
      totalContradictions: 0,
      totalUserFlags: 2,
      totalBoundaryCorrections: 2,
    });
  });
});
