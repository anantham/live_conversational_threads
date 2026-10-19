// @vitest-environment node
// Intent: tests/intent/sites-meetings.md. Actual in-memory SQLite, synthetic recorder only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../../sites/worker.js';

const SITE = 'https://fixture-meeting.example.chatgpt.site', PREFIX = '/api/cloud/meetings';
const ID = '12345678-1234-4123-8123-123456789abc', ID2 = '22345678-1234-4123-8123-123456789abc';
const BOT = 'bot_abcdefghijklmnop', KEY = 'a'.repeat(64);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const input = { requestId: ID, meetingUrl: 'https://meet.google.com/abc-defg-hij', consent: true };
const req = (path = '', { method = 'GET', headers = {}, body } = {}) => new Request(SITE + PREFIX + path, { method,
  headers: { 'oai-authenticated-user-id': 'synthetic-owner', origin: SITE,
    'x-lct-meeting-write': '1', 'content-type': 'application/json', ...headers },
  ...(body ? { body: JSON.stringify(body) } : {}) });
let sqlite, env, calls;
const row = () => sqlite.prepare('SELECT * FROM lct_meetings WHERE id = ?').get(ID);
const count = () => sqlite.prepare('SELECT COUNT(*) AS n FROM lct_meetings').get().n;
const join = (options = {}) => worker.fetch(req('', { method: 'POST', body: input, ...options }), env);

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); calls = [];
  const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  env = { LCT_MEETINGS_ENABLED: 'true', LCT_MEETINGS_OWNER: 'chatgpt:synthetic-owner',
    LCT_MEETINGS_TEST_END: new Date(Date.now() + 600_000).toISOString(),
    LCT_ATTENDEE_URL: 'https://fixture-host.fixture.ts.net:10000/lct-meet', LCT_ATTENDEE_API_KEY: KEY,
    DB: { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; },
      async first() { return sqlite.prepare(sql).get(...args) || null; },
      async run() { return sqlite.prepare(sql).run(...args); },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; } }; } } };
  vi.stubGlobal('fetch', vi.fn(async (url, options) => { calls.push({ url, options }); return json({ id: BOT, state: 'joining' }, 201); }));
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('owner-scoped meeting control through public Worker APIs', () => {
  it('refuses guest, another owner and invalid Google-session fallback without contacting the recorder', async () => {
    for (const headers of [{ 'oai-authenticated-user-id': '' }, { cookie: '__Host-lct-session=invalid' }]) {
      expect((await join({ headers })).status).toBe(401);
    }
    expect((await join({ headers: { 'oai-authenticated-user-id': 'another-owner' } })).status).toBe(403);
    expect(calls).toEqual([]); expect(count()).toBe(0);
  });

  it('requires complete server configuration, additive schema and a current test window', async () => {
    for (const key of ['LCT_MEETINGS_ENABLED', 'LCT_MEETINGS_OWNER', 'LCT_ATTENDEE_URL', 'LCT_ATTENDEE_API_KEY']) {
      const old = env[key]; delete env[key]; expect((await join()).status).toBe(503); env[key] = old;
    }
    env.LCT_ATTENDEE_URL = 'https://untrusted.invalid/lct-meet'; expect((await join()).status).toBe(503);
    env.LCT_ATTENDEE_URL = 'https://fixture-host.fixture.ts.net:10000/lct-meet';
    env.LCT_MEETINGS_TEST_END = new Date(Date.now() - 1).toISOString(); expect((await join()).status).toBe(503);
    env.LCT_MEETINGS_TEST_END = new Date(Date.now() + 600_000).toISOString();
    sqlite.exec('DROP TABLE lct_meetings'); // This test owns this disposable in-memory database.
    expect((await join()).status).toBe(503); expect(calls).toEqual([]);
  });

  it('rejects cross-origin requests, missing consent and non-Meet targets before reservation', async () => {
    for (const headers of [{ origin: 'https://elsewhere.invalid' }, { 'x-lct-meeting-write': '' }]) {
      expect((await join({ headers })).status).toBe(403);
    }
    for (const body of [{ ...input, consent: false }, { ...input, meetingUrl: 'http://127.0.0.1/admin' },
      { ...input, meetingUrl: input.meetingUrl + '?other=1' }, { ...input, requestId: '../other' }]) {
      expect((await join({ body })).status).toBe(400);
    }
    expect(count()).toBe(0); expect(calls).toEqual([]);
  });

  it('creates exactly one bounded captions-plus-MP3 bot with only server credentials', async () => {
    const response = await join({ body: { ...input, apiKey: 'untrusted', format: 'mp4', owner: 'another' } });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.meeting).toMatchObject({ id: ID, state: 'active' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(env.LCT_ATTENDEE_URL + '/api/v1/bots');
    expect(calls[0].options.headers.Authorization).toBe('Token ' + KEY);
    const wire = JSON.parse(calls[0].options.body);
    expect(wire).toMatchObject({ meeting_url: input.meetingUrl, deduplication_key: 'lct-' + ID,
      transcription_settings: { meeting_closed_captions: { google_meet_language: 'en-US' } },
      recording_settings: { format: 'mp3' }, automatic_leave_settings: { max_uptime_seconds: 300 } });
    expect(calls[0].options.redirect).toBe('manual');
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(JSON.stringify(row())).not.toContain(input.meetingUrl);
    expect(row().ends_at - row().created_at).toBe(300_000);
  });

  it('never repeats a duplicate create even after that meeting ends; refuses a second active reservation', async () => {
    await join();
    expect((await join()).status).toBe(200);
    expect((await join({ body: { ...input, requestId: ID2 } })).status).toBe(409);
    fetch.mockImplementationOnce(async () => json({ id: BOT, state: 'ended', utterances: [], audio_available: true }));
    expect((await worker.fetch(req('/' + ID), env)).status).toBe(200);
    expect(row().state).toBe('ended');
    expect((await join()).status).toBe(200);
    expect(calls.filter(call => call.options.method === 'POST')).toHaveLength(1);
    expect(count()).toBe(1);
  });

  it('logs only technical failure categories when diagnostics are explicitly enabled', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    env.LCT_MEETINGS_DIAGNOSTICS = 'true';
    fetch.mockResolvedValueOnce(json({ error: KEY + input.meetingUrl }, 400));
    const response = await join();
    expect(response.status).toBe(202); expect(row().state).toBe('uncertain'); expect(count()).toBe(1);
    expect(warning).toHaveBeenCalledExactlyOnceWith('lct.meetings.create_unconfirmed',
      { code: 'recorder', status: 502, upstreamStatus: 400 });
    const logged = JSON.stringify(warning.mock.calls);
    for (const privateValue of [KEY, input.meetingUrl, ID, 'synthetic-owner']) expect(logged).not.toContain(privateValue);
    expect((await join()).status).toBe(200); expect(warning).toHaveBeenCalledTimes(1);
  });

  it('keeps failure logging off by default and retains the uncertain reservation', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetch.mockRejectedValueOnce(new Error(KEY + input.meetingUrl));
    expect((await join()).status).toBe(202); expect(row().state).toBe('uncertain');
    expect(warning).not.toHaveBeenCalled(); expect(count()).toBe(1);
  });

  it('does not log raw transport errors even with diagnostics enabled', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    env.LCT_MEETINGS_DIAGNOSTICS = 'true';
    fetch.mockRejectedValueOnce(new Error(KEY + input.meetingUrl));
    expect((await join()).status).toBe(202); expect(row().state).toBe('uncertain');
    expect(warning).toHaveBeenCalledExactlyOnceWith('lct.meetings.create_unconfirmed',
      { code: 'unreachable', status: 503, upstreamStatus: null });
  });

  it('reconciles uncertain creation by GET without repeating the external join', async () => {
    fetch.mockRejectedValueOnce(new TypeError('synthetic transport failure'));
    expect((await join()).status).toBe(202); expect(row().state).toBe('uncertain');
    expect((await join({ body: { ...input, requestId: ID2 } })).status).toBe(409);
    fetch.mockImplementationOnce(async (url, options) => {
      calls.push({ url, options }); return json({ results: [{ id: BOT, state: 'joining' }], next: null });
    });
    fetch.mockImplementationOnce(async (url, options) => {
      calls.push({ url, options }); return json({ id: BOT, state: 'joined_recording', utterances: [] });
    });
    const response = await worker.fetch(req('/' + ID), env);
    expect(response.status).toBe(200); expect(row().bot_id).toBe(BOT); expect(row().state).toBe('active');
    expect(calls.every(call => call.options.method === 'GET')).toBe(true);
    expect(calls[0].url).toContain('deduplication_key=lct-');
  });

  it('keeps ambiguous or absent reconciliation reserved and refuses redirects', async () => {
    fetch.mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'https://evil.invalid' } }));
    await join(); expect(row().state).toBe('uncertain');
    fetch.mockResolvedValueOnce(json({ results: [], next: null }));
    expect((await worker.fetch(req('/' + ID), env)).status).toBe(202);
    fetch.mockResolvedValueOnce(json({ results: [{ id: BOT }, { id: BOT }], next: null }));
    expect((await worker.fetch(req('/' + ID), env)).status).toBe(503);
    expect(row().state).toBe('uncertain'); expect(row().bot_id).toBeNull();
  });

  it('protects snapshots, audio and leave by owner; streams bytes and only safe audio headers', async () => {
    await join(); calls = [];
    for (const path of ['/' + ID, '/' + ID + '/audio', '/' + ID + '/leave']) {
      const response = await worker.fetch(req(path, { method: path.endsWith('/leave') ? 'POST' : 'GET',
        headers: { 'oai-authenticated-user-id': 'another-owner' } }), env);
      expect(response.status).toBe(403);
    }
    expect(calls).toEqual([]);
    fetch.mockImplementationOnce(async (url, options) => {
      calls.push({ url, options }); return new Response(new Uint8Array([1, 2, 3]), { status: 206,
        headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-2/9', 'content-length': '3',
          'set-cookie': 'private-upstream', location: 'https://internal.invalid' } });
    });
    const audio = await worker.fetch(req('/' + ID + '/audio', { headers: { range: 'bytes=0-2' } }), env);
    expect(audio.status).toBe(206); expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(audio.headers.get('cache-control')).toBe('private, no-store');
    expect(audio.headers.get('set-cookie')).toBeNull(); expect(audio.headers.get('location')).toBeNull();
    expect(calls[0].options.headers.Range).toBe('bytes=0-2');
    expect(calls[0].options.headers.Accept).toContain('application/json');
    fetch.mockResolvedValueOnce(json({ id: BOT, state: 'leaving' }));
    expect((await worker.fetch(req('/' + ID + '/leave', { method: 'POST' }), env)).status).toBe(202);
    expect(row().state).toBe('active'); // A leave acknowledgement is not terminal evidence.
  });

  it('treats repeated leave and a terminal auto-leave as successful state evidence without another POST', async () => {
    await join(); calls = []; fetch.mockClear();
    fetch.mockResolvedValueOnce(json({ id: BOT, state: 'post_processing' }));
    expect((await worker.fetch(req('/' + ID + '/leave', { method: 'POST' }), env)).status).toBe(202);
    expect(calls).toHaveLength(0);
    fetch.mockResolvedValueOnce(json({ id: BOT, state: 'ended' }));
    expect((await worker.fetch(req('/' + ID + '/leave', { method: 'POST' }), env)).status).toBe(200);
    expect(row().state).toBe('ended'); expect(fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });
  it('does not contact the recorder for unknown meeting IDs or unsupported methods', async () => {
    expect((await worker.fetch(req('/' + ID2), env)).status).toBe(404);
    expect((await worker.fetch(req('/' + ID2 + '/delete', { method: 'POST' }), env)).status).toBe(404);
    expect((await worker.fetch(req('/' + ID2, { method: 'DELETE' }), env)).status).toBe(405);
    expect(calls).toEqual([]);
  });
});
