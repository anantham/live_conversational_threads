import { expect, test } from '@playwright/test';

// Intent: exercise the whole selected thread with details open, readable geometry,
// evidence-to-Source handoff, and the single view cycle. Synthetic content only.
function artifact() {
  const utterances = Array.from({length: 7}, (_, index) => [
    {id: `u${index}a`, speaker_id: 'SPEAKER_00', text: `Synthetic explanation ${index + 1}. `.repeat(25), timestamp_start: index * 10, timestamp_end: index * 10 + 9},
    {id: `u${index}b`, speaker_id: 'SPEAKER_01', text: 'Synthetic acknowledgement.', timestamp_start: index * 10 + 9, timestamp_end: index * 10 + 10},
  ]).flat();
  return {
    format: 'lct.threads', format_version: 2, conversation_id: 'reading-regression', conversation_title: 'Synthetic reading regression',
    media_refs: [{provider: 'youtube', video_id: 'ABCDEFGHIJK', view_url: 'https://www.youtube.com/watch?v=ABCDEFGHIJK', time_unit: 'seconds'}],
    utterances, edges: [], edge_schema: {version:1, directed:true, endpoint_space:'graph_data.id'}, chunk_dict: {},
    conversation_threads: [{id: 'thread', title: 'Synthetic seven-moment thread', steps: Array.from({length:7}, (_, index) => ({moment_id:`m${index}`, evidence_utterance_ids:[`u${index}a`, `u${index}b`]}))}],
    graph_data: Array.from({length: 7}, (_, index) => ({
      id: `m${index}`, semantic_level: 1, level: 1, semantic_type: 'moment', node_name: `Fixture moment ${index + 1}`,
      summary: `Synthetic summary ${index + 1}`, source_excerpt: utterances[index * 2].text,
      utterance_ids: [`u${index}a`, `u${index}b`], thread_ids: ['thread'], timestamp_start: index * 10, timestamp_end: index * 10 + 10,
    })),
  };
}

test('reads seven moments by keyboard and opens a closed Source at the evidence time', async ({page}) => {
  await page.setViewportSize({width: 1440, height: 900});
  await page.addInitScript(() => {
    window.__MG_DEBUG__ = false;
    window.YT = {Player: function(host, config) {
      let seconds = 0;
      const iframe = document.createElement('iframe'); host.replaceWith(iframe);
      const player = {getPlayerState: () => 5, getCurrentTime: () => seconds,
        cueVideoById: ({startSeconds}) => {seconds = startSeconds;}, seekTo: value => {seconds = value;},
        getIframe: () => iframe, destroy: () => iframe.remove()};
      queueMicrotask(() => config.events.onReady()); return player;
    }};
  });
  await page.goto('/view');
  await page.locator('input[type="file"]').setInputFiles({name:'synthetic.threads', mimeType:'application/json', buffer:Buffer.from(JSON.stringify(artifact()))});
  await expect(page.getByRole('heading', {name:'Synthetic reading regression'})).toBeVisible();
  await page.getByRole('button', {name:'Show thread timeline'}).click();
  const label = page.getByTestId('thread-label-gutter').getByRole('button', {name:/Synthetic seven-moment thread/}).first();
  await label.click();
  await label.locator('..').getByRole('button', {name:/Next node/}).click();
  const navigation = page.getByRole('navigation', {name:'Selected thread reading controls'});
  for (let index = 1; index <= 7; index += 1) {
    await expect(navigation).toContainText(`${index} of 7`);
    await expect(page.getByRole('dialog').locator('h2')).toHaveText(`Fixture moment ${index}`);
    if (index < 7) await page.keyboard.press('ArrowRight');
  }
  await expect(navigation.getByRole('button', {name:'Next moment in selected thread'})).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await expect(navigation).toContainText('6 of 7');
  const boxes = await page.locator('.react-flow__node').evaluateAll(elements => elements.map(element => {
    const r = element.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};
  }));
  for (let i=0;i<boxes.length;i++) for(let j=i+1;j<boxes.length;j++) {
    const a=boxes[i],b=boxes[j];
    expect(Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x) > 5 && Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y) > 5).toBe(false);
  }
  await expect(page.getByRole('complementary', {name:'YouTube source'})).toHaveCount(0);
  const timestamp = page.locator('button[title="Seek the inline recording"]').filter({hasText:'0:50'}).first();
  await timestamp.click();
  const source = page.getByRole('complementary', {name:'YouTube source'});
  await expect(source).toBeVisible();
  await expect(source.locator('[aria-current="true"]')).toContainText('Synthetic explanation 6');
  await expect(source.getByRole('link', {name:'Open on YouTube at 0:50'})).toHaveAttribute('href', /&t=50s$/);
  await expect(source.locator('[aria-label="Transcript height"]')).toHaveCount(0);
  await source.getByRole('button', {name:'Hide source panel'}).click();
  await page.getByRole('button', {name:/Current view: Graph\. Switch to Discussion/}).click();
  await expect(page.getByRole('region', {name:'Discussion'})).toBeVisible();
  await expect(page.getByRole('region', {name:'Discussion'}).locator('form')).toHaveCount(0);
  await page.getByRole('button', {name:/Current view: Discussion\. Switch to Graph/}).click();
  await expect(page.locator('.react-flow')).toBeVisible();
});

