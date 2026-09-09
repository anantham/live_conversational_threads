// One deterministic home lane is a display choice, not exclusive membership.
export function withThreadLanes(nodes, threads = []) {
  const labels = new Map(threads.map(t => [t.id, t.title]));
  return nodes.map(n => {
    const ids = n.thread_ids || [];
    const home = n.thread_id || ids[0];
    return {...n, thread_id:home || null, thread_label:labels.get(home) || n.thread_label,
      thread_labels:ids.map(id => labels.get(id) || id),
      explicit_thread_return:threads.some(t=>(t.returns||[]).some(r=>r.from===n.id && r.kind==="explicit_callback"))};
  });
}
