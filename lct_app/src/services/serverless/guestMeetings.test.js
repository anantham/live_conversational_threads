// @vitest-environment node
// Intent: tests/intent/guest-meetings.md. Isolated SQLite and synthetic credentials/recorder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../../sites/worker.js';
const SITE = 'https://guest-fixture.example.chatgpt.site', BASE = '/api/cloud/meetings';
const ID = '12345678-1234-4123-8123-123456789abc', BOT = 'bot_abcdefghijklmnop';
const input = { requestId: ID, meetingUrl: 'https://meet.google.com/abc-defg-hij', consent: true };
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
let db, env, calls;
const request = (path, cookie = '', body, origin = SITE) => new Request(SITE + path, {
  method: body ? 'POST' : 'GET', headers: { cookie, origin, 'content-type': 'application/json', 'x-lct-meeting-write': '1' },
  ...(body ? { body: JSON.stringify(body) } : {}) });
const run = (path = '', cookie, body, origin) => worker.fetch(request(BASE + path, cookie, body, origin), env);
async function browser() {
  const response = await run('/guest-session', '', {});
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie').split(';')[0];
}
beforeEach(() => {
  db = new DatabaseSync(':memory:'); calls = [];
  for (const entry of JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url))).entries) {
    db.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  }
  env = { LCT_MEETINGS_ENABLED: 'true', LCT_MEETINGS_GUEST_ENABLED: 'true', LCT_MEETINGS_OWNER: 'google:synthetic-owner',
    LCT_GOOGLE_SESSION_SECRET: 'synthetic-secret-for-guest-meeting-tests-only',
    LCT_MEETINGS_TEST_END: new Date(Date.now() + 600000).toISOString(),
    LCT_ATTENDEE_URL: 'https://fixture-host.fixture.ts.net:10000/lct-meet', LCT_ATTENDEE_API_KEY: 'a'.repeat(64),
    DB: { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; },
      async first() { return db.prepare(sql).get(...args) || null; }, async run() { return db.prepare(sql).run(...args); },
      async all() { return { results: db.prepare(sql).all(...args) }; } }; } } };
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/snapshot')) return json({ id: BOT, state: 'joined_recording', utterances: [], recording_state: 'in_progress' });
    if (url.includes('/audio-chunks/')) return new Response(new Uint8Array([82, 73, 70, 70, 1, 2]), { headers: { 'content-type': 'audio/wav' } });
    if (url.endsWith('/audio')) return new Response(new Uint8Array([73, 68, 51]), { headers: { 'content-type': 'audio/mpeg' } });
    return json({ id: BOT, state: 'joining' });
  }));
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('browser-owned meeting access', () => {
  it('issues a private host-bound cookie without account login, database rows or recorder calls', async () => {
    const response = await run('/guest-session', '', {});
    expect(await response.json()).toEqual({ mode: 'guest' });
    expect(response.headers.get('set-cookie')).toMatch(/^__Host-lct-meeting-guest=/);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) expect(response.headers.get('set-cookie')).toContain(flag);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(db.prepare('SELECT COUNT(*) AS n FROM lct_meetings').get().n).toBe(0); expect(calls).toEqual([]);
  });
  it('requires same-origin explicit session creation and never mutates a session on GET', async () => {
    expect((await run('/guest-session')).status).toBe(405);
    expect((await run('/guest-session', '', {}, 'https://evil.invalid')).status).toBe(403);
    const missing = new Request(SITE + BASE + '/guest-session', { method: 'POST', headers: { origin: SITE } });
    expect((await worker.fetch(missing, env)).status).toBe(403); expect(calls).toEqual([]);
  });
  it('reuses the browser capability across reload without replacing it', async () => {
    const cookie = await browser(); const repeat = await run('/guest-session', cookie, {});
    expect(repeat.status).toBe(200); expect(repeat.headers.get('set-cookie')).toBeNull();
    expect((await run('/status', cookie)).status).toBe(200); expect(calls).toEqual([]);
  });
  it('rejects missing, forged, ambiguous, expired and wrong-origin capabilities', async () => {
    const cookie = await browser();
    for (const bad of ['', '__Host-lct-meeting-guest=forged', cookie + '; ' + cookie]) {
      expect((await run('', bad, input)).status).toBe(401);
    }
    const other = new Request('https://other.example.chatgpt.site' + BASE, { method: 'POST', headers: { cookie, origin: 'https://other.example.chatgpt.site', 'x-lct-meeting-write': '1', 'content-type': 'application/json' }, body: JSON.stringify(input) });
    expect((await worker.fetch(other, env)).status).toBe(401);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 31 * 86400000);
    expect((await run('/status', cookie)).status).toBe(401); expect(calls).toEqual([]);
  });
  it('allows an anonymous guest to create one consented, bounded recording and reconnect to its captions/audio', async () => {
    const cookie = await browser();
    expect((await run('', cookie, input)).status).toBe(202);
    expect((await run('', cookie, input)).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect((await (await run('', cookie)).json()).meetings).toHaveLength(1);
    expect((await (await run('/' + ID, cookie)).json()).snapshot.state).toBe('joined_recording');
    const audio = await run('/' + ID + '/audio', cookie);
    expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([73, 68, 51]);
    const wire = JSON.parse(calls[0].options.body);
    expect(wire.automatic_leave_settings.max_uptime_seconds).toBe(300);
    expect(db.prepare('SELECT owner FROM lct_meetings').get().owner).toMatch(/^guest:/);
  });
  it('isolates a second browser even with the meeting ID, including audio and leave', async () => {
    const first = await browser(), second = await browser(); await run('', first, input); calls = [];
    expect((await (await run('', second)).json()).meetings).toEqual([]);
    for (const path of ['/' + ID, '/' + ID + '/audio', '/' + ID + '/audio-chunks/17', '/' + ID + '/leave']) {
      expect((await run(path, second, path.endsWith('/leave') ? {} : undefined)).status).toBe(404);
    }
    expect((await run('', second, input)).status).toBe(409); expect(calls).toEqual([]);
    expect(db.prepare('SELECT state FROM lct_meetings').get().state).toBe('active');
  });
  it('streams live WAV only for this browser and never permits arbitrary audio paths', async () => {
    const cookie = await browser(); await run('', cookie, input);
    const response = await run('/' + ID + '/audio-chunks/17', cookie);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('audio/wav');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([82, 73, 70, 70, 1, 2]);
    expect((await run('/' + ID + '/audio-chunks/0', cookie)).status).toBe(404);
    expect((await run('/' + ID + '/audio-chunks/17/extra', cookie)).status).toBe(404);
  });
  it('retains consent, URL, CSRF and closed-window checks for guests', async () => {
    const cookie = await browser();
    expect((await run('', cookie, { ...input, consent: false })).status).toBe(400);
    expect((await run('', cookie, { ...input, meetingUrl: 'https://evil.invalid' })).status).toBe(400);
    expect((await run('', cookie, input, 'https://evil.invalid')).status).toBe(403);
    env.LCT_MEETINGS_TEST_END = new Date(Date.now() - 1000).toISOString();
    expect((await run('', cookie, input)).status).toBe(503); expect(calls).toEqual([]);
  });
  it('does not turn guest capability into account authentication or private cloud-file access', async () => {
    const cookie = await browser();
    const session = await worker.fetch(request('/api/auth/session', cookie), env);
    expect(session.status).toBe(401); expect((await session.json()).authenticated).toBe(false);
    env.LCT_STORAGE_ENABLED = 'true'; env.BUCKET = {};
    const files = await worker.fetch(request('/api/cloud/files', cookie), env);
    expect(files.status).toBe(401); expect(calls).toEqual([]);
  });
  it('keeps guest mode closed when the server feature is disabled or its signing secret is absent', async () => {
    delete env.LCT_GOOGLE_SESSION_SECRET;
    expect(await (await run('/guest-session', '', {})).json()).toEqual({ mode: 'account' });
    expect((await run('', '', input)).status).toBe(401); expect(calls).toEqual([]);
  });
});
