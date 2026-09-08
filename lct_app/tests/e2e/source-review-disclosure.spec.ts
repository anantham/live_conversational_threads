import { expect, test } from '@playwright/test';

// Intent: exercise file import and actual phone viewer, not a mounted component.
// Evidence must remain collapsed until requested, render as plain text, retain
// uncertainty, and close on navigation without changing graph membership.
test('phone recipient can inspect source-backed model reviews', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const quote = 'Who pays? <b>Still unresolved.</b>';
  const nodes = ['a', 'b'].map((id, index) => ({ id, chunk_id: 'c', thread_id: 't',
    semantic_level: 1, level: 1, semantic_type: 'moment', node_name: `Moment ${id}`,
    summary: 'An unresolved inquiry', timestamp_start: index * 10,
    utterance_ids: ['u'], children_ids: [] }));
  const artifact = { format: 'lct.threads', format_version: 2,
    edge_schema: { version: 1, directed: true, endpoint_space: 'graph_data.id' }, edges: [],
    conversation_id: 'source-review-browser-fixture', conversation_title: 'Source review fixture',
    graph_data: nodes, chunk_dict: { c: quote }, utterances: [{ id: 'u', text: quote }],
    thread_identity_reviews: { schema_version: 1, policies: [{ policy_fingerprint: 'browser-policy', annotations: [{
      pair: ['a', 'b'], judgment: 'uncertain', rationale: 'Insufficient context.', accepted_for_projection: false,
      nodes: nodes.map((node) => ({ node_id: node.id, thread_id: 't', source_id: 's' })),
      sources: [{ source_id: 's', chunk_id: 'c', utterance_ids: ['u'], text: quote }],
      evidence: nodes.map((node) => ({ node_id: node.id, source_id: 's', quote, start: 0, end: Array.from(quote).length })),
    }] }] } };
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/view');
  await page.locator('input[type="file"]').setInputFiles({ name: 'review.threads', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(artifact)) });
  const card = page.getByTestId('mobile-deck-card');
  await expect(card).toBeVisible();
  const disclosure = card.getByRole('button', { name: 'Source reviews (1)', exact: true });
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(card).toContainText('Model interpretation, not human-verified');
  await expect(card).toContainText('Thread relationship: uncertain');
  await expect(card.locator('blockquote').first()).toHaveText(quote);
  await expect(card.locator('blockquote b')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('phone-source-review.png'), fullPage: true });
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 375);
  await page.getByRole('button', { name: 'Next moment', exact: true }).click();
  await expect(card).toContainText('Moment b');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  expect(errors).toEqual([]);
});
