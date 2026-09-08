// Compile a source-pinned public interpretation, never regenerate quoted text.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { enrichGraphNodesWithProvenance } from '../lct_app/src/components/graphProvenance.js';

export function compileThreadExperiment(base, interpretation) {
  const moments = base.graph_data.filter(n => n.semantic_level === 1).map(n => ({
    ...n, parent_id: null, memberships: [], thread_id: null, thread_label: null, thread_ids: [],
  }));
  const nodes = [...moments];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const groups = interpretation.groups;
  assert(Array.isArray(groups) && groups.length, 'Missing hierarchy');
  for (const g of [...groups].sort((a,b) => a.level-b.level)) {
    assert(!byId.has(g.id) && typeof g.id === 'string', 'Duplicate/invalid node');
    assert(Number.isInteger(g.level) && g.level>=2 && g.level<=5, 'Invalid level');
    assert(g.children?.length && new Set(g.children.map(c=>c.id)).size===g.children.length, 'Invalid children');
    const node={id:g.id,node_name:g.title,summary:g.summary,level:g.level,semantic_level:g.level,
      semantic_type:['','','idea','topic','theme','arc'][g.level],children_ids:g.children.map(c=>c.id),
      memberships:[],parent_id:null,thread_ids:[]};
    nodes.push(node);byId.set(node.id,node);
    for(const child of g.children){
      const c=byId.get(child.id);
      assert(c && c.level===g.level-1, `Invalid child ${child.id}`);
      assert(typeof child.why==='string' && child.why.trim(), 'Missing membership rationale');
      c.memberships.push({parent_id:g.id,role:'shared',explanation:child.why});
      // Compatibility breadcrumb only. All actual memberships remain explicit.
      c.parent_id ??= g.id;
    }
  }
  for(const n of nodes) assert(n.level===5 || n.memberships.length, `Orphan ${n.id}`);
  const sourceByIndex=new Map(base.utterances.map((u,i)=>[i+1,u]));
  const evidence=(indices,allowed)=>{
    assert(Array.isArray(indices)&&indices.length, 'Missing evidence');
    return [...new Set(indices)].map(i=>{
      assert(Number.isInteger(i)&&sourceByIndex.has(i), `Unknown source index ${i}`);
      const u=sourceByIndex.get(i);assert(allowed.has(u.id), 'Evidence outside moment');return u.id;
    });
  };
  const threadIds=new Set();
  const threads=interpretation.threads.map(t=>{
    assert(t.id && !threadIds.has(t.id),'Duplicate thread');threadIds.add(t.id);
    assert(t.steps?.length,'Empty thread');
    const seen=new Set();let previous=-Infinity;
    const steps=t.steps.map(s=>{
      const n=byId.get(s.moment_id);assert(n?.level===1,'Unknown thread moment');
      assert(!seen.has(n.id),'Repeated step');seen.add(n.id);
      assert(n.timestamp_start>=previous,'Unordered thread');previous=n.timestamp_start;
      n.thread_ids.push(t.id);
      return {...s,evidence_utterance_ids:evidence(s.evidence_indices,new Set(n.utterance_ids))};
    });
    const returns=(t.returns||[]).map(r=>{
      const from=byId.get(r.from),to=byId.get(r.to);
      assert(seen.has(r.from)&&seen.has(r.to)&&from.timestamp_start>to.timestamp_start,'Invalid return');
      assert(['explicit_callback','thematic_connection'].includes(r.kind),'Invalid return kind');
      const ids=evidence(r.evidence_indices,new Set([...from.utterance_ids,...to.utterance_ids]));
      assert(ids.some(id=>from.utterance_ids.includes(id))&&ids.some(id=>to.utterance_ids.includes(id)), 'Return needs both endpoints');
      return {...r,evidence_utterance_ids:ids};
    });
    return {...t,steps,returns};
  });
  for(const n of nodes.filter(n=>n.level>1)) {
    n.thread_ids=[...new Set(n.children_ids.flatMap(id=>byId.get(id).thread_ids))];
  }
  const enriched=enrichGraphNodesWithProvenance(nodes,base.utterances).map(n=>({...n,
    timestamp_start:n.provenance_metrics.timestamp_start,timestamp_end:n.provenance_metrics.timestamp_end}));
  const edges=threads.flatMap(t=>t.returns.map((r,i)=>({id:`${t.id}-return-${i}`,from_node_id:r.from,to_node_id:r.to,
    edge_kind:'semantic',relation_type:r.kind==='explicit_callback'?'return_to_thread':'contextual',
    explanation:r.why,source_utterance_ids:r.evidence_utterance_ids})));
  return {...base,conversation_id:`${base.conversation_id}-overlap-v1`,conversation_name:interpretation.title,
    conversation_title:interpretation.title,executive_summary:interpretation.summary,
    graph_data:enriched,edges,conversation_threads:threads,reader_routes:[],open_questions:[],
    interpretation_schema:'overlapping-threads-v1',
    analysis_provenance:{...base.analysis_provenance,method:'Whole-public-conversation overlapping membership experiment',
      uncertainties:interpretation.uncertainties,quality_notes:interpretation.quality_notes},
    argument_topology:{status:'partial',method:'Thread returns only; other relations not regenerated',semantic_edge_count:edges.length,exhaustive:false},
    exported_at:new Date().toISOString()};
}

if(process.argv[1] && import.meta.url===new URL(`file://${process.argv[1]}`).href){
  const [basePath,interpretationPath,outputPath]=process.argv.slice(2);
  assert(basePath&&interpretationPath&&outputPath,'Pass base, interpretation, output paths');
  const result=compileThreadExperiment(JSON.parse(fs.readFileSync(basePath)),JSON.parse(fs.readFileSync(interpretationPath)));
  fs.writeFileSync(outputPath,JSON.stringify(result,null,2));
  console.log(JSON.stringify({threads:result.conversation_threads.length,nodes:result.graph_data.length,
    shared:result.graph_data.filter(n=>n.memberships.length>1).length}));
}
