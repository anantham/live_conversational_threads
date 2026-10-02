import { expect, test } from '@playwright/test';

// Intent: populated synthetic hierarchy + 14 authored threads + an unassigned
// lane; prove lower plots, overlapping membership, history, aliases and pane bounds
// through normal interactions. The SDK fixture proves seek wiring, not live playback.
// History arrows retain readable icon geometry while disabled, stay compact on
// desktop, keep phone touch targets, and hold their position when enabled.
function artifact(video = false) {
  const utterances = Array.from({length:21}, (_, i) => [
    {id:`u${i}a`,speaker_id:'SPEAKER_00',text:`Synthetic explanation ${i+1}. `.repeat(8),timestamp_start:i*15,timestamp_end:i*15+9},
    {id:`u${i}b`,speaker_id:'SPEAKER_01',text:`Synthetic reply ${i+1}.`,timestamp_start:i*15+9,timestamp_end:i*15+10},
  ]).flat();
  const moments = Array.from({length:21}, (_, i) => ({
    id:`m${i}`,semantic_level:1,level:1,semantic_type:'moment',parent_id:'idea',node_name:`Fixture moment ${i+1}`,
    summary:`Synthetic summary ${i+1}`,source_excerpt:utterances[i*2].text,speaker_id:'SPEAKER_00',
    utterance_ids:[`u${i}a`,`u${i}b`],timestamp_start:i*15,timestamp_end:i*15+10,
  }));
  const threads = Array.from({length:14}, (_, i) => {
    const ids = i===0 ? Array.from({length:7},(_,n)=>n) : i===13 ? [1,19] : [i+6];
    return {id:`t${i}`,title:`Synthetic thread ${i+1}`,steps:ids.map(n=>({moment_id:`m${n}`,evidence_utterance_ids:[`u${n}a`,`u${n}b`]}))};
  });
  moments.forEach(moment=>{
    moment.thread_ids=threads.filter(thread=>thread.steps.some(step=>step.moment_id===moment.id)).map(thread=>thread.id);
    moment.thread_id=moment.thread_ids[0];
  });
  return {format:'lct.threads',format_version:2,conversation_id:'continuity-synthetic',conversation_title:'Synthetic exploration',
    executive_summary:'An overview for the synthetic navigation fixture.',chunk_dict:{},utterances,
    full_transcript:utterances.map(u=>`[${u.speaker_id}] ${u.text}`).join('\n'),conversation_threads:threads,
    media_refs:video ? [{provider:'youtube',video_id:'ABCDEFGHIJK',view_url:'https://www.youtube.com/watch?v=ABCDEFGHIJK',time_unit:'seconds'}] : [],
    edges:[],edge_schema:{version:1,directed:true,endpoint_space:'graph_data.id'},graph_data:[
      {id:'arc',semantic_level:5,semantic_type:'arc',node_name:'Synthetic arc',children_ids:['theme']},
      {id:'theme',semantic_level:4,semantic_type:'theme',parent_id:'arc',node_name:'Synthetic theme',children_ids:['topic']},
      {id:'topic',semantic_level:3,semantic_type:'topic',parent_id:'theme',node_name:'Synthetic topic',children_ids:['idea']},
      {id:'idea',semantic_level:2,semantic_type:'idea',parent_id:'topic',node_name:'Synthetic idea',children_ids:moments.map(n=>n.id)},...moments,
    ]};
}

async function open(page, video = false) {
  const errors: string[] = [], backend: string[] = [];
  page.on('pageerror', e=>errors.push(e.message));
  page.on('request', r=>{if(new URL(r.url()).pathname.startsWith('/api/'))backend.push(r.url());});
  await page.addInitScript(() => {
    window.__MG_DEBUG__=false;
    window.__viewerCue=0;
    window.YT={Player:function(host,options){
      const iframe=document.createElement('iframe');host.replaceWith(iframe);
      let seconds=0;
      const player={getIframe:()=>iframe,getCurrentTime:()=>seconds,getPlayerState:()=>5,
        cueVideoById:({startSeconds})=>{seconds=startSeconds;window.__viewerCue=seconds;},
        seekTo:value=>{seconds=value;window.__viewerCue=seconds;},destroy:()=>iframe.remove()};
      queueMicrotask(()=>options.events.onReady());return player;
    }};
  });
  await page.goto('/view');
  await page.locator('input[type=file]').setInputFiles({name:'continuity.threads',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(artifact(video)))});
  await expect(page.getByRole('heading',{name:'Synthetic exploration'})).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Back',exact:true})).toBeDisabled();
  return {errors,backend};
}

