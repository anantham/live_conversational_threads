// @vitest-environment node
// Test intent: lct_app/tests/intent/publish-link.md. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetRemovalKey, personalMetadataSummary, publicSafeCopy, publishBundle, removalKeys, saveRemovalKey } from './publicThreads.js';

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
      return new Response(JSON.stringify({ item: { id: url.split('/').at(-1), visibility: 'unlisted' } }), { status: 201 }); }));
    await publishBundle(bundle, { includePersonal: true });
    expect(sent).toContain('a@example.com');
  });

  // Review: allowlist, not blocklist.
  it('drops any field the format does not define, not only the known personal ones', () => {
    const safe = publicSafeCopy({ ...bundle, participants: ['x@example.com'], owner: 'someone', source_url: 'https://private.example' });
    expect(Object.keys(safe)).not.toEqual(expect.arrayContaining(['participants']));
    expect(JSON.stringify(safe)).not.toMatch(/x@example|someone|private\.example/);
  });

  it('keeps the removal key and link reachable when the outcome is uncertain or unconfirmed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network dropped'); }));
    const lost = await publishBundle(bundle).catch(e => e);
    expect(lost).toMatchObject({ uncertain: true, url: expect.stringContaining('/public/') });
    expect(removalKeys().map(k => k.id)).toContain(lost.capability.id);
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify({ item: { id: url.split('/').at(-1), visibility: 'public' } }), { status: 201 })));
    const wrong = await publishBundle(bundle).catch(e => e);
    expect(wrong.message).toMatch(/did not confirm/);
    expect(wrong.capability).toBeDefined();
  });

  it('forgets a removal key once its copy is removed', () => {
    const capability = { id: '00000000-0000-4000-8000-000000000000', key: 'a'.repeat(64) };
    saveRemovalKey(capability);
    forgetRemovalKey(capability.id);
    expect(removalKeys()).toEqual([]);
  });
});

