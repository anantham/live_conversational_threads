import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compileThreadExperiment} from './compile_thread_experiment.mjs';
const base={conversation_id:'synthetic',utterances:[{id:'u1',text:'Example',timestamp_start:0,timestamp_end:2}],
  graph_data:[{id:'m',level:1,semantic_level:1,timestamp_start:0,utterance_ids:['u1']}]};
const edge_schema={version:1,directed:true,endpoint_space:'graph_data.id'};
const edge={id:'semantic-1',from_node_id:'m',to_node_id:'i1',edge_kind:'semantic',
  relation_type:'supports',source_utterance_ids:['u1'],explanation:'Source evidence'};
function input(){return {title:'Example',summary:'Synthetic',threads:[{id:'t',title:'Example thread',steps:[{moment_id:'m',evidence_indices:[1]}]}],groups:[
  {id:'i1',level:2,children:[{id:'m',why:'First angle'}]},
  {id:'i2',level:2,children:[{id:'m',why:'Second angle'}]},
  {id:'p',level:3,children:[{id:'i1',why:'A'},{id:'i2',why:'B'}]},
  {id:'h',level:4,children:[{id:'p',why:'C'}]},
  {id:'a',level:5,children:[{id:'h',why:'D'}]},
]};}
test('diamond memberships keep one source segment and two seconds of speech',()=>{
 const result=compileThreadExperiment(base,input());
 assert.equal(result.graph_data.find(n=>n.id==='m').memberships.length,2);
 const arc=result.graph_data.find(n=>n.id==='a');
 assert.equal(arc.provenance_metrics.utterance_count,1);
 assert.equal(arc.provenance_metrics.duration_seconds,2);
 assert.deepEqual(result.utterances,base.utterances);
});
test('reject missing children and invalid evidence',()=>{
 const bad=input();bad.groups[0].children[0].id='missing';assert.throws(()=>compileThreadExperiment(base,bad));
 const badEvidence=input();badEvidence.threads[0].steps[0].evidence_indices=[2];assert.throws(()=>compileThreadExperiment(base,badEvidence));
 const badTitle=input();delete badTitle.threads[0].title;assert.throws(()=>compileThreadExperiment(base,badTitle),/thread title/);
});

test('canonical edges retain identity, direction, and citations; returns only annotate threads',()=>{
 const source={...structuredClone(base),graph_data:[...structuredClone(base.graph_data),
   {id:'i1',level:2,semantic_level:2}],edge_schema,edges:[edge,
   {...edge,id:'semantic-2',from_node_id:'i1',to_node_id:'m',source_utterance_ids:['u1','u1']}],
   argument_topology:{status:'complete',semantic_edge_count:2,exhaustive:true}};
 const interpretation=input();
 interpretation.threads[0].returns=[];
 const before=structuredClone(source);
 const interpretationBefore=structuredClone(interpretation);
 const result=compileThreadExperiment(source,interpretation);
 assert.deepEqual(source,before);
 assert.deepEqual(interpretation,interpretationBefore);
 assert.deepEqual(result.edge_schema,edge_schema);
 assert.deepEqual(result.edges,source.edges);
 assert.equal(result.edges.length,2);
 assert.equal(result.argument_topology.status,'partial');
 assert.equal(result.argument_topology.exhaustive,false);
 assert.notEqual(result.argument_topology.semantic_edge_count,0);
 assert.deepEqual(result,compileThreadExperiment(source,interpretation));
});

test('a valid return remains metadata and does not manufacture an edge',()=>{
 const source={...structuredClone(base),utterances:[
   {id:'u1',text:'First',timestamp_start:0,timestamp_end:2},
   {id:'u2',text:'Later',timestamp_start:3,timestamp_end:4}],
   graph_data:[...structuredClone(base.graph_data),
     {id:'m2',level:1,semantic_level:1,timestamp_start:3,utterance_ids:['u2']}],
   edge_schema,edges:[]};
 const interpretation=input();
 interpretation.groups[0].children.push({id:'m2',why:'Later angle'});
 interpretation.threads[0].steps.push({moment_id:'m2',evidence_indices:[2]});
 interpretation.threads[0].returns=[{from:'m2',to:'m',kind:'explicit_callback',why:'A return',evidence_indices:[1,2]}];
 const result=compileThreadExperiment(source,interpretation);
 assert.deepEqual(result.edges,[]);
 assert.deepEqual(result.conversation_threads[0].returns[0].evidence_utterance_ids,['u1','u2']);
});

test('rejects canonical edges whose endpoint disappeared instead of silently dropping them',()=>{
 const source={...structuredClone(base),graph_data:[...structuredClone(base.graph_data),
   {id:'legacy-idea',level:2,semantic_level:2}],edge_schema,
   edges:[{...edge,to_node_id:'legacy-idea'}]};
 assert.throws(()=>compileThreadExperiment(source,input()),/semantic-1.*(unknown|endpoint|legacy-idea)/i);
});

test('legacy absent edge fields get an explicit empty contract; malformed explicit fields fail',()=>{
 const result=compileThreadExperiment(base,input());
 assert.deepEqual(result.edge_schema,edge_schema);
 assert.deepEqual(result.edges,[]);
 assert.throws(()=>compileThreadExperiment({...base,edges:{}},input()),/edges/i);
 assert.throws(()=>compileThreadExperiment({...base,edges:null},input()),/edges/i);
 assert.throws(()=>compileThreadExperiment({...base,edge_schema:{version:99},edges:[]},input()),/schema/i);
});

test('stdin bridge emits only compiled JSON and reports invalid contracts as failure',()=>{
 const script=new URL('./compile_thread_experiment.mjs',import.meta.url);
 const run=(source)=>spawnSync(process.execPath,[fileURLToPath(script),'--stdin'],
   {input:JSON.stringify({base:source,interpretation:input()}),encoding:'utf8'});
 const valid=run(base);
 assert.equal(valid.status,0,valid.stderr);
 assert.deepEqual(JSON.parse(valid.stdout).edges,[]);
 assert.equal(valid.stderr,'');
 const invalid=run({...base,edges:{}});
 assert.notEqual(invalid.status,0);
 assert.match(invalid.stderr,/edges/i);
 assert.equal(invalid.stdout,'');
});