const transform = (page) => page.locator('.react-flow__viewport').evaluate(el=>el.style.transform);
const firstThread = (page) => page.getByTestId('thread-label-gutter').getByRole('button',{name:/^Synthetic thread 1\b/}).first();
async function selectFirst(page) {
  await page.getByRole('button',{name:'Show thread timeline'}).click();
  const label=firstThread(page);await label.click();
  await label.locator('..').getByRole('button',{name:/Next node/}).click();
  await expect(page.getByRole('dialog').locator('h2')).toHaveText('Fixture moment 1');
}

for (const width of [1440,390,1024]) test(`navigation hints explain history and reading scope at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});const evidence=await open(page);
  const back=page.getByRole('button',{name:'Back',exact:true});
  const historyHelp=back.locator('..');
  await historyHelp.hover();
  let hint=page.getByRole('tooltip').filter({hasText:'exploration history'});
  await expect(hint).toContainText('No earlier exploration yet.');
  await hint.hover();await expect(hint).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.mouse.move(0,0);await historyHelp.focus();
  await expect(page.getByRole('tooltip')).toContainText('Alt + Left');
  const focusOutline=await historyHelp.evaluate(el=>{const style=getComputedStyle(el);return {visible:el.matches(':focus-visible'),style:style.outlineStyle,width:parseFloat(style.outlineWidth)};});
  expect(focusOutline.visible).toBe(true);expect(focusOutline.style).not.toBe('none');expect(focusOutline.width).toBeGreaterThan(0);
  await page.keyboard.press('Enter');await expect(back).toBeDisabled();
  await page.keyboard.press('Escape');await page.getByRole('button',{name:/^Conversation overview:/}).focus();
  await selectFirst(page);
  await page.getByRole('button',{name:'Source',exact:true}).click();
  await back.hover();hint=page.getByRole('tooltip').filter({hasText:'exploration history'});await expect(hint).toBeVisible();
  const box=await hint.boundingBox();expect(box.x).toBeGreaterThanOrEqual(8);expect(box.x+box.width).toBeLessThanOrEqual(width-8);
  expect(box.y).toBeGreaterThanOrEqual(8);expect(box.y+box.height).toBeLessThanOrEqual(892);
  await page.screenshot({path:test.info().outputPath('history-help-with-source-and-timeline.png')});
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'Source',exact:true}).click();
  await back.hover();await expect(page.getByRole('tooltip')).toBeVisible();
  // Source has focus while history help is hovered: Escape still closes details.
  await page.keyboard.press('Escape');await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('navigation',{name:/reading controls/})).toHaveCount(0);
  // Escape clears exploration selection as before. Re-enter the thread, then
  // use its explicit Close button to check the distinct retained-path behavior.
  const label=firstThread(page);await label.click();
  await label.locator('..').getByRole('button',{name:/Next node/}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  // Closing details keeps the seven-node thread path active; it must not claim
  // conversation scope when the populated conversation has twenty-one moments.
  const reading=page.getByRole('navigation',{name:'Selected thread reading controls'});
  await expect(reading).toContainText('7 moments');
  const next=reading.getByRole('button',{name:'Next moment in selected thread'});
  await next.hover();hint=page.getByRole('tooltip').filter({hasText:'Next moment in this thread.'});await expect(hint).toBeVisible();
  const readingBox=await hint.boundingBox();expect(readingBox.x).toBeGreaterThanOrEqual(8);expect(readingBox.x+readingBox.width).toBeLessThanOrEqual(width-8);
  await page.screenshot({path:test.info().outputPath('thread-reading-help.png')});
  await next.click();await expect(page.getByRole('dialog').locator('h2')).toHaveText('Fixture moment 1');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');await expect(page.getByRole('dialog').locator('h2')).toHaveText('Fixture moment 2');
  await back.click();await expect(page.getByRole('dialog').locator('h2')).toHaveText('Fixture moment 1');
  const timeline=page.getByTestId('timeline-lane-viewport');
  await timeline.evaluate(el=>{el.scrollTop=el.scrollHeight;el.scrollLeft=el.scrollWidth;});
  await timeline.getByRole('button',{name:/Fixture moment 21/}).click();
  await expect(page.getByRole('dialog').locator('h2')).toHaveText('Fixture moment 21');
  const conversation=page.getByRole('navigation',{name:'Conversation reading controls'});
  await expect(conversation).toContainText('21 of 21');
  const last=conversation.getByRole('button',{name:'Next moment in conversation'});await expect(last).toBeDisabled();
  await last.locator('..').focus();
  await expect(page.getByRole('tooltip')).toContainText('Next moment in this conversation.');
  await expect(page.getByRole('tooltip')).toContainText('You’re at the last moment.');
  await page.keyboard.press('Escape');await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(page.getByRole('dialog').locator('h2')).toHaveText('Fixture moment 21');
  expect(evidence.errors).toEqual([]);expect(evidence.backend).toEqual([]);
});

for (const width of [1440,390]) test(`history arrows stay readable and compact at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});const evidence=await open(page);
  const navigation=page.getByRole('navigation',{name:'Exploration history'});
  const back=navigation.getByRole('button',{name:'Back',exact:true});
  const forward=navigation.getByRole('button',{name:'Forward',exact:true});
  await expect(back).toBeDisabled();await expect(forward).toBeDisabled();
  const firstBounds=await navigation.boundingBox();
  if(width>=640) expect(firstBounds.width).toBeLessThanOrEqual(52);
  for(const button of [back,forward]){
    const geometry=await button.evaluate(el=>{
      const icon=el.querySelector('svg').getBoundingClientRect(),box=el.getBoundingClientRect();
      return {iconWidth:icon.width,iconHeight:icon.height,opacity:Number(getComputedStyle(el).opacity),width:box.width,height:box.height};
    });
    expect(geometry.iconWidth).toBeGreaterThanOrEqual(16);
    expect(geometry.iconHeight).toBeGreaterThanOrEqual(16);
    expect(geometry.opacity).toBe(1);
    if(width<640){expect(geometry.width).toBeGreaterThanOrEqual(44);expect(geometry.height).toBeGreaterThanOrEqual(44);}
  }
  await page.screenshot({path:test.info().outputPath('disabled-history-arrows.png')});
  await selectFirst(page);await expect(back).toBeEnabled();
  expect((await navigation.boundingBox()).width).toBe(firstBounds.width);
  await page.keyboard.press('ArrowRight');await expect(page.getByRole('dialog').locator('h2')).toHaveText('Fixture moment 2');
  await back.click();await expect(page.getByRole('dialog').locator('h2')).toHaveText('Fixture moment 1');
  await forward.click();await expect(page.getByRole('dialog').locator('h2')).toHaveText('Fixture moment 2');
  await page.keyboard.press('Alt+ArrowLeft');await expect(page.getByRole('dialog').locator('h2')).toHaveText('Fixture moment 1');
  expect(evidence.errors).toEqual([]);expect(evidence.backend).toEqual([]);
});

