// Test intent:
// - Each background pass replaces only the field it owns, and keeps every other field of the latest map.
// - A claim check for a claim that is no longer in the map returns null, so the caller can say so.
import { describe, expect, it } from 'vitest';
import { withAuditSignals, withClaimEvidence, withEpistemic } from './bundleFieldMerge.js';

const latest = {
  conversation_id: 'map-1',
  reaction_markers: [{ id: 'rx-1' }],
  audit_signals: [{ id: 's1' }],
  epistemic: { cruxes: [], normative_assumptions: [], factual_claims: [{ id: 'c1', note: 'One.' }, { id: 2, note: 'Two.' }] },
};

describe('bundleFieldMerge', () => {
  it('replaces only the epistemic field', () => {
    const lenses = { cruxes: [{ id: 'x' }], normative_assumptions: [], factual_claims: [] };
    expect(withEpistemic(latest, lenses)).toEqual({ ...latest, epistemic: lenses });
    expect(withEpistemic(null, lenses)).toBeNull();
  });

  it('replaces only the audit signals', () => {
    expect(withAuditSignals(latest, [{ id: 's2' }])).toEqual({ ...latest, audit_signals: [{ id: 's2' }] });
    expect(withAuditSignals(latest, undefined).audit_signals).toEqual([]);
  });

  it('attaches evidence to one claim, matching numeric and string ids, and keeps the rest', () => {
    const evidence = { status: 'supported' };
    const updated = withClaimEvidence(latest, '2', evidence);
    expect(updated.epistemic.factual_claims).toEqual([{ id: 'c1', note: 'One.' }, { id: 2, note: 'Two.', external_evidence: evidence }]);
    expect(updated.reaction_markers).toBe(latest.reaction_markers);
    expect(updated.audit_signals).toBe(latest.audit_signals);
  });

  it('returns null when the claims were re-analysed since the check started', () => {
    const analysed = { ...latest, epistemic: { ...latest.epistemic, analyzed_at: '2026-11-27T01:00:00Z' } };
    expect(withClaimEvidence(analysed, 'c1', {}, { analyzedAt: '2026-11-27T01:00:00Z' })).not.toBeNull();
    expect(withClaimEvidence(analysed, 'c1', {}, { analyzedAt: '2026-11-26T09:00:00Z' })).toBeNull();
  });

  it('returns null when the claim is gone', () => {
    expect(withClaimEvidence(latest, 'c9', {})).toBeNull();
    expect(withClaimEvidence({ conversation_id: 'map-1' }, 'c1', {})).toBeNull();
    expect(withClaimEvidence(null, 'c1', {})).toBeNull();
  });
});
