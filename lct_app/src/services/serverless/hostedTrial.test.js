// @vitest-environment node
// Intent: tests/intent/hosted-attendee-site.md. Actual isolated SQLite, synthetic HTTP only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../../sites/worker.js';
const SITE = 'https://hosted-fixture.example', BASE = '/api/cloud/hosted-trial', API = 'https://app.attendee.dev/api/v1/bots';
const ID = '12345678-1234-4123-8123-123456789abc', ID2 = '22345678-1234-4123-8123-123456789abc';
const BOT = 'bot_abcdefghijklmnop', ROOM = 'https://meet.google.com/abc-defg-hij', KEY = 'SYNTHETIC-ONLY-KEY-12345';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const input = { requestId: ID, meetingUrl: ROOM, consent: true };
let db, env, calls, state, text, project, failCreate, mediaURL;
const row = () => db.prepare('SELECT * FROM lct_hosted_attendee_trials WHERE id = 1').get();
function req(path = '', { method = 'GET', headers = {}, body } = {}) {
  return new Request(SITE + BASE + path, { method, headers: { origin: SITE, 'oai-authenticated-user-id': 'synthetic-owner',
    'x-lct-meeting-write': '1', 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
const run = (path = '', options) => worker.fetch(req(path, options), env);
const join = (body = input, headers) => run('', { method: 'POST', body, headers });
beforeEach(() => {
  db = new DatabaseSync(':memory:'); calls = []; state = 'joined_recording'; text = 'Synthetic garden discussion';
  project = { results: [], next: null }; failCreate = false;
  mediaURL = 'https://attendee-short-term-storage-production.s3.amazonaws.com/fixture.mp3?X-Amz-Signature=synthetic';
  const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) db.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  db.prepare("INSERT INTO lct_meetings (id,owner,url_hash,state,created_at,ends_at) VALUES (?,?,'old-hash','uncertain',1,1001)").run(ID2,'preserved-asus-owner');
  env = { LCT_HOSTED_ATTENDEE_API_KEY: KEY, LCT_MEETINGS_OWNER: 'chatgpt:synthetic-owner',
    LCT_HOSTED_ATTENDEE_MEETING_URL: ROOM, LCT_HOSTED_ATTENDEE_ENABLED: 'true',
    LCT_HOSTED_ATTENDEE_TEST_END: new Date(Date.now() + 600_000).toISOString(),
    DB: { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; },
      async first() { return db.prepare(sql).get(...args) || null; }, async run() { return db.prepare(sql).run(...args); },
      async all() { return { results: db.prepare(sql).all(...args) }; } }; } } };
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    calls.push({ url, options });
    if (url === API && options.method === 'GET') return json(project);
    if (url === API && options.method === 'POST') {
      if (failCreate) throw new Error(KEY + ROOM);
      return json({ id: BOT, state: 'joining' }, 201);
    }
    if (url.startsWith(API + '?')) return json({ results: [{ id: BOT, state, deduplication_key: 'lct-hosted-site-' + ID }], next: null });
    if (url.endsWith('/transcript')) return json([{ speaker_name: 'Synthetic voice', speaker_uuid: 'synthetic-speaker',
      timestamp_ms: 1793000000000, duration_ms: 1000, transcription: { transcript: text } }]);
    if (url.endsWith('/recording')) return json({ url: mediaURL });
    if (url.endsWith('/leave')) { state = 'leaving'; return json({ id: BOT }); }
    if (url === mediaURL) return new Response(new Uint8Array([73,68,51,...Array(256).fill(1)]), { headers: { 'content-type': 'audio/mpeg', 'set-cookie': 'not-forwarded' } });
    return json({ id: BOT, state });
  }));
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe('one owner-only hosted Attendee Site pilot', () => {
  it('refuses guest, forged cookie and another account before recorder calls or new rows', async () => {
    for (const headers of [{ 'oai-authenticated-user-id': '' }, { cookie: '__Host-lct-session=forged' }]) expect((await join(input, headers)).status).toBe(401);
    expect((await join(input, { 'oai-authenticated-user-id': 'other' })).status).toBe(403);
    expect(row()).toBeUndefined(); expect(calls).toEqual([]);
  });
  it('keeps old Asus data intact while status is read-only and a configured check proves empty project', async () => {
    const before = db.prepare('SELECT * FROM lct_meetings').all();
    expect(await (await run('/status')).json()).toMatchObject({ canJoin: true, maxSeconds: 180, trial: null, configurationIssues: [] });
    expect(calls).toEqual([]);
    expect(await (await run('/check', { method: 'POST', body: {} })).json()).toMatchObject({ authenticated: true, emptyProject: true });
    expect(calls).toHaveLength(1); expect(calls[0].options.method).toBe('GET'); expect(row()).toBeUndefined();
    expect(db.prepare('SELECT * FROM lct_meetings').all()).toEqual(before);
  });
  it.each([
    ['LCT_HOSTED_ATTENDEE_API_KEY', '', 'Hosted Attendee API key is missing or has an invalid format.'],
    ['LCT_HOSTED_ATTENDEE_API_KEY', KEY + '\n', 'Hosted Attendee API key is missing or has an invalid format.'],
    ['LCT_HOSTED_ATTENDEE_MEETING_URL', '', 'Approved Meet room configuration is missing or invalid.'],
    ['LCT_HOSTED_ATTENDEE_MEETING_URL', ROOM + '?browser=1', 'Approved Meet room configuration is missing or invalid.'],
  ])('reports only redacted owner setup issues for %s', async (name, value, message) => {
    env[name] = value;
    const response = await run('/status'), body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ configured: false, canJoin: false, configurationIssues: [message], trial: null });
    expect(JSON.stringify(body)).not.toContain(KEY); expect(JSON.stringify(body)).not.toContain(ROOM);
    expect((await run('/check', { method: 'POST', body: {} })).status).toBe(503);
    expect(row()).toBeUndefined(); expect(calls).toEqual([]);
  });
  it('withholds setup diagnostics from guests and other owners', async () => {
    env.LCT_HOSTED_ATTENDEE_API_KEY = '';
    for (const [id, status] of [['', 401], ['other', 403]]) {
      const response = await run('/status', { headers: { 'oai-authenticated-user-id': id } });
      expect(response.status).toBe(status); expect(await response.text()).not.toContain('configurationIssues');
    }
    expect(row()).toBeUndefined(); expect(calls).toEqual([]);
  });
  it('refuses missing key, expired/default-off configuration, wrong room, consent and origin before create', async () => {
    for (const [key, value] of [['LCT_HOSTED_ATTENDEE_API_KEY',''], ['LCT_HOSTED_ATTENDEE_ENABLED','false'], ['LCT_HOSTED_ATTENDEE_TEST_END','2000-01-01']]) {
      const old = env[key]; env[key] = value; expect((await join()).status).toBe(503); env[key] = old;
    }
    for (const body of [{ ...input, consent: false }, { ...input, meetingUrl: ROOM + '?other=1' }, { ...input, requestId: '../other' }]) expect((await join(body)).status).toBe(400);
    expect((await join(input, { origin: 'https://other.invalid' })).status).toBe(403);
    expect(row()).toBeUndefined(); expect(calls).toEqual([]);
  });
  it.each([{}, { results: [], next: 'cursor' }, { results: [{ id: BOT }], next: null }])('refuses nonempty/unreadable remote project %j', async page => {
    project = page; expect((await join()).status).toBe(409); expect(row()).toBeUndefined();
    expect(calls.every(c => c.options.method === 'GET')).toBe(true);
  });
  it('sends one hard-capped native-caption/MP3 request, with no client-selected key/provider/duration', async () => {
    const response = await join({ ...input, apiKey: 'untrusted', maxSeconds: 900, format: 'mp4' });
    expect(response.status).toBe(202); expect((await response.text())).not.toContain(KEY);
    const post = calls.filter(c => c.options.method === 'POST'); expect(post).toHaveLength(1);
    expect(post[0].url).toBe(API); expect(post[0].options.redirect).toBe('manual');
    expect(post[0].options.headers.Authorization).toBe('Token ' + KEY);
    expect(JSON.parse(post[0].options.body)).toMatchObject({ meeting_url: ROOM, deduplication_key: 'lct-hosted-site-' + ID,
      transcription_settings: { meeting_closed_captions: { google_meet_language: 'en-US' } }, recording_settings: { format: 'mp3' },
      automatic_leave_settings: { max_uptime_seconds: 180 }, debug_settings: { create_debug_recording: false } });
    expect(row().ends_at - row().created_at).toBe(180_000); expect(JSON.stringify(row())).not.toContain(ROOM);
    expect((await join()).status).toBe(200); expect((await join({ ...input, requestId: ID2 })).status).toBe(409);
    expect(calls.filter(c => c.options.method === 'POST')).toHaveLength(1);
  });
  it('atomically reserves one lifetime attempt when two starts overlap', async () => {
    const replies = await Promise.all([join(), join({ ...input, requestId: ID2 })]);
    expect(replies.map(r => r.status).sort()).toEqual([202,409]);
    expect(calls.filter(c => c.options.method === 'POST')).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lct_hosted_attendee_trials').get().n).toBe(1);
  });
  it('retains uncertain dispatch, reconciles only the original dedup and never sends a replacement', async () => {
    failCreate = true; expect((await join()).status).toBe(202); expect(row().state).toBe('uncertain');
    expect((await join()).status).toBe(200);
    const result = await (await run('/snapshot')).json(); expect(result.snapshot.state).toBe('joined_recording');
    expect(row().bot_id).toBe(BOT); expect(calls.filter(c => c.options.method === 'POST')).toHaveLength(1);
    expect(calls.some(c => c.url === API + '?deduplication_key=lct-hosted-site-' + ID)).toBe(true);
  });
  it('returns incremental timed captions and preserves read/leave access after admission closes', async () => {
    await join(); env.LCT_HOSTED_ATTENDEE_ENABLED = 'false'; env.LCT_HOSTED_ATTENDEE_TEST_END = '2000-01-01';
    const first = await (await run('/snapshot')).json(); text += ' with a second moment';
    const second = await (await run('/snapshot')).json(); expect(first.snapshot.transcript).not.toEqual(second.snapshot.transcript);
    expect(second.snapshot.transcript[0]).toMatchObject({ timestamp_ms: 1793000000000, duration_ms: 1000, transcription: { transcript: text } });
    expect((await run('/leave', { method: 'POST', body: {} })).status).toBe(200);
    expect((await run('/leave', { method: 'POST', body: {} })).status).toBe(200);
    expect(calls.filter(c => c.url.endsWith('/leave'))).toHaveLength(1); expect(row().leave_attempted_at).toBeGreaterThan(0);
    state = 'ended'; expect((await run('/leave', { method: 'POST', body: {} })).status).toBe(200); expect(row().state).toBe('ended');
    expect((await join({ ...input, requestId: ID2 })).status).toBe(409);
  });
  it('treats documented null transcriptions as pending but rejects malformed entries', async () => {
    await join();
    fetch.mockResolvedValueOnce(json({ id: BOT, state })).mockResolvedValueOnce(json([{ transcription: null }]));
    const response = await run('/snapshot'); expect(response.status).toBe(200); expect((await response.json()).snapshot.transcript).toEqual([]);
    fetch.mockResolvedValueOnce(json({ id: BOT, state })).mockResolvedValueOnce(json([null]));
    expect((await run('/snapshot')).status).toBe(502);
  });
  it('retains a failed leave attempt without automatically repeating its POST', async () => {
    await join();
    fetch.mockResolvedValueOnce(json({ id: BOT, state })).mockRejectedValueOnce(new Error('synthetic lost leave'));
    expect((await run('/leave', { method: 'POST', body: {} })).status).toBe(503);
    expect(row().leave_attempted_at).toBeGreaterThan(0);
    const afterFirst = fetch.mock.calls.filter(([url]) => url.endsWith('/leave')).length;
    await run('/leave', { method: 'POST', body: {} });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/leave')).length).toBe(afterFirst);
  });
  it('requires successful terminal capture and downloads only approved MP3 without API credentials', async () => {
    await join(); state = 'fatal_error'; expect((await run('/audio')).status).toBe(409);
    state = 'ended'; const response = await run('/audio'); expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(259); expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const media = calls.find(c => c.url === mediaURL); expect(media.options.headers.Authorization).toBeUndefined(); expect(media.options.redirect).toBe('manual');
  });
  it('refuses an arbitrary media destination before contacting it and refuses redirected API responses', async () => {
    await join(); state = 'ended'; mediaURL = 'https://untrusted.invalid/fixture.mp3';
    expect((await run('/audio')).status).toBe(502); expect(calls.some(c => c.url === mediaURL)).toBe(false);
    fetch.mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'https://untrusted.invalid' } }));
    expect((await run('/snapshot')).status).toBe(502);
  });
  it('fails closed on missing schema and invalid methods, with no API or key disclosure', async () => {
    expect((await run('/check')).status).toBe(405); expect((await run('/unknown')).status).toBe(404);
    db.exec('DROP TABLE lct_hosted_attendee_trials');
    const response = await run('/status'); expect(response.status).toBe(503); expect(await response.text()).not.toContain(KEY); expect(calls).toEqual([]);
  });
});
