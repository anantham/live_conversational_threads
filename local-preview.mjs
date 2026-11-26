import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import worker from '/private/tmp/claude-501/-Users-aditya-Documents-Ongoing-Local-code-live-conversational-threads/6af939e3-42eb-4948-8c19-f69d475ae3ce/scratchpad/rec/lct_app/dist/server/index.js';

const localURL = 'http://127.0.0.1:4177';
// The same server also answers on the tailnet name that `tailscale serve` forwards, with that origin.
const tailnetURL = 'https://adityas-macbook-pro.tail4741ad.ts.net:5450';
const origins = { '127.0.0.1:4177': localURL, 'adityas-macbook-pro.tail4741ad.ts.net:5450': tailnetURL };
const assets = '/private/tmp/claude-501/-Users-aditya-Documents-Ongoing-Local-code-live-conversational-threads/6af939e3-42eb-4948-8c19-f69d475ae3ce/scratchpad/rec/lct_app/dist/client';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const database = new DatabaseSync(':memory:');
const drizzleRoot = new URL('file:///private/tmp/claude-501/-Users-aditya-Documents-Ongoing-Local-code-live-conversational-threads/6af939e3-42eb-4948-8c19-f69d475ae3ce/scratchpad/yt/lct_app/drizzle/');
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', drizzleRoot), 'utf8'));
for (const entry of journal.entries) database.exec(readFileSync(new URL(entry.tag + '.sql', drizzleRoot), 'utf8'));

const env = {
  LCT_PERSONAL_PROVIDERS_ENABLED: 'true',
  LCT_OPENROUTER_AUDIENCE: 'public',
  LCT_OPENROUTER_MAX_REQUESTS: '30',
  LCT_OPENROUTER_MAX_OUTPUT_TOKENS: '8192',
  LCT_OPENROUTER_LONG_MAX_OUTPUT_TOKENS: '12000',
  LCT_SONIOX_AUDIENCE: 'public',
  LCT_SONIOX_MAX_SESSIONS: '20',
  LCT_SONIOX_MAX_SESSION_SECONDS: '300',
  DB: {
    prepare(sql) {
      let params = [];
      return {
        bind(...values) { params = values; return this; },
        async first() { return database.prepare(sql).get(...params) ?? null; },
      };
    },
  },
  ASSETS: {
    async fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const asset = resolve(assets, '.' + (pathname === '/' ? '/index.html' : pathname));
      const file = relative(assets, asset);
      if (file.startsWith('..') || file === '') return new Response(null, { status: 404 });
      try {
        const bytes = await readFile(asset);
        return new Response(request.method === 'HEAD' ? null : bytes,
          { headers: { 'Content-Type': types[extname(asset)] ?? 'application/octet-stream' } });
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return new Response(null, { status: 404 });
        throw error;
      }
    },
  },
};

const server = createServer(async (incoming, outgoing) => {
  const controller = new AbortController();
  outgoing.once('close', () => { if (!outgoing.writableEnded) controller.abort(); });
  try {
    const origin = origins[incoming.headers.host];
    if (!origin) {
      outgoing.writeHead(421).end('Use the local preview URL.');
      return;
    }
    const url = new URL(incoming.url, origin);
    if (url.origin !== origin) {
      outgoing.writeHead(400).end('Invalid local preview URL.');
      return;
    }
    const hasBody = !['GET', 'HEAD'].includes(incoming.method);
    const request = new Request(url, { method: incoming.method, headers: incoming.headers, signal: controller.signal,
      ...(hasBody ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}) });
    const response = await worker.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing);
    else outgoing.end();
  } catch (error) {
    if (controller.signal.aborted) return;
    console.error('Local preview request failed', error.name);
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end('Local preview request failed.');
  }
});

server.listen(4177, '127.0.0.1', () => console.log('Local Sites preview at ' + localURL));
