// @vitest-environment node
// Test intent: tests/intent/youtube-import.md. YouTube is a stubbed fetch; no network, no keys, no spend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../../sites/worker.js';
import { extractPlaylistPage } from '../../../sites/youtubeImport.js';

const SITE = 'https://fixture-youtube.example.chatgpt.site';
const VIDEO = 'kvL2PFa2fyM', OTHER = '6HmR9IaqM88', THIRD = 'F9egy3kz8-g', LIST = 'PLGtOBavor_HPxWL2SMqaOczXLRZq0Ru7y';
const CAPTIONS = '<timedtext format="3"><body><p t="0" d="3000"><s>hello</s><s t="500"> world</s></p><p t="3100" d="2000"><s>second</s> <s>line</s></p></body></timedtext>';
const get = (path, { headers = { 'x-lct-youtube-import': 'v1' }, signal, method = 'GET' } = {}) => new Request(SITE + '/api/cloud/youtube' + path, { method, headers, signal });
const transcriptUrl = id => `/transcript?v=${id}`;
const resolveUrl = link => `/resolve?url=${encodeURIComponent(link)}`;
const player = (over = {}) => ({ playabilityStatus: { status: 'OK' }, videoDetails: { title: 'A synthetic podcast', lengthSeconds: '6448' },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=' + VIDEO + '&caps=asr&fmt=srv3' }] } }, ...over });
const lockup = (id, title, badge) => ({ lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
  metadata: { lockupMetadataViewModel: { title: { content: title } } },
  contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: badge } }] } }] } } } });
const page = (items, token) => ({ metadata: { playlistMetadataRenderer: { title: 'Podcast' } },
  contents: { items, ...(token ? { more: { continuationCommand: { token } } } : {}) } });
