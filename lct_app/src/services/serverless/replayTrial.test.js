// @vitest-environment node
// Intent: tests/intent/twenty-minute-replay.md. Actual isolated SQLite; synthetic providers only.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../../sites/worker.js';
const SITE='https://replay-fixture.example', BASE='/api/cloud/replay-trial';
const ID='12345678-1234-4123-8123-123456789abc', OTHER='22345678-1234-4123-8123-123456789abc';
const response=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json'}});
let db,env,calls,credit,failMint,failMap,holdMap,releaseMap;
const attempts=()=>db.prepare('SELECT * FROM lct_audio_replay_attempts ORDER BY sequence').all();
const trial=()=>db.prepare('SELECT * FROM lct_audio_replay_trial').get();
const source=(complete=false)=>({recordingId:ID,startedAt:1000,complete,finalTokens:[{text:'A synthetic garden plan.',speaker:'1',startMs:0,endMs:1000}]});
const graph=()=>({metadata:{conversation_title:'Garden',executive_summary:'Synthetic'},nodes:[{id:'moment',semantic_level:1,semantic_type:'chunk',node_name:'Garden plan',source_ref:{utterance_ids:['utterance-0001']},source_excerpt:''}],edges:[],conversation_threads:[]});
const req=(path,method='GET',body,headers={})=>new Request(SITE+BASE+path,{method,headers:{origin:SITE,'oai-authenticated-user-id':'synthetic-owner','content-type':'application/json','x-lct-replay-consent':'replay-v1','x-lct-replay-request':crypto.randomUUID(),'x-lct-replay-sequence':'0',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
const run=(...args)=>worker.fetch(req(...args),env);
const mint=()=>run('/session','POST',{});
const map=(n,complete=false,headers={})=>run('/generate','POST',{source:source(complete),phase:complete?'final':'periodic'},{'x-lct-replay-sequence':String(n),...headers});
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(Date.UTC(2026,9,27)); db=new DatabaseSync(':memory:');calls=[];credit=100;failMint=false;failMap=false;holdMap=false;
 const journal=JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json',import.meta.url),'utf8'));
 for(const e of journal.entries)db.exec(readFileSync(new URL('../../../drizzle/'+e.tag+'.sql',import.meta.url),'utf8'));
 db.prepare('INSERT INTO lct_openrouter_attempts (id,created_at,max_output_tokens) VALUES (?,1,8192)').run('old-holder');
 env={LCT_MEETINGS_OWNER:'chatgpt:synthetic-owner',LCT_REPLAY_TEST_RECORDING_ID:ID,LCT_REPLAY_TEST_ENABLED:'true',LCT_REPLAY_TEST_END:new Date(Date.now()+1800000).toISOString(),
 LCT_OPENROUTER_ENABLED:'true',LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED:'true',LCT_OPENROUTER_MODEL:'google/synthetic-model',LCT_OPENROUTER_PROVIDER:'google-vertex',LCT_OPENROUTER_DATA_COLLECTION:'deny',LCT_OPENROUTER_AUDIENCE:'public',LCT_OPENROUTER_MAX_REQUESTS:'20',LCT_OPENROUTER_MAX_OUTPUT_TOKENS:'8192',OPENROUTER_API_KEY:'SYNTHETIC-OWNER-KEY',
 LCT_SONIOX_ENABLED:'true',LCT_SONIOX_PROJECT_BUDGET_CONFIRMED:'true',LCT_SONIOX_MAX_SESSION_SECONDS:'300',LCT_SONIOX_MAX_SESSIONS:'20',LCT_SONIOX_AUDIENCE:'public',SONIOX_API_KEY:'SYNTHETIC-STT-KEY',
 DB:{prepare(sql){let args=[];return {bind(...x){args=x;return this;},async first(){return db.prepare(sql).get(...args)||null;},async run(){return db.prepare(sql).run(...args);},async all(){return {results:db.prepare(sql).all(...args)};}};}}};
 vi.stubGlobal('fetch',vi.fn(async(url,options={})=>{
 calls.push({url,options});
 if(url.endsWith('/key'))return response({data:{limit_remaining:credit,limit:credit}});
 if(url.endsWith('/credits'))return response({data:{total_credits:credit,total_usage:0}});
 if(url.endsWith('/endpoints'))return response({data:{endpoints:[{tag:'google-vertex/global',pricing:{prompt:'0.0000003',completion:'0.0000025'}}]}});
 if(url.includes('temporary-api-key')){if(failMint)throw new Error('SYNTHETIC-STT-KEY');return response({api_key:'snx_temp_SYNTHETIC_ONLY',expires_at:new Date(Date.now()+60000).toISOString()},201);}
 if(failMap)return response({error:'private refusal'},502);
 if(holdMap)await new Promise(resolve=>{releaseMap=resolve;});
 return response({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(graph())}}]});
 }));
});
afterEach(()=>{db.close();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('private one-time long replay',()=>{
 it('refuses guests, another account and cross-origin writes without provider calls',async()=>{
  expect((await run('/status','GET',undefined,{'oai-authenticated-user-id':''})).status).toBe(401);
  expect((await run('/preflight','GET',undefined,{'oai-authenticated-user-id':'other'})).status).toBe(403);
  expect((await run('/session','POST',{}, {origin:'https://other.example'})).status).toBe(403);expect(calls).toHaveLength(0);expect(trial()).toBeUndefined();
 });
 it('preflights privately with no key material or reservation, and preserves original budgets',async()=>{
  const x=await (await run('/preflight')).json();expect(x.sufficient).toBe(true);expect(JSON.stringify(x)).not.toContain('SYNTHETIC');expect(trial()).toBeUndefined();
  expect((await (await run('/status')).json()).max_session_seconds).toBe(1200);
  const normal=await worker.fetch(new Request(SITE+'/api/cloud/soniox/status'),env);expect((await normal.json()).max_session_seconds).toBe(300);
  expect(db.prepare('SELECT COUNT(*) n FROM lct_openrouter_attempts').get().n).toBe(1);
 });
 it('refuses insufficient credit and a closed window before any paid operation',async()=>{
  credit=0.01;expect((await mint()).status).toBe(409);expect(trial()).toBeUndefined();
  env.LCT_REPLAY_TEST_ENABLED='false';expect((await mint()).status).toBe(409);expect(calls.filter(c=>c.options.method==='POST')).toHaveLength(0);
 });
 it('mints one bounded single-use key and refuses a second start',async()=>{
  expect((await mint()).status).toBe(201);const c=calls.find(c=>c.url.includes('temporary-api-key'));expect(JSON.parse(c.options.body)).toMatchObject({single_use:true,max_session_duration_seconds:1260});
  expect((await mint()).status).toBe(409);expect(calls.filter(c=>c.url.includes('temporary-api-key'))).toHaveLength(1);expect(attempts()).toHaveLength(1);
 });
 it('retains an uncertain mint and latches the trial closed without leaking upstream errors',async()=>{
  failMint=true;const r=await mint();expect(r.status).toBe(503);expect(await r.text()).not.toContain('SYNTHETIC');expect(trial().state).toBe('failed');expect(attempts()[0].state).toBe('uncertain');expect((await mint()).status).toBe(409);
 });
 it('serializes maps, retains source identity and never modifies the old holder',async()=>{
  const old=db.prepare('SELECT * FROM lct_openrouter_attempts').all();await mint();expect((await map(2)).status).toBe(409);
  const r=await map(1);expect(r.status).toBe(200);const body=await r.json();expect(body.artifact.conversation_id).toBe(ID);expect(body.artifact.transcription_complete).toBe(false);
  expect((await map(1)).status).toBe(409);expect(db.prepare('SELECT * FROM lct_openrouter_attempts').all()).toEqual(old);expect(attempts()).toHaveLength(2);
 });
 it('admits at most one concurrent model request and makes a final attempt terminal for future maps',async()=>{
  await mint();holdMap=true;const pending=map(1);await vi.advanceTimersByTimeAsync(1);expect((await map(1)).status).toBe(409);releaseMap();expect((await pending).status).toBe(200);
  holdMap=false;await vi.advanceTimersByTimeAsync(45001);expect((await map(2,true)).status).toBe(200);await vi.advanceTimersByTimeAsync(45001);expect((await map(3)).status).toBe(409);
 });
 it('enforces27periodic plus one final and closes on model refusal',async()=>{
  await mint();for(let i=1;i<=27;i++){expect((await map(i)).status).toBe(200);await vi.advanceTimersByTimeAsync(45001);}
  expect((await map(28)).status).toBe(409);expect((await map(28,true)).status).toBe(200);expect(attempts().filter(x=>x.kind==='map')).toHaveLength(28);
 });
 it('stops after provider refusal, retaining the spent operation',async()=>{
  await mint();failMap=true;expect((await map(1)).status).toBe(502);expect(trial().state).toBe('failed');expect(attempts().at(-1).state).toBe('uncertain');await vi.advanceTimersByTimeAsync(45001);expect((await map(2)).status).toBe(409);
 });
 it('refuses rearming an expired/spent singleton and supports an explicit close without deletion',async()=>{
  await mint();await vi.advanceTimersByTimeAsync(1500001);expect((await map(1)).status).toBe(409);env.LCT_REPLAY_TEST_END=new Date(Date.now()+1800000).toISOString();expect((await mint()).status).toBe(409);
  expect((await run('/close','POST',{})).status).toBe(200);expect(attempts()).toHaveLength(1);expect(trial().state).toBe('failed');
 });
});


it('latches a committed-but-unacknowledged dispatch without a provider call',async()=>{
 await mint();const original=env.DB.prepare;let inject=true;
 env.DB.prepare=sql=>{const statement=original(sql);if(sql.startsWith("UPDATE lct_audio_replay_attempts SET state = 'dispatching'")){const first=statement.first;statement.first=async()=>{const result=await first();if(inject){inject=false;throw new Error('synthetic lost acknowledgement');}return result;};}return statement;};
 const before=calls.filter(c=>c.url.includes('/chat/completions')).length;
 expect((await map(1)).status).toBe(503);expect(trial().state).toBe('failed');expect(attempts().at(-1).state).toBe('uncertain');
 expect(calls.filter(c=>c.url.includes('/chat/completions'))).toHaveLength(before);expect((await map(2)).status).toBe(409);
});
it('refuses a substituted recording and oversized model input without a model call',async()=>{
 await mint();const swapped={...source(),recordingId:OTHER};
 expect((await run('/generate','POST',{source:swapped,phase:'periodic'},{'x-lct-replay-sequence':'1'})).status).toBe(400);
 const huge={...source(),finalTokens:[{text:'x'.repeat(140000),speaker:'1',startMs:0,endMs:1000}]};
 expect((await run('/generate','POST',{source:huge,phase:'periodic'},{'x-lct-replay-sequence':'1'})).status).toBe(413);
 expect(attempts()).toHaveLength(1);expect(calls.filter(c=>c.url.includes('/chat/completions'))).toHaveLength(0);
});
it('bounds an uncertain provider response and never retries under a new sequence',async()=>{
 await mint();holdMap=true;const pending=map(1);await vi.advanceTimersByTimeAsync(95001);
 expect((await pending).status).toBe(408);expect(trial().state).toBe('failed');expect(attempts().at(-1).state).toBe('uncertain');
 releaseMap();await vi.advanceTimersByTimeAsync(1);expect((await map(2)).status).toBe(409);
});
it('preserves every earlier schema and row in the append-only trial migration',()=>{
 const previous=JSON.parse(readFileSync(new URL('../../../drizzle/meta/0017_snapshot.json',import.meta.url),'utf8'));
 const current=JSON.parse(readFileSync(new URL('../../../drizzle/meta/0018_snapshot.json',import.meta.url),'utf8'));
 expect(current.prevId).toBe(previous.id);for(const [name,table]of Object.entries(previous.tables))expect(current.tables[name]).toEqual(table);
 expect(Object.keys(current.tables).filter(n=>!Object.hasOwn(previous.tables,n)).sort()).toEqual(['lct_audio_replay_attempts','lct_audio_replay_trial']);
 expect(db.prepare('SELECT max_output_tokens,completed_at,recovery_released_at FROM lct_openrouter_attempts').all()).toEqual([{max_output_tokens:8192,completed_at:null,recovery_released_at:null}]);
});
