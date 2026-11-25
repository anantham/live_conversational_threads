// Test Intent: tests/intent/youtube-import.md. Pasted link -> transcript -> local archive; no provider call until asked.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ writes: [], restored: null, restoreGate: null }));
vi.mock('../services/cloud/localConversationStore.js', () => ({
  readLocalConversation: async () => { if (fixture.restoreGate) await fixture.restoreGate; return fixture.restored; },
  saveLocalConversation: async (snapshot, chunks) => { fixture.writes.push({ snapshot, chunks }); return 'revision-' + fixture.writes.length; },
}));
vi.mock('../components/MinimalGraph.jsx', () => ({ default: () => <div aria-label="Rendered graph" /> }));
import SitesYouTubeImport from './SitesYouTubeImport.jsx';
import { createRecordingThreads } from '../services/cloud/recordingThreads.js';

const VIDEO = 'kvL2PFa2fyM', OTHER = '6HmR9IaqM88', LIST = 'PLGtOBavor_HPxWL2SMqaOczXLRZq0Ru7y';
let root, container, calls, posts, resolveBody, transcriptBody, transcriptStatus, networkDown;
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const cues = [{ start_ms: 0, end_ms: 3000, text: 'Gardens need water.' }, { start_ms: 3100, end_ms: 6000, text: 'So we plant early.' }];
const mapped = source => createRecordingThreads({ ...source, graph: { metadata: { conversation_title: 'Garden plan' },
  nodes: [{ id: 'garden-moment', semantic_level: 1, semantic_type: 'chunk', node_name: 'Garden watering',
    source_ref: { utterance_ids: ['utterance-0001'] }, source_excerpt: 'Gardens need water.' }], edges: [] } }).bundle;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  fixture.writes = []; fixture.restored = null; fixture.restoreGate = null; calls = []; posts = []; localStorage.clear();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = () => 'blob:synthetic-import'; static revokeObjectURL() {} });
  transcriptStatus = 200; networkDown = false;
  transcriptBody = id => ({ video: { id, title: 'A synthetic podcast', length_seconds: 6 }, caption: { language: 'en', kind: 'auto' }, cues });
  resolveBody = () => response({ kind: 'video', playlist_id: null, title: 'A synthetic podcast', videos: [{ id: VIDEO, title: 'A synthetic podcast', duration_seconds: null }], truncated: false, selected_video_id: VIDEO });
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    calls.push({ url, headers: options?.headers });
    if (networkDown && url.startsWith('/api/cloud/youtube/')) throw new TypeError('network down');
    if (url.startsWith('/api/cloud/youtube/resolve')) return resolveBody(new URL(url, 'https://site.example').searchParams.get('url'));
    if (url.startsWith('/api/cloud/youtube/transcript')) {
      const id = new URL(url, 'https://site.example').searchParams.get('v');
      return transcriptStatus === 200 ? response(transcriptBody(id)) : response({ error: 'no_captions', message: 'This video has no captions, so there is no transcript to import.' }, transcriptStatus);
    }
    if (url === '/api/auth/session') return response({ authenticated: false }, 401);
    if (url === '/api/cloud/files/status') return response({ enabled: false, configured: false });
    const backend = url.includes('/gemini/') ? 'gemini' : 'openrouter';
    if (url.endsWith('/status')) return response({ backend, enabled: true, available: true, configured: true, schema_ready: true, audience: 'public', model: 'm', provider: 'p' });
    if (url.endsWith('/generate')) { const source = JSON.parse(options.body).source; posts.push(source); return response({ request_id: '00000000-0000-4000-8000-000000000001', artifact: mapped(source) }); }
    throw new Error('Unexpected network destination ' + url);
  }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root?.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const button = name => [...container.querySelectorAll('button')].find(value => (value.getAttribute('aria-label') || value.textContent) === name);