for (const width of [1440,390]) test(`last timeline lane remains aligned and clickable at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});const evidence=await open(page);
  await page.getByRole('button',{name:'Show thread timeline'}).click();
  await expect(page.getByRole('button',{name:/Hide thread timeline/}).locator('..')).toContainText('14 threads');
  const viewport=page.getByTestId('timeline-lane-viewport');
  await expect(viewport.getByTestId('thread-label-gutter').getByRole('button')).toHaveCount(15);
  await viewport.evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await page.locator('[data-viewer-scroll="timeline-x"]').evaluate(el=>{el.scrollLeft=el.scrollWidth;});
  const label=viewport.getByTestId('thread-label-gutter').getByRole('button',{name:/ungrouped/});
  const last=viewport.getByRole('button',{name:/Fixture moment 21/});
  await expect(last).toBeVisible();
  // Sample both centers in one layout frame and wait for the allocated pane to settle.
  await expect.poll(()=>label.evaluate(el=>{
    const a=el.getBoundingClientRect();
    const b=el.closest('[data-testid="timeline-lane-viewport"]').querySelector('button[aria-label*="Fixture moment 21"]').getBoundingClientRect();
    return Math.abs(a.y+a.height/2-b.y-b.height/2);
  })).toBeLessThan(2);
  const b=await last.boundingBox(), v=await viewport.boundingBox();
  expect(b.y).toBeGreaterThanOrEqual(v.y-1);expect(b.y+b.height).toBeLessThanOrEqual(v.y+v.height+1);
  await last.click();await expect(page.getByRole('dialog').locator('h2')).toHaveText('Fixture moment 21');
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Expand lanes',exact:true}).click();
  expect((await viewport.boundingBox()).height).toBeGreaterThan(v.height);
  const plot=page.locator('.react-flow');expect((await plot.boundingBox()).height).toBeGreaterThan(80);
  await page.screenshot({path:test.info().outputPath('expanded-final-lanes.png')});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  expect(evidence.errors).toEqual([]);expect(evidence.backend).toEqual([]);
});

for (const width of [1440,390]) test(`history restores thread, card, view and source position at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});const evidence=await open(page,true);
  await selectFirst(page);
  const dialog=page.getByRole('dialog');
  const toolbar=await page.getByRole('toolbar',{name:'Conversation tools'}).boundingBox();
  const bounds=await dialog.boundingBox();expect(bounds.y).toBeGreaterThanOrEqual(toolbar.y+toolbar.height-1);
  const detailScroll=dialog.locator('[data-viewer-scroll="node-detail"]');
  await detailScroll.evaluate(el=>{el.scrollTop=200;});
  const firstScroll=await detailScroll.evaluate(el=>el.scrollTop);expect(firstScroll).toBeGreaterThan(0);
  await page.keyboard.press('ArrowRight');await expect(dialog.locator('h2')).toHaveText('Fixture moment 2');
  await detailScroll.evaluate(el=>{el.scrollTop=20;});
  await page.getByRole('button',{name:'Back',exact:true}).click();await expect(dialog.locator('h2')).toHaveText('Fixture moment 1');
  await expect.poll(()=>detailScroll.evaluate(el=>el.scrollTop)).toBe(firstScroll);
  await page.goForward();await expect(dialog.locator('h2')).toHaveText('Fixture moment 2');
  await expect.poll(()=>detailScroll.evaluate(el=>el.scrollTop)).toBe(20);
  await dialog.locator('button[title="Seek the inline recording"]').filter({hasText:'0:15'}).click();
  const source=page.getByRole('complementary',{name:'YouTube source'});
  await expect(source).toBeVisible();await expect.poll(()=>page.evaluate(()=>window.__viewerCue)).toBe(15);
  await source.getByRole('button',{name:/Synthetic explanation 4/}).click();
  await expect.poll(()=>page.evaluate(()=>window.__viewerCue)).toBe(45);
  await page.getByRole('button',{name:'Back',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.__viewerCue)).toBe(15);
  await source.getByRole('button',{name:'Hide source panel'}).click();
  await page.getByRole('button',{name:/Current view: Graph\. Switch to Discussion/}).click();
  const discussion=page.getByRole('region',{name:'Discussion'});await expect(discussion).toBeVisible();
  await discussion.getByRole('button',{name:/Synthetic arc/}).first().click();
  await expect(discussion.getByRole('button',{name:/Synthetic theme/}).first()).toBeVisible();
  await page.getByRole('button',{name:'Back',exact:true}).click();await expect(discussion.getByRole('button',{name:/Synthetic theme/})).toHaveCount(0);
  await page.getByRole('button',{name:'Back',exact:true}).click();await expect(page.locator('.react-flow')).toBeVisible();
  await expect(page.getByRole('dialog').locator('h2')).toHaveText('Fixture moment 2');
  expect(evidence.errors).toEqual([]);expect(evidence.backend).toEqual([]);
});