let env, calls, routes;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  env = { LCT_OPENROUTER_AUDIENCE: 'public' }; calls = [];
  routes = {
    player: () => json(player()), timedtext: () => new Response(CAPTIONS, { status: 200 }),
    oembed: () => json({ title: 'A synthetic podcast' }),
    browse: body => body.continuation ? json(page([lockup(THIRD, 'Third', '5:00')])) : json(page([lockup(VIDEO, 'First', '1:47:28'), lockup(OTHER, 'Second', '20:01')], 'next-page')),
  };
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const target = new URL(url);
    calls.push({ url: target.href, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const key = target.pathname.includes('/player') ? 'player' : target.pathname.includes('/browse') ? 'browse'
      : target.pathname.includes('timedtext') ? 'timedtext' : target.pathname.includes('oembed') ? 'oembed' : 'unknown';
    return routes[key](init.body ? JSON.parse(init.body) : null, target);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const body = async response => response.json();

describe('access', () => {
  it('refuses a request that does not carry the Site header, before any upstream call', async () => {
    const response = await worker.fetch(get(transcriptUrl(VIDEO), { headers: {} }), env);
    expect(response.status).toBe(403);
    expect((await body(response)).error).toBe('consent');
    expect(calls).toEqual([]);
  });
  it('requires sign-in unless the Site is configured public, and calls nothing when it refuses', async () => {
    for (const unconfigured of [{}, { LCT_OPENROUTER_AUDIENCE: 'authenticated' }]) {
      const response = await worker.fetch(get(transcriptUrl(VIDEO)), unconfigured);
      expect(response.status).toBe(401);
      expect((await body(response)).error).toBe('sign_in');
    }
    expect(calls).toEqual([]);
  });
  it('accepts a signed-in visitor on a non-public Site', async () => {
    const request = get(transcriptUrl(VIDEO)); request.headers.set('oai-authenticated-user-id', 'synthetic-user');
    expect((await worker.fetch(request, { LCT_OPENROUTER_AUDIENCE: 'authenticated' })).status).toBe(200);
  });
  it('answers only GET, and leaves other paths alone', async () => {
    expect((await worker.fetch(get(transcriptUrl(VIDEO), { method: 'POST', headers: { 'x-lct-youtube-import': 'v1' } }), env)).status).toBe(405);
    const other = await worker.fetch(new Request(SITE + '/api/cloud/youtube/elsewhere', { headers: { 'x-lct-youtube-import': 'v1' } }), env);
    expect(other.status).toBe(404); // falls through to the backend-unavailable answer, not a YouTube one
    expect(calls).toEqual([]);
  });
});

describe('transcript', () => {
  it('returns timed cues, the title, length and which caption track was used', async () => {
    const response = await worker.fetch(get(transcriptUrl(VIDEO)), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await body(response)).toEqual({
      video: { id: VIDEO, title: 'A synthetic podcast', length_seconds: 6448 }, caption: { language: 'en', kind: 'auto' },
      cues: [{ start_ms: 0, end_ms: 3000, text: 'hello world' }, { start_ms: 3100, end_ms: 5100, text: 'second line' }] });
  });
  it('talks only to youtube.com, with the validated id, and never forwards the visitor\'s headers', async () => {
    const request = get(transcriptUrl(VIDEO)); request.headers.set('cookie', 'session=secret'); request.headers.set('authorization', 'Bearer secret');
    await worker.fetch(request, env);
    expect(calls.map(call => new URL(call.url).origin)).toEqual(['https://www.youtube.com', 'https://www.youtube.com']);
    expect(calls[0].body.videoId).toBe(VIDEO);
    expect(calls[1].url).toContain('/api/timedtext');
    expect(calls[1].url).not.toContain('fmt=');
    const sent = JSON.stringify(vi.mocked(fetch).mock.calls);
    expect(sent).not.toContain('secret');
  });
  it('rejects a malformed video id without calling YouTube', async () => {
    for (const id of ['short', 'a'.repeat(12), '../../etc/passwd', 'kvL2PFa2fy!', '']) {
      const response = await worker.fetch(get(transcriptUrl(id)), env);
      expect(response.status, id).toBe(400);
    }
    expect(calls).toEqual([]);
  });
  it('never fetches a caption address that is not a youtube.com timedtext address', async () => {
    for (const baseUrl of ['https://evil.example/api/timedtext?v=x', 'https://www.youtube.com.evil.example/api/timedtext', 'https://www.youtube.com/other/path', 'http://www.youtube.com/api/timedtext', 'not a url']) {
      routes.player = () => json(player({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', baseUrl }] } } }));
      calls.length = 0;
      const response = await worker.fetch(get(transcriptUrl(VIDEO)), env);
      expect(response.status, baseUrl).toBe(502);
      expect(calls.filter(call => !call.url.includes('/youtubei/v1/player')), baseUrl).toEqual([]);
    }
  });
  it.each([
    ['private or blocked', { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'secret upstream reason' } }, 502, 'youtube_blocked'],
    ['removed', { playabilityStatus: { status: 'ERROR', reason: 'secret upstream reason' } }, 404, 'unavailable'],
    ['no captions', { captions: undefined }, 404, 'no_captions'],
    ['live', { videoDetails: { isLive: true, title: 'x' } }, 422, 'live'],
  ])('says plainly when a video is %s', async (_label, over, status, code) => {
    routes.player = () => json(player(over));
    const response = await worker.fetch(get(transcriptUrl(VIDEO)), env);
    expect(response.status).toBe(status);
    const result = await body(response);
    expect(result.error).toBe(code);
    expect(JSON.stringify(result)).not.toContain('secret upstream reason');
  });
  it('reports an upstream failure without relaying upstream text', async () => {
    routes.player = () => new Response('internal detail: token=abc123', { status: 500 });
    const response = await worker.fetch(get(transcriptUrl(VIDEO)), env);
    expect(response.status).toBe(502);
    expect(JSON.stringify(await body(response))).not.toContain('abc123');
  });
  it('refuses captions larger than the import accepts', async () => {
    routes.timedtext = () => new Response('x', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } });
    expect((await worker.fetch(get(transcriptUrl(VIDEO)), env)).status).toBe(413);
    routes.timedtext = () => new Response('x'.repeat(4 * 1024 * 1024 + 1), { status: 200 });
    expect((await worker.fetch(get(transcriptUrl(VIDEO)), env)).status).toBe(413);
  });
  it('fails loudly on empty captions rather than returning an empty transcript', async () => {
    routes.timedtext = () => new Response('<timedtext><body><p t="0" d="1">\n</p></body></timedtext>', { status: 200 });
    const response = await worker.fetch(get(transcriptUrl(VIDEO)), env);
    expect(response.status).toBe(502);
    expect((await body(response)).error).toBe('captions_empty');
  });
  it('does not follow a redirect from YouTube', async () => {
    routes.timedtext = () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    expect((await worker.fetch(get(transcriptUrl(VIDEO)), env)).status).toBe(502);
    expect(calls.some(call => call.url.includes('evil.example'))).toBe(false);
  });
});

describe('resolve', () => {
  it('names a single video and refuses a bad link without calling YouTube', async () => {
    const ok = await worker.fetch(get(resolveUrl(`https://youtu.be/${VIDEO}`)), env);
    expect(await body(ok)).toEqual({ kind: 'video', playlist_id: null, title: 'A synthetic podcast',
      videos: [{ id: VIDEO, title: 'A synthetic podcast', duration_seconds: null }], truncated: false, selected_video_id: VIDEO });
    calls.length = 0;
    for (const link of ['', 'https://example.com/x', 'https://www.youtube.com/playlist?list=RDabcdefghijklmnop']) {
      expect((await worker.fetch(get(resolveUrl(link)), env)).status, link).toBe(400);
    }
    expect(calls).toEqual([]);
  });
  it('says a private or removed single video is unavailable', async () => {
    routes.oembed = () => new Response('nope', { status: 401 });
    const response = await worker.fetch(get(resolveUrl(`https://youtu.be/${VIDEO}`)), env);
    expect(response.status).toBe(404);
  });
  it('lists a playlist across pages, once each, with durations, title and the linked video', async () => {
    const response = await worker.fetch(get(resolveUrl(`https://www.youtube.com/watch?v=${OTHER}&list=${LIST}`)), env);
    expect(await body(response)).toEqual({ kind: 'playlist', playlist_id: LIST, title: 'Podcast', truncated: false, selected_video_id: OTHER,
      videos: [{ id: VIDEO, title: 'First', duration_seconds: 6448 }, { id: OTHER, title: 'Second', duration_seconds: 1201 }, { id: THIRD, title: 'Third', duration_seconds: 300 }] });
    expect(calls.map(call => call.body?.browseId || call.body?.continuation)).toEqual(['VL' + LIST, 'next-page']);
  });
  it('stops at the page limit and says the list was cut short', async () => {
    let page_n = 0;
    routes.browse = () => json(page([lockup(`${String(page_n).padStart(2, '0')}abcdefghi`.slice(0, 11), 'v' + page_n, '1:00')], 'again' + (page_n += 1)));
    const result = await body(await worker.fetch(get(resolveUrl(`https://www.youtube.com/playlist?list=${LIST}`)), env));
    expect(result.truncated).toBe(true);
    expect(result.videos).toHaveLength(4);
    expect(calls).toHaveLength(4);
  });
  it('says a private, empty or missing playlist is unavailable', async () => {
    routes.browse = () => json(page([]));
    const response = await worker.fetch(get(resolveUrl(`https://www.youtube.com/playlist?list=${LIST}`)), env);
    expect(response.status).toBe(404);
    expect((await body(response)).error).toBe('unavailable');
  });
});

describe('extractPlaylistPage', () => {
  it('reads the older renderer, skips unplayable entries, and ignores non-video lockups', () => {
    const found = extractPlaylistPage({ a: [{ playlistVideoRenderer: { videoId: VIDEO, title: { runs: [{ text: 'Old ' }, { text: 'style' }] }, lengthSeconds: '90' } },
      { playlistVideoRenderer: { videoId: OTHER, isPlayable: false, title: { simpleText: 'Hidden' } } },
      { lockupViewModel: { contentId: THIRD, contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST' } },
      { lockupViewModel: { contentId: 'not-an-id', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO' } }] });
    expect(found.videos).toEqual([{ id: VIDEO, title: 'Old style', duration_seconds: 90 }]);
    expect(found.continuation).toBeNull();
  });
  it('survives a hostile deeply nested response without recursing without bound', () => {
    let deep = { lockupViewModel: { contentId: VIDEO, contentType: 'VIDEO' } };
    for (let index = 0; index < 100_000; index += 1) deep = { x: deep };
    expect(() => extractPlaylistPage(deep)).not.toThrow();
  });
});
