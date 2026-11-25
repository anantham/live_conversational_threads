// @vitest-environment node
// Test intent: lct_app/tests/intent/publish-link.md. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { personalMetadataSummary, publicSafeCopy, publishBundle } from './publicThreads.js';

const bundle = { format: 'lct.threads', format_version: 2, conversation_title: 'Garden', graph_data: [], edges: [],
  utterances: [{ id: 'utterance-0001', text: 'Water at seven.', speaker_id: 'S1' }],
  media_refs: [{ provider: 'google_drive', view_url: 'https://drive.example/file' }],
  meeting_metadata: { source_format: 'pdf', meeting_date: '2026-11-16', duration_ms: 1000, invited_emails: ['a@example.com', 'b@example.com'],
    recording_url: 'https://drive.example/rec', transcript_doc_url: 'https://docs.example/doc', calendar_event_url: 'https://cal.example/e', reference_notes: { summary: 'Notes' } } };
let store;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) });
  vi.stubGlobal('window', { location: { origin: 'https://site.example' } });
});
afterEach(() => vi.unstubAllGlobals());

describe('publishing a map as a link', () => {
  it('leaves out emails, links and notes by default and reports what they would be', () => {
    const safe = publicSafeCopy(bundle);
    expect(safe.meeting_metadata).toEqual({ source_format: 'pdf', meeting_date: '2026-11-16', duration_ms: 1000 });
    expect(safe.media_refs).toBeUndefined();
    expect(JSON.stringify(safe)).not.toMatch(/@example\.com|drive\.example|docs\.example|cal\.example|Notes/);
    expect(safe.utterances).toEqual(bundle.utterances);
    expect(personalMetadataSummary(bundle)).toEqual({ emails: 2, links: 4, notes: true });
  });

  it('saves the removal key before sending, publishes unlisted and returns the link', async () => {
    const fetch = vi.fn(async (url, options) => {
      expect(store.get('lct.public_removal_keys.v1')).toContain(url.split('/').at(-1)); // key saved first
      expect(options.headers['X-LCT-Public-Visibility']).toBe('unlisted');
      expect(options.body).not.toContain('example.com');
      return new Response(JSON.stringify({ item: { id: url.split('/').at(-1), visibility: 'unlisted' } }), { status: 201 });
    });
    vi.stubGlobal('fetch', fetch);
    const result = await publishBundle(bundle);
    expect(result.url).toBe(`https://site.example/public/${result.capability.id}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('includes personal metadata only when asked', async () => {
    let sent;
    vi.stubGlobal('fetch', vi.fn(async (url, options) => { sent = options.body;
      return new Response(JSON.stringify({ item: { id: url.split('/').at(-1) } }), { status: 201 }); }));
    await publishBundle(bundle, { includePersonal: true });
    expect(sent).toContain('a@example.com');
  });
});
