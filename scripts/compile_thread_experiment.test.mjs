import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileThreadExperiment} from './compile_thread_experiment.mjs';
const base={conversation_id:'synthetic',utterances:[{id:'u1',text:'Example',timestamp_start:0,timestamp_end:2}],
  graph_data:[{id:'m',level:1,semantic_level:1,timestamp_start:0,utterance_ids:['u1']}]};
function input(){return {title:'Example',summary:'Synthetic',threads:[{id:'t',steps:[{moment_id:'m',evidence_indices:[1]}]}],groups:[
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
});