test('keeps the phone transcript and speaker editor in separate readable sections', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.addInitScript(() => {
    window.__MG_DEBUG__ = false;
    window.YT = {Player: function(host, config) {
      const iframe=document.createElement('iframe'); host.replaceWith(iframe);
      queueMicrotask(() => config.events.onReady());
      return {getPlayerState:()=>5, getCurrentTime:()=>0, cueVideoById:()=>{}, getIframe:()=>iframe, destroy:()=>iframe.remove()};
    }};
  });
  await page.goto('/view');
  await page.locator('input[type="file"]').setInputFiles({name:'synthetic.threads',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(artifact()))});
  await expect(page.getByRole('heading',{name:'Synthetic reading regression'})).toBeVisible();
  await page.getByRole('button',{name:'Source',exact:true}).click();
  const source=page.getByRole('complementary',{name:'YouTube source'});
  await source.getByText('Name the speakers',{exact:true}).click();
  await source.getByLabel('Speaker name',{exact:true}).fill('Example speaker');
  const passages=await source.getByLabel('Source passages',{exact:true}).boundingBox();
  const editor=await source.locator('details').filter({has:page.locator('input[aria-label="Speaker name"]')}).boundingBox();
  expect(passages.y+passages.height).toBeLessThanOrEqual(editor.y+1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(source.getByLabel('Selected speaker passages').getByRole('button')).toHaveCount(3);
});

// Intent: opening Source on a phone suspends the selected-node sheet, keeps the
// graph's floating controls inside its remaining space, and permits a real name edit
// while the timeline is expanded. Closing Source restores the selected detail.
test('keeps phone Source interactive with a selected moment and the timeline open', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.addInitScript(() => {
    window.__MG_DEBUG__=false;
    window.YT={Player:function(host,config){
      const iframe=document.createElement('iframe');host.replaceWith(iframe);
      queueMicrotask(()=>config.events.onReady());
      return {getPlayerState:()=>5,getCurrentTime:()=>0,cueVideoById:()=>{},getIframe:()=>iframe,destroy:()=>iframe.remove()};
    }};
  });
  await page.goto('/view');
  await page.locator('input[type="file"]').setInputFiles({name:'synthetic.threads',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(artifact()))});
  await page.getByRole('button',{name:'Show thread timeline'}).click();
  const label=page.getByTestId('thread-label-gutter').getByRole('button',{name:/Synthetic seven-moment thread/}).first();
  await label.click();
  await label.locator('..').getByRole('button',{name:/Next node/}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'Source',exact:true}).click();
  const source=page.getByRole('complementary',{name:'YouTube source'});
  await expect(source).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await source.getByText('Name the speakers',{exact:true}).click();
  await source.getByLabel('Speaker name',{exact:true}).fill('Phone example');
  await source.getByRole('button',{name:'Apply name',exact:true}).click();
  await expect(source.getByLabel('Speaker to name').locator('option:checked')).toHaveText('Phone example');
  const sourceBox=await source.boundingBox();
  const navigationBox=await page.getByRole('navigation',{name:'Selected thread reading controls'}).boundingBox();
  expect(navigationBox.y).toBeGreaterThanOrEqual(sourceBox.y+sourceBox.height-1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await source.getByRole('button',{name:'Hide source panel'}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').locator('h2')).toHaveText('Fixture moment 1');
});
