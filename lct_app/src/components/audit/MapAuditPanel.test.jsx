// @vitest-environment jsdom
// Test intent: lct_app/tests/intent/map-audit.md. All source is synthetic.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line react/prop-types -- minimal router stub
vi.mock('react-router-dom', () => ({ Link: ({ children, to }) => <a href={to}>{children}</a> }));
import MapAuditPanel from './MapAuditPanel.jsx';
import { recordingThreadsFromGeneratedText } from '../../services/cloud/openRouterGeneration.js';
const source = { recordingId: 'synthetic-panel', startedAt: Date.UTC(2026, 10, 25), complete: true,
  finalTokens: ['Launch on the forum.', '\nNo, email.'].map((text, i) => ({ text, speaker: i ? 'B' : 'A', startMs: i * 60_000, endMs: i * 60_000 + 50_000 })) };
const { bundle } = recordingThreadsFromGeneratedText(source, JSON.stringify({ hierarchy_format: 'skeleton-ranges-v1', glossary: [],
  metadata: { conversation_title: 'Launch', executive_summary: 'Channel.' }, edges: [], conversation_threads: [],
  nodes: [{ id: 'channel', semantic_level: 3, semantic_type: 'topic', node_name: 'Channel', summary: 'the forum.', salience: 'core',
    source_ranges: [{ from: 'utterance-0001', to: 'utterance-0002' }], parent_id: null, secondary_parent_ids: [] }] }), { task: 'skeleton' });
const claude = { backend: 'anthropic', model: 'claude-x', key: 'k' };
const gemini = { backend: 'gemini', model: 'gemini-x', key: 'k' };
let root, host;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const view = props => act(() => root.render(<MapAuditPanel source={source} bundle={bundle} mapRoute={claude} onBundleChange={() => {}} {...props} />));
const buttonNamed = name => [...host.querySelectorAll('button')].find(b => b.textContent === name);

describe('MapAuditPanel', () => {
  it('asks for a different-family provider when only the builder family is configured', () => {
    view({ routes: [claude] });
    expect(host.textContent).toMatch(/Add a provider from a different model family/);
    expect(buttonNamed('Run audit')).toBeUndefined();
  });

  it('names the audit provider and the exact spans in its own consent before enabling the audit', () => {
    view({ routes: [claude, gemini] });
    const run = buttonNamed('Run audit');
    expect(run.disabled).toBe(true);
    const label = [...host.querySelectorAll('label')].find(l => /I have permission/.test(l.textContent));
    expect(label.textContent).toMatch(/send 2 transcript turns \(00:00:00–00:01:50\).*Gemini/);
    act(() => label.querySelector('input').click());
    expect(buttonNamed('Run audit').disabled).toBe(false);
  });

  it('records accept and dismiss decisions on pending findings', () => {
    const onBundleChange = vi.fn();
    const audited = { ...bundle, audit_signals: [{ id: 'f1', source: 'audit', kind: 'missed', point_kind: 'reversal',
      note: 'Switched to email.', utterance_ids: ['utterance-0002'], decision: 'pending' }] };
    view({ routes: [claude, gemini], bundle: audited, onBundleChange });
    act(() => buttonNamed('Accept').click());
    expect(onBundleChange.mock.calls[0][0].audit_signals[0].decision).toBe('accepted');
  });
});