const click = async name => { await act(async () => button(name).click()); };
const mount = async (path = '/import-youtube') => act(async () => root.render(<MemoryRouter initialEntries={[path]}><SitesYouTubeImport /></MemoryRouter>));
async function paste(link) {
  const input = container.querySelector('#youtube-link');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, link);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Find transcript');
}
const flush = async () => act(async () => new Promise(resolve => setTimeout(resolve, 250)));
const youtubeCalls = () => calls.filter(call => call.url.startsWith('/api/cloud/youtube'));

describe('YouTube import page', () => {
  it('turns a pasted video link into a transcript, saved on this device, with nothing sent to an AI provider', async () => {
    await mount(); await paste(`https://www.youtube.com/watch?v=${VIDEO}`); await flush();
    expect(youtubeCalls().map(call => call.url.split('?')[0])).toEqual(['/api/cloud/youtube/resolve', '/api/cloud/youtube/transcript']);
    expect(youtubeCalls().every(call => call.headers['x-lct-youtube-import'] === 'v1')).toBe(true);
    expect(container.textContent).toContain('Gardens need water. So we plant early.');
    expect(container.textContent).toContain('automatic captions');
    expect(posts).toHaveLength(0);
    expect(calls.some(call => call.url.endsWith('/generate'))).toBe(false);
    const saved = fixture.writes.at(-1).snapshot;
    expect(saved.recording).toMatchObject({ source: 'youtube-import', retention: 'local', youtube: { video_id: VIDEO, caption_kind: 'auto' } });
    expect(saved.transcript.finalTokens).toEqual([{ text: 'Gardens need water.', startMs: 0, endMs: 3000 }, { text: ' So we plant early.', startMs: 3100, endMs: 6000 }]);
    expect(saved.stage).toBe('stopped');
  });

  it('refuses a link that is not YouTube without calling the Site', async () => {
    await mount(); await paste('https://example.com/watch?v=' + VIDEO);
    expect(container.querySelector('[role=alert]').textContent).toContain('Only youtube.com and youtu.be links can be imported.');
    expect(youtubeCalls()).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });

  it('lists a playlist, marks the video the link pointed at, and imports only the one chosen', async () => {
    resolveBody = () => response({ kind: 'playlist', playlist_id: LIST, title: 'Podcast', truncated: false, selected_video_id: OTHER,
      videos: [{ id: VIDEO, title: 'First episode', duration_seconds: 6448 }, { id: OTHER, title: 'Second episode', duration_seconds: 1201 }] });
    await mount(); await paste(`https://www.youtube.com/watch?v=${OTHER}&list=${LIST}`); await flush();
    expect(container.textContent).toContain('Podcast · 2 videos');
    expect(container.textContent).toContain('1:47:28'); expect(container.textContent).toContain('20:01');
    expect(container.textContent).toContain('the video you linked');
    expect(youtubeCalls().map(call => call.url.split('?')[0])).toEqual(['/api/cloud/youtube/resolve']);
    await act(async () => container.querySelectorAll('ul button')[1].click()); await flush();
    expect(youtubeCalls().at(-1).url).toBe('/api/cloud/youtube/transcript?v=' + OTHER);
    expect(youtubeCalls()).toHaveLength(2);
    expect(fixture.writes.at(-1).snapshot.recording.youtube.video_id).toBe(OTHER);
  });

  it('shows the Site\'s plain reason when a video cannot be imported and saves nothing', async () => {
    transcriptStatus = 404;
    await mount(); await paste(`https://youtu.be/${VIDEO}`); await flush();
    expect(container.querySelector('[role=alert]').textContent).toContain('no captions');
    expect(fixture.writes).toEqual([]);
    expect(container.querySelector('#youtube-link')).not.toBeNull(); // the form stays so the user can try another link
  });

  it('shows a plain message when the Site cannot be reached', async () => {
    networkDown = true;
    await mount(); await paste(`https://youtu.be/${VIDEO}`); await flush();
    expect(container.querySelector('[role=alert]').textContent).toContain('could not reach the Site');
  });

  it('sends the imported words, with their timing, to map generation only when the user asks and consents', async () => {
    await mount(); await paste(`https://youtu.be/${VIDEO}`); await flush();
    await click('AI map');
    const consent = [...container.querySelectorAll('aside input[type=checkbox]')].find(box => !box.getAttribute('aria-label'));
    await act(async () => consent.click());
    await click('Generate conversation map'); await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0].finalTokens.map(token => token.text).join('')).toBe('Gardens need water. So we plant early.');
    expect(posts[0].finalTokens[1]).toMatchObject({ startMs: 3100, endMs: 6000 });
    expect(posts[0].recordingId).toBe(fixture.writes.at(-1).snapshot.recording.id);
  });

  it('warns that threads are untested beyond about 20 minutes, but still offers the full transcript', async () => {
    transcriptBody = id => ({ video: { id, title: 'A very long show', length_seconds: 6448 }, caption: { language: 'en', kind: 'manual' }, cues });
    await mount(); await paste(`https://youtu.be/${VIDEO}`); await flush();
    expect(container.querySelector('[role=note]').textContent).toContain('longer than about 20 minutes');
    expect(container.textContent).toContain('Transcript imported from the video');
    expect(container.textContent).not.toContain('automatic captions');
  });

  it('does not warn for a short video', async () => {
    await mount(); await paste(`https://youtu.be/${VIDEO}`); await flush();
    expect(container.querySelector('[role=note]')).toBeNull();
  });

  it('says so, and saves nothing, when the Site returns a video entry with no usable id', async () => {
    resolveBody = () => response({ kind: 'video', playlist_id: null, title: null, videos: [], truncated: false, selected_video_id: null });
    await mount(); await paste(`https://youtu.be/${VIDEO}`); await flush();
    expect(container.querySelector('[role=alert]').textContent).toContain('no valid id');
    expect(fixture.writes).toEqual([]);
  });

  it('does not let a slow saved import overwrite an import the user has already made', async () => {
    const id = '00000000-0000-4000-8000-000000000004';
    fixture.restored = { id, recording: { id, startedAt: 1000, transcribe: true, retention: 'local', source: 'youtube-import', youtube: { video_id: OTHER, title: 'Old' } },
      title: 'Old', stage: 'stopped', updatedAt: 1000, map: null, segments: [],
      transcript: { finalText: 'Old saved words.', partialText: '', partialTokens: [], finalTokens: [{ text: 'Old saved words.', startMs: 0, endMs: 1000 }] } };
    let release; fixture.restoreGate = new Promise(resolve => { release = resolve; });
    await mount('/import-youtube?local=' + id);
    await paste(`https://youtu.be/${VIDEO}`); await flush();
    expect(container.textContent).toContain('Gardens need water.');
    release(); await flush();
    expect(container.textContent).toContain('Gardens need water.');
    expect(container.textContent).not.toContain('Old saved words.');
  });

  it('reopens a saved import from this device without calling YouTube', async () => {
    const id = '00000000-0000-4000-8000-000000000003';
    const tokens = [{ text: 'Saved words.', startMs: 0, endMs: 1000 }];
    fixture.restored = { id, recording: { id, startedAt: 1000, transcribe: true, retention: 'local', source: 'youtube-import', youtube: { video_id: VIDEO, title: 'Saved show', length_seconds: 60 } },
      title: 'Saved', stage: 'stopped', updatedAt: 1000, map: null, segments: [],
      transcript: { finalText: 'Saved words.', partialText: '', partialTokens: [], finalTokens: tokens } };
    await mount('/import-youtube?local=' + id); await flush();
    expect(container.textContent).toContain('Saved words.');
    expect(container.textContent).toContain('Opened from this device.');
    expect(youtubeCalls()).toEqual([]);
  });
});
