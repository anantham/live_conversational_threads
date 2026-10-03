import { expect, test } from '@playwright/test';

// Intent: public cards paint speaking-time colors instead of named percentage
// rows; actual Source/Legend naming and history keep exact identity accessible.
function artifact() {
  const utterances = [
    {id:'a0',speaker_id:'SPEAKER_00',text:'A synthetic explanation of the first question.',timestamp_start:0,timestamp_end:8},
    {id:'b0',speaker_id:'SPEAKER_01',text:'A synthetic response.',timestamp_start:8,timestamp_end:10},
    {id:'a1',speaker_id:'SPEAKER_00',text:'A longer synthetic explanation.',timestamp_start:20,timestamp_end:29},
    {id:'b1',speaker_id:'SPEAKER_01',text:'A brief acknowledgement.',timestamp_start:29,timestamp_end:30},
    {id:'a2',speaker_id:'SPEAKER_00',text:'This synthetic turn has no measured end.',timestamp_start:40},
    {id:'b2',speaker_id:'SPEAKER_01',text:'An additional timed turn.',timestamp_start:48,timestamp_end:50},
  ];
  const moments = [0,1,2].map(i=>({
    id:`m${i}`,semantic_level:1,semantic_type:'chunk',parent_id:'idea',
    node_name:`Synthetic thought ${i+1}`,summary:`Synthetic summary ${i+1}`,
    source_excerpt:utterances[i*2].text,speaker_id:'SPEAKER_00',
    utterance_ids:[`a${i}`,`b${i}`],thread_ids:['thread'],thread_id:'thread',
  }));
  return {
    format:'lct.threads',format_version:2,conversation_id:'color-only-synthetic',
    conversation_title:'Synthetic speaking colors',executive_summary:'A populated presentation fixture.',
    chunk_dict:{},utterances,full_transcript:utterances.map(u=>`[${u.speaker_id}] ${u.text}`).join('\n'),media_refs:[],
    conversation_threads:[{id:'thread',title:'Synthetic recurring question',steps:moments.map(m=>({moment_id:m.id,evidence_utterance_ids:m.utterance_ids}))}],
    edges:[],edge_schema:{version:1,directed:true,endpoint_space:'graph_data.id'},
    graph_data:[
      {id:'arc',semantic_level:5,semantic_type:'arc',node_name:'Synthetic arc',children_ids:['theme']},
      {id:'theme',semantic_level:4,semantic_type:'theme',parent_id:'arc',node_name:'Synthetic theme',children_ids:['topic']},
      {id:'topic',semantic_level:3,semantic_type:'topic',parent_id:'theme',node_name:'Synthetic topic',children_ids:['idea']},
      {id:'idea',semantic_level:2,semantic_type:'idea',parent_id:'topic',node_name:'Synthetic idea',children_ids:moments.map(m=>m.id)},
      ...moments,
    ],
  };
}

async function clippedText(card, text: string) {
  const alternative = card.getByText(text,{exact:true});
  await expect(alternative).toHaveCount(1);
  // Observable paint/flow, not merely presence of a utility class.
  await expect(alternative).toHaveCSS('position','absolute');
  await expect(alternative).toHaveCSS('clip-path','inset(50%)');
  await expect.poll(()=>alternative.evaluate(el=>el.getBoundingClientRect().width)).toBeLessThanOrEqual(1.5);
  expect(await card.ariaSnapshot()).toContain(text);
  await expect(card.getByRole('button',{name:'Open exact source utterances'})).toBeVisible();
}

