// Intent: tests/intent/twenty-minute-replay.md. Synthetic streamed page behavior; no real provider/data.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const f=vi.hoisted(()=>({writes:[],finish:null,cancelled:false,posts:[],held:false,release:null}));
vi.mock('../services/cloud/localConversationStore.js',()=>({readLocalConversation:async()=>null,saveLocalConversation:async(snapshot,chunks)=>{f.writes.push({snapshot,chunks});return 'revision-'+f.writes.length;}}));
vi.mock('../components/MinimalGraph.jsx',()=>({default:({graphData})=><div aria-label="Rendered replay graph">{graphData.map(n=><span key={n.id}>{n.node_name}</span>)}</div>}));
vi.mock('../services/cloud/AudioImportSession.js',()=>({AudioImportSession:class{
 constructor(c){this.c=c;}
 async start({file}){await this.c.requestSession({signal:new AbortController().signal});this.c.onAudio({blob:file,mimeType:'audio/mp4'});this.c.onStage({stage:'transcribing'});this.c.onTranscript(f.initial);return new Promise(resolve=>{f.finish=words=>{this.c.onTranscript(words);this.c.onStage({stage:'stopped'});resolve(words);};});}
 cancel(){f.cancelled=true;}
}}));
import SitesReplayTrial from './SitesReplayTrial.jsx';
import { createRecordingThreads } from '../services/cloud/recordingThreads.js';
const ID='12345678-1234-4123-8123-123456789abc';
let root,container;
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
const token=(text,end=1000)=>({text,speaker:'1',startMs:0,endMs:end});
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(Date.UTC(2026,9,27));globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 f.writes=[];f.posts=[];f.finish=null;f.cancelled=false;f.held=false;localStorage.clear();
 f.initial={finalText:'A synthetic garden discussion. '.repeat(5),partialText:'',partialTokens:[],finalTokens:[token('A synthetic garden discussion. '.repeat(5))]};
 vi.stubGlobal('URL',class extends URL{static createObjectURL=()=> 'blob:synthetic-replay';static revokeObjectURL(){};});
 vi.stubGlobal('fetch',vi.fn(async(url,options={})=>{
  if(url.endsWith('/status'))return json({enabled:true,configured:true,recording_id:ID,max_session_seconds:1200,trial:null,attempts:[]});
  if(url.endsWith('/preflight'))return json({sufficient:true,available_usd:100,required_usd:4});
  f.posts.push({url,options});
  if(url.endsWith('/session'))return json({api_key:'snx_temp_SYNTHETIC',expires_at:new Date(Date.now()+60000).toISOString(),session_id:crypto.randomUUID(),max_session_seconds:1260},201);
  if(url.endsWith('/close'))return json({closed:true});
  const {source}=JSON.parse(options.body);
  if(f.held)await new Promise(resolve=>{f.release=resolve;});
  const artifact=createRecordingThreads({...source,graph:{metadata:{conversation_title:'Garden'},nodes:[{id:'moment',semantic_level:1,semantic_type:'chunk',node_name:'Garden plan',source_ref:{utterance_ids:['utterance-0001']}}],edges:[],conversation_threads:[]}}).bundle;
  return json({request_id:crypto.randomUUID(),artifact});
 }));
 container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
const click=async name=>{await act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent===name).click());};
async function start(){
 await act(async()=>root.render(<MemoryRouter initialEntries={['/replay-test']}><SitesReplayTrial/></MemoryRouter>));
 await act(async()=>{const input=container.querySelector('#replay-file');Object.defineProperty(input,'files',{value:[new File(['synthetic original audio'],'prepared.m4a',{type:'audio/mp4'})]});input.dispatchEvent(new Event('change',{bubbles:true}));container.querySelector('input[type=checkbox]').click();});
 await click('Start approved replay');
}
it('renders serial live snapshots, reserves final catch-up and saves the completed local conversation',async()=>{
 await start();await act(async()=>vi.advanceTimersByTimeAsync(1001));
 expect(f.posts.filter(x=>x.url.endsWith('/generate'))).toHaveLength(1);expect(container.textContent).toContain('Garden plan');
 const words={...f.initial,finalTokens:[...f.initial.finalTokens,token(' More confirmed words. '.repeat(8),1200000)]};words.finalText=words.finalTokens.map(t=>t.text).join('');
 await act(async()=>f.finish(words));await act(async()=>vi.advanceTimersByTimeAsync(45001));await act(async()=>vi.advanceTimersByTimeAsync(300));
 const maps=f.posts.filter(x=>x.url.endsWith('/generate'));expect(maps).toHaveLength(2);
 expect(JSON.parse(maps[0].options.body).source.complete).toBe(false);expect(JSON.parse(maps[1].options.body).phase).toBe('final');
 expect(container.textContent).toContain('completed');expect(f.writes.at(-1).snapshot.map.transcription_complete).toBe(true);
 expect(f.writes.at(-1).snapshot.transcript.finalText).toBe(words.finalText);expect(f.writes.flatMap(x=>x.chunks)[0].blob.size).toBeGreaterThan(0);
 expect(f.posts.filter(x=>x.url.endsWith('/session'))).toHaveLength(1);expect(f.posts.filter(x=>x.url.endsWith('/close'))).toHaveLength(1);
 await act(async()=>vi.advanceTimersByTimeAsync(180000));expect(f.posts.filter(x=>x.url.endsWith('/generate'))).toHaveLength(2);
});
it('stops both sources and ignores a late model result without dispatching a final retry',async()=>{
 f.held=true;await start();await act(async()=>vi.advanceTimersByTimeAsync(1001));
 expect(f.posts.filter(x=>x.url.endsWith('/generate'))).toHaveLength(1);await click('Stop replay');
 await act(async()=>{f.release();f.finish(f.initial);});await act(async()=>vi.advanceTimersByTimeAsync(90000));
 expect(f.cancelled).toBe(true);expect(f.posts.filter(x=>x.url.endsWith('/generate'))).toHaveLength(1);
 expect(f.writes.at(-1).snapshot.map).toBeNull();expect(container.textContent).toContain('Replay stopped');
});
