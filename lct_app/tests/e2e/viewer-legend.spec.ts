import { expect, test } from '@playwright/test';

// Intent: prove spacing and clickability through a populated artifact, with
// Source/details/timeline combined. Player fixture tests layout, not playback.
function artifact(video: boolean) {
  const utterances = Array.from({ length: 6 }, (_, i) => ({
    id: `u${i}`, speaker_id: `SPEAKER_0${i % 2}`,
    ...(i === 0 ? { speaker_name: 'Synthetic speaker with a deliberately long display name for wrapping' } : {}),
    text: `Synthetic source passage ${i + 1}. `.repeat(12),
    timestamp_start: i * 20, timestamp_end: i * 20 + 18,
  }));
  const moments = utterances.map((u, i) => ({
    id: `m${i}`, semantic_level: 1, semantic_type: 'moment', parent_id: 'topic',
    node_name: `Synthetic moment ${i + 1}`, summary: u.text,
    source_excerpt: u.text, utterance_ids: [u.id], speaker_id: u.speaker_id,
    timestamp_start: u.timestamp_start, timestamp_end: u.timestamp_end,
    thread_ids: [] as string[], thread_id: '',
  }));
  const threads = Array.from({ length: 14 }, (_, i) => ({
    id: `t${i}`, title: `Synthetic thread ${i + 1}`,
    steps: [i % 6, (i + 1) % 6, (i + 2) % 6].map(n => ({ moment_id: `m${n}`, evidence_utterance_ids: [`u${n}`] })),
  }));
  moments.forEach(moment => {
    moment.thread_ids = threads.filter(thread => thread.steps.some(step => step.moment_id === moment.id)).map(thread => thread.id);
    moment.thread_id = moment.thread_ids[0];
  });
  return {
    format: 'lct.threads', format_version: 2, conversation_id: 'legend-synthetic',
    conversation_title: 'Synthetic Legend layout', chunk_dict: {}, utterances,
    full_transcript: utterances.map(u => `[${u.speaker_id}] ${u.text}`).join('\n'),
    conversation_threads: threads, edges: [],
    edge_schema: { version: 1, directed: true, endpoint_space: 'graph_data.id' },
    media_refs: video ? [{ provider: 'youtube', video_id: 'ABCDEFGHIJK', view_url: 'https://www.youtube.com/watch?v=ABCDEFGHIJK', time_unit: 'seconds' }] : [],
    graph_data: [{ id: 'topic', semantic_level: 3, semantic_type: 'topic', node_name: 'Synthetic topic', children_ids: moments.map(n => n.id) }, ...moments],
  };
}

async function open(page, video: boolean) {
  const errors: string[] = [], backend: string[] = [], serverErrors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api/')) backend.push(r.url()); });
  page.on('response', r => { if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`); });
  await page.addInitScript(() => {
    window.__MG_DEBUG__ = false;
    window.YT = { Player: function(host, options) {
      const iframe = document.createElement('iframe'); host.replaceWith(iframe);
      const player = { getIframe: () => iframe, getPlayerState: () => 5, getCurrentTime: () => 0,
        cueVideoById: () => {}, seekTo: () => {}, destroy: () => iframe.remove() };
      queueMicrotask(() => options.events.onReady()); return player;
    } };
  });
  await page.goto('/view');
  await page.locator('input[type=file]').setInputFiles({ name: 'legend.threads', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(artifact(video))) });
  await expect(page.getByRole('heading', { name: 'Synthetic Legend layout' })).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Show thread timeline' }).locator('..')).toContainText('14 threads');
  return { errors, backend, serverErrors };
}

const legendButton = page => page.getByRole('button', { name: 'Show legend: speakers and edge colors' });
const timelineHeader = page => page.getByRole('button', { name: /(?:Show|Hide) thread timeline/ }).locator('../..');
async function gap(page) {
  const button = await legendButton(page).boundingBox(), timeline = await timelineHeader(page).boundingBox();
  return timeline.y - button.y - button.height;
}
async function clearOfPanes(page, target) {
  const a = await target.boundingBox(); expect(a.width).toBeGreaterThan(0); expect(a.height).toBeGreaterThan(0);
  const viewport = page.viewportSize();
  expect(a.x).toBeGreaterThanOrEqual(0); expect(a.x + a.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(a.y).toBeGreaterThanOrEqual(0); expect(a.y + a.height).toBeLessThanOrEqual(viewport.height + 1);
  for (const pane of [page.getByRole('complementary'), page.getByRole('dialog'), page.getByRole('navigation', { name: /reading controls/ })]) {
    if (await pane.count() && await pane.isVisible()) {
      const b = await pane.boundingBox();
      const area = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      expect(area).toBe(0);
    }
  }
}

for (const [width, height] of [[1440, 900], [1024, 768], [390, 844], [320, 640]]) {
  test(`Legend stays clear of combined panes at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height }); const evidence = await open(page, width === 390);
    await expect.poll(() => gap(page)).toBe(12);
    await page.getByRole('button', { name: 'Show thread timeline' }).click();
    const label = page.getByTestId('thread-label-gutter').getByRole('button', { name: /^Synthetic thread 1\b/ }).first();
    await label.click(); await label.locator('..').getByRole('button', { name: /Next node/ }).click();
    await expect(page.getByRole('dialog').locator('h2')).toHaveText('Synthetic moment 1');
    await clearOfPanes(page, legendButton(page)); await expect.poll(() => gap(page)).toBe(12);
    await legendButton(page).click();
    const key = page.getByRole('region', { name: 'Speaker colors and edge key' });
    await expect(key).toBeVisible(); await clearOfPanes(page, key);
    await expect(key).toContainText('Synthetic speaker with a deliberately long display name for wrapping');
    await key.getByRole('button', { name: 'Close legend', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(key).toHaveCount(0); await expect(legendButton(page)).toBeFocused();
    await expect(page.getByRole('dialog').locator('h2')).toHaveText('Synthetic moment 1');
    await legendButton(page).click(); await expect(key).toBeVisible();
    await key.getByText('tangent', { exact: true }).scrollIntoViewIfNeeded();
    await key.getByRole('button', { name: 'Close legend', exact: true }).click();
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(page.getByRole('complementary')).toBeVisible(); await clearOfPanes(page, legendButton(page));
    await legendButton(page).focus(); await page.keyboard.press('Enter');
    await expect(key).toBeVisible(); await clearOfPanes(page, key);
    await page.screenshot({ path: test.info().outputPath('legend-combined-panes.png') });
    await key.getByRole('button', { name: 'Close legend', exact: true }).click();
    await page.getByRole('complementary').getByRole('button', { name: /^Hide source(?: panel)?$/ }).click();
    const reading = page.getByRole('navigation', { name: 'Selected thread reading controls' });
    await reading.getByRole('button', { name: 'Next moment in selected thread' }).click();
    await expect(page.getByRole('dialog').locator('h2')).toHaveText('Synthetic moment 2');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('dialog').locator('h2')).toHaveText('Synthetic moment 1');
    await page.setViewportSize({ width: width === 320 ? 390 : width, height: height - 100 });
    await clearOfPanes(page, legendButton(page)); await expect.poll(() => gap(page)).toBe(12);
    await legendButton(page).click(); await expect(key).toBeVisible(); await clearOfPanes(page, key);
    await page.screenshot({ path: test.info().outputPath('legend-resized.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(evidence.errors).toEqual([]); expect(evidence.backend).toEqual([]); expect(evidence.serverErrors).toEqual([]);
  });
}
