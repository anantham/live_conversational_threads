const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--use-file-for-fake-audio-capture=/tmp/fake_mic_20s.wav',
    ],
  });
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const events = [];
  const startedAt = Date.now();
  const rel = () => Number(((Date.now() - startedAt) / 1000).toFixed(3));

  page.on('console', (msg) => {
    events.push({ dir: 'console', t: rel(), level: msg.type(), text: msg.text() });
  });
  page.on('pageerror', (err) => {
    events.push({ dir: 'pageerror', t: rel(), text: err.message, stack: err.stack || null });
  });

  page.on('websocket', (ws) => {
    const url = ws.url();
    events.push({ dir: 'ws_open', t: rel(), url });
    ws.on('framesent', (event) => {
      const payload = event.payload;
      let parsed = null;
      if (typeof payload === 'string') {
        try { parsed = JSON.parse(payload); } catch {}
      }
      events.push({ dir: 'out', t: rel(), url, rawType: typeof payload, kind: parsed?.type || null, payload: parsed });
    });
    ws.on('framereceived', (event) => {
      const payload = event.payload;
      let parsed = null;
      if (typeof payload === 'string') {
        try { parsed = JSON.parse(payload); } catch {}
      }
      events.push({ dir: 'in', t: rel(), url, rawType: typeof payload, kind: parsed?.type || null, payload: parsed });
    });
    ws.on('close', () => {
      events.push({ dir: 'ws_close', t: rel(), url });
    });
  });

  await page.goto('http://127.0.0.1:5173/new', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const startButton = page.locator('button[aria-label="Start recording"]');
  await startButton.waitFor({ state: 'visible', timeout: 15000 });
  await startButton.click();

  const stopButton = page.locator('button[aria-label="Stop recording"]');
  await stopButton.waitFor({ state: 'visible', timeout: 15000 });

  await page.waitForTimeout(23000);
  await stopButton.click();

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const hasFlushComplete = events.some((e) => e.dir === 'in' && e.kind === 'flush_complete');
    const hasSocketClose = events.some((e) => e.dir === 'ws_close');
    if (hasFlushComplete && hasSocketClose) break;
    await page.waitForTimeout(250);
  }

  const inbound = events.filter((e) => e.dir === 'in');
  const firstOf = (kind) => inbound.find((e) => e.kind === kind)?.t ?? null;
  const counts = {};
  for (const e of inbound) {
    const key = e.kind || e.rawType || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }

  const summary = {
    counts,
    ack: firstOf('session_ack'),
    firstPartial: firstOf('transcript_partial'),
    firstFinal: firstOf('transcript_final'),
    firstGraphPatch: firstOf('graph_patch'),
    flushAck: firstOf('flush_ack'),
    flushComplete: firstOf('flush_complete'),
    providerHttpUrl: inbound.find((e) => e.kind === 'session_ack')?.payload?.provider_http_url ?? null,
    transcriptPayloads: inbound
      .filter((e) => ['transcript_partial', 'transcript_final', 'graph_patch', 'flush_ack', 'flush_complete', 'session_ack', 'error', 'stt_provider_error', 'processing_status'].includes(e.kind))
      .map((e) => ({ t: e.t, kind: e.kind, payload: e.payload })),
    consoleTail: events.filter((e) => e.dir === 'console').slice(-40),
    pageErrors: events.filter((e) => e.dir === 'pageerror'),
    totalEvents: events.length,
  };

  fs.writeFileSync('/tmp/lct_real_browser_whisper_trace.json', JSON.stringify({ summary, events }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
})().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