for (const width of [1440,390]) test(`colors carry identity without a painted speaker row at ${width}px`,async({page})=>{
  const errors: string[]=[],backend: string[]=[],warnings: string[]=[],serverErrors: string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(['warning','error'].includes(m.type()))warnings.push(m.text());});
  page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))backend.push(r.url());});
  page.on('response',r=>{if(r.status()>=500)serverErrors.push(r.url());});
  await page.setViewportSize({width,height:900});
  await page.addInitScript(()=>{window.__MG_DEBUG__=false;});
  await page.goto('/view');
  await page.locator('input[type=file]').setInputFiles({name:'colors.threads',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(artifact()))});
  await expect(page.getByRole('heading',{name:'Synthetic speaking colors'})).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await clippedText(page.locator('.react-flow__node .lct-conversation-node'),'Speaking time unknown');
  await expect(page.getByRole('button',{name:'Show thread timeline'}).locator('..')).toContainText('1 thread');
  await page.getByRole('button',{name:'Show thread timeline'}).click();
  const thread=page.getByTestId('thread-label-gutter').getByRole('button',{name:/^Synthetic recurring question/});
  await thread.click();await thread.locator('..').getByRole('button',{name:/Next node/}).click();
  const card=(id:string)=>page.locator(`.react-flow__node[data-id="${id}"] .lct-conversation-node`);
  await expect(page.getByRole('dialog').locator('h2')).toHaveText('Synthetic thought 1');
  await clippedText(card('m0'),'SPEAKER_00 80% · SPEAKER_01 20%');
  const mixed=await card('m0').evaluate(el=>getComputedStyle(el).backgroundImage);
  expect(mixed).toContain('linear-gradient');expect(mixed).toContain('80%');
  const dominant=mixed.match(/rgba?\([^)]*\)/)?.[0];expect(dominant).toBeTruthy();
  await page.getByRole('button',{name:'Source',exact:true}).click();
  const source=page.getByRole('complementary',{name:'Text source'});
  await source.getByText('Name the speakers',{exact:true}).click();
  await source.getByLabel('Speaker name',{exact:true}).fill('Synthetic named voice');
  await source.getByRole('button',{name:'Apply name',exact:true}).click();
  await clippedText(card('m0'),'Synthetic named voice 80% · SPEAKER_01 20%');
  await expect(source.locator('pre [data-speaker-id="SPEAKER_00"]').first()).toHaveText('Synthetic named voice');
  await source.getByRole('button',{name:'Passages',exact:true}).click();
  await expect(source.getByLabel('Original source passages')).toContainText('Synthetic named voice');
  await source.getByRole('button',{name:'Hide source',exact:true}).click();
  await page.getByRole('button',{name:'Show legend: speakers and edge colors'}).click();
  const legend=page.getByRole('region',{name:'Speaker colors and edge key'});
  await expect(legend.getByText('Synthetic named voice',{exact:true})).toBeVisible();
  await legend.getByRole('button',{name:'Close legend',exact:true}).click();
  await page.screenshot({path:test.info().outputPath('mixed-colors-no-speaker-row.png')});
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog').locator('h2')).toHaveText('Synthetic thought 2');
  await clippedText(card('m1'),'Synthetic named voice 90% · SPEAKER_01 10%');
  await expect(card('m1')).toHaveCSS('background-image','none');
  await expect(card('m1')).toHaveCSS('background-color',dominant);
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await expect(page.getByRole('dialog').locator('h2')).toHaveText('Synthetic thought 1');
  await clippedText(card('m0'),'Synthetic named voice 80% · SPEAKER_01 20%');
  await expect(card('m0')).toHaveCSS('background-image',mixed);
  await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog').locator('h2')).toHaveText('Synthetic thought 3');
  await clippedText(card('m2'),'Speaking time unknown');
  await expect(card('m2')).toHaveCSS('background-image','none');
  await expect(card('m2')).toHaveCSS('background-color','rgb(241, 245, 249)');
  await page.getByText('Display',{exact:true}).click();
  await page.getByRole('button',{name:'Color: Speaker (click to cycle)',exact:true}).click();
  await expect(page.getByRole('button',{name:'Color: Time (click to cycle)',exact:true})).toBeVisible();
  await expect(card('m2')).not.toHaveCSS('background-color','rgb(241, 245, 249)');
  await clippedText(card('m2'),'Speaking time unknown');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  expect(errors).toEqual([]);expect(backend).toEqual([]);expect(warnings).toEqual([]);expect(serverErrors).toEqual([]);
});