test('speaker names update cards, details, full transcript, passages and Discussion and survive Back',async({page})=>{
  await page.setViewportSize({width:1440,height:900});const evidence=await open(page);
  await selectFirst(page);
  await page.getByRole('button',{name:'Source',exact:true}).click();
  const source=page.getByRole('complementary',{name:'Text source'});
  await source.getByText('Name the speakers',{exact:true}).click();
  await source.getByLabel('Speaker name',{exact:true}).fill('Example author');await source.getByRole('button',{name:'Apply name',exact:true}).click();
  await expect(page.locator('.react-flow__node').first()).toContainText('Example author 90%');
  await expect(page.getByRole('dialog')).toContainText('Example author');
  await expect(source.locator('pre [data-speaker-id="SPEAKER_00"]').first()).toHaveText('Example author');
  await source.getByRole('button',{name:'Passages',exact:true}).click();await expect(source.getByLabel('Original source passages')).toContainText('Example author');
  await source.getByRole('button',{name:'Hide source',exact:true}).click();
  await page.getByRole('button',{name:/Current view: Graph\. Switch to Discussion/}).click();
  await expect(page.getByRole('group',{name:'Speaker colors'})).toContainText('Example author');
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await expect(page.locator('.react-flow__node').first()).toContainText('Example author 90%');
  expect(evidence.errors).toEqual([]);expect(evidence.backend).toEqual([]);
});

test('hierarchy and manually panned camera return through Back/Forward',async({page})=>{
  await page.setViewportSize({width:1440,height:900});const evidence=await open(page);
  await page.locator('.react-flow__node').getByRole('button',{name:'Expand 1 item',exact:true}).click();
  await expect(page.locator('.react-flow__node')).toContainText('Synthetic theme');
  const canvas=await page.locator('.react-flow').boundingBox();
  await page.mouse.move(canvas.x+canvas.width-180,canvas.y+canvas.height-100);await page.mouse.down();
  await page.mouse.move(canvas.x+canvas.width-100,canvas.y+canvas.height-80,{steps:5});await page.mouse.up();
  await expect.poll(()=>transform(page)).not.toBe('');const saved=await transform(page);
  await page.locator('.react-flow__node').getByRole('button',{name:'Expand 1 item',exact:true}).click();
  await expect(page.locator('.react-flow__node')).toContainText('Synthetic topic');
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await expect(page.locator('.react-flow__node')).toContainText('Synthetic theme');
  await expect.poll(()=>transform(page)).toBe(saved);
  await page.getByRole('button',{name:'Forward',exact:true}).click();await expect(page.locator('.react-flow__node')).toContainText('Synthetic topic');
  expect(evidence.errors).toEqual([]);expect(evidence.backend).toEqual([]);
});
