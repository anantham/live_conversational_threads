// @vitest-environment node
// Test intent: tests/intent/sites-serverless-worker.md. All keys/data are synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SITE = 'https://fixture-lct.example.chatgpt.site';
let worker;
let upstream;

function request(path, { method = 'POST', headers = {}, body = '{}' } = {}) {
  return new Request(SITE + path, {
    method,
    headers: {
      origin: SITE,
      'cf-connecting-ip': '203.0.113.1',
      'x-lct-byok-key': 'fixture-user-key',
      ...headers,
    },
    ...(method === 'POST' ? { body } : {}),
  });
}

beforeEach(async () => {
  vi.resetModules();
  worker = (await import('../../../sites/worker.js')).default;
  upstream = vi.fn().mockResolvedValue(new Response('{}', {
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', upstream);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Sites Worker public fetch interface', () => {
  it('forwards BYOK chat and exposes tokens before the upstream stream closes', async () => {
    let controller;
    upstream.mockResolvedValueOnce(new Response(new ReadableStream({
      start(value) { controller = value; value.enqueue(new TextEncoder().encode('data: first\n\n')); },
    }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const response = await worker.fetch(request('/api/proxy/chat', { body: '{"stream":true}' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SITE);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(upstream.mock.calls[0]).toEqual(['https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-user-key' },
      body: '{"stream":true}',
    }]);
    const reader = response.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n');
    controller.close();
    expect((await reader.read()).done).toBe(true);
  });

  it('serves exact-origin preflight and rejects other Sites before contacting OpenAI', async () => {
    const preflight = await worker.fetch(request('/api/proxy/chat', { method: 'OPTIONS' }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(SITE);
    const denied = await worker.fetch(request('/api/proxy/chat', {
      headers: { origin: 'https://another.example.chatgpt.site' },
    }));
    expect(denied.status).toBe(403);
    expect(denied.headers.has('Access-Control-Allow-Origin')).toBe(false);
    expect(upstream.mock.calls).toHaveLength(0);
  });

  it('requires BYOK even if an owner key exists in the Worker environment', async () => {
    const response = await worker.fetch(request('/api/proxy/chat', {
      headers: { 'x-lct-byok-key': '', 'x-lct-trial': '1' },
    }), { OPENAI_TRIAL_KEY: 'fixture-owner-key' });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('Missing x-lct-byok-key');
    expect(upstream.mock.calls).toHaveLength(0);
    const trial = await worker.fetch(request('/api/proxy/transcribe'));
    expect(trial.status).toBe(401);
  });

  it('keeps upstream failures explicit and sanitizes thrown transport errors', async () => {
    upstream.mockResolvedValueOnce(new Response('{"error":"quota"}', { status: 429 }));
    const quota = await worker.fetch(request('/api/proxy/chat'));
    expect(quota.status).toBe(429);
    expect(await quota.json()).toEqual({ error: 'quota' });
    upstream.mockRejectedValueOnce(new Error('transport fixture-user-key'));
    const unavailable = await worker.fetch(request('/api/proxy/chat'));
    expect(unavailable.status).toBe(502);
    expect(await unavailable.text()).toBe('Proxy Error');
  });

  it('returns realtime token data without making it cacheable', async () => {
    upstream.mockResolvedValueOnce(new Response('{"client_secret":{"value":"fixture-ephemeral"}}'));
    const response = await worker.fetch(request('/api/proxy/realtime-token'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ client_secret: { value: 'fixture-ephemeral' } });
    expect(upstream.mock.calls[0][0]).toBe('https://api.openai.com/v1/realtime/sessions');
  });

  it('limits the Cloudflare client IP despite changing caller forwarding headers', async () => {
    let response;
    for (let index = 0; index < 31; index += 1) {
      response = await worker.fetch(request('/api/proxy/chat', {
        headers: { 'x-forwarded-for': '198.51.100.' + index },
      }));
    }
    expect(response.status).toBe(429);
    expect(await response.text()).toBe('Rate Limit Exceeded');
    expect(upstream.mock.calls).toHaveLength(30);
  });

  it('rejects wrong methods and reports full-backend routes instead of serving HTML', async () => {
    const wrongMethod = await worker.fetch(request('/api/proxy/chat', { method: 'GET' }));
    expect(wrongMethod.status).toBe(405);
    const assets = { fetch: vi.fn().mockResolvedValue(new Response('app')) };
    for (const path of ['/api/import/health', '/ws/transcripts', '/conversations/', '/save_json/']) {
      const response = await worker.fetch(request(path, { method: 'GET' }), { ASSETS: assets });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: expect.stringContaining('full LCT backend') });
    }
    expect(assets.fetch.mock.calls).toHaveLength(0);
    expect(upstream.mock.calls).toHaveLength(0);
  });

  it('propagates downstream stream cancellation to the upstream response body', async () => {
    let cancelled = false;
    upstream.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); },
      cancel() { cancelled = true; },
    })));
    const response = await worker.fetch(request('/api/proxy/chat'));
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  it('delegates page/assets requests and describes a missing binding', async () => {
    const assetRequest = request('/browse', { method: 'GET' });
    const assets = { fetch: vi.fn().mockResolvedValue(new Response('fixture-app')) };
    expect(await (await worker.fetch(assetRequest, { ASSETS: assets })).text()).toBe('fixture-app');
    expect(assets.fetch.mock.calls[0][0]).toBe(assetRequest);
    const unbound = await worker.fetch(assetRequest);
    expect(unbound.status).toBe(503);
    expect((await unbound.json()).error).toContain('asset binding');
  });

  it('preserves the Vercel entrypoint trial behavior after extraction', async () => {
    vi.stubEnv('OPENAI_TRIAL_KEY', 'fixture-owner-key');
    const handler = (await import('../../../api/proxy/chat.js')).default;
    const response = await handler(new Request('https://threads.adityaarpitha.com/api/proxy/chat', {
      method: 'POST', headers: { origin: 'https://threads.adityaarpitha.com', 'x-lct-trial': '1' }, body: '{}',
    }));
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-owner-key');
  });
});
