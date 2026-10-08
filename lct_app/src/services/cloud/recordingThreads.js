import { createRecordingTranscript } from './recordingTranscript.js';
import { validateThreadsArtifact } from '../threadsArtifact.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 2000;
const MAX_EDGES = 8000;
const TYPES = ['chunk', 'idea', 'topic', 'theme', 'arc'];
const EDGE_SCHEMA = { version: 1, directed: true, endpoint_space: 'graph_data.id' };

function invalid(validationStage = 'node_shape') {
  return Object.assign(new Error('Invalid generated conversation graph.'), { validationStage });
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function identity(value) {
  return typeof value === 'string' && value.length <= 160 && value === value.trim() && value.length > 0;
}

function ids(value, required = false, validationStage = 'node_shape') {
  if (!Array.isArray(value) || (required && !value.length)
    || value.some((id) => !identity(id)) || new Set(value).size !== value.length) throw invalid(validationStage);
  return value;
}

function optionalText(value) {
  if (value != null && typeof value !== 'string') throw invalid();
  return value;
}

function membershipsOf(value) {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw invalid('memberships');
  const parents = new Set();
  let primaryCount = 0;
  return value.map((entry) => {
    if (!object(entry) || !identity(entry.parent_id)
      || !['primary', 'secondary'].includes(entry.role) || parents.has(entry.parent_id)) throw invalid('memberships');
    parents.add(entry.parent_id);
    if (entry.role === 'primary' && ++primaryCount > 1) throw invalid('memberships');
    return { parent_id: entry.parent_id, role: entry.role };
  });
}

function normalizedGraph(graph, utterances) {
  if (!object(graph) || !Array.isArray(graph.nodes) || !graph.nodes.length || graph.nodes.length > MAX_NODES
    || !Array.isArray(graph.edges) || graph.edges.length > MAX_EDGES) throw invalid('graph_shape');
  if (graph.metadata != null && !object(graph.metadata)) throw invalid('metadata');
  for (const value of [graph.metadata?.conversation_title, graph.metadata?.executive_summary]) {
    if (value != null && typeof value !== 'string') throw invalid('metadata');
  }
  const utteranceById = new Map(utterances.map((row) => [row.id, row]));
  const nodeById = new Map();
  const nodes = graph.nodes.map((node) => {
    if (!object(node) || !identity(node.id) || nodeById.has(node.id)
      || !Number.isInteger(node.semantic_level) || node.semantic_level < 1 || node.semantic_level > 5
      || node.semantic_type !== TYPES[node.semantic_level - 1]
      || typeof node.node_name !== 'string' || !node.node_name.trim()) throw invalid();
    if (node.parent_id != null && !identity(node.parent_id)) throw invalid();
    if (node.children_ids != null) ids(node.children_ids);
    optionalText(node.summary);
    optionalText(node.source_excerpt);
    optionalText(node.thread_id);
    if (node.thread_id != null && !identity(node.thread_id)) throw invalid();
    if (!object(node.source_ref) || !Array.isArray(node.source_ref.utterance_ids)) throw invalid('node_evidence');
    const evidence = ids(node.source_ref.utterance_ids, node.semantic_level === 1, 'node_evidence');
    if (evidence.some((id) => !utteranceById.has(id))) throw invalid('node_evidence');
    if (node.source_excerpt && !evidence.some((id) => utteranceById.get(id).text.includes(node.source_excerpt))) throw invalid('node_excerpt');
    if (node.speaker_id != null && (typeof node.speaker_id !== 'string'
      || !evidence.length || evidence.some((id) => utteranceById.get(id).speaker_id !== node.speaker_id))) throw invalid('node_speaker');
    // The recording is the only authority for source identity and time. Other
    // evidence aliases would let a generated response contradict that source.
    if (node.utterance_ids != null || node.provenance_utterance_ids != null
      || node.provenance_source_ref != null
      || node.source_turns != null || node.timestamp_start != null || node.timestamp_end != null
      || node.start_time != null || node.end_time != null) throw invalid('node_provenance');
    const memberships = membershipsOf(node.memberships);
    const copy = {
      id: node.id, semantic_level: node.semantic_level, semantic_type: node.semantic_type,
      node_name: node.node_name, source_ref: { utterance_ids: [...evidence] },
      ...(node.summary == null ? {} : { summary: node.summary }),
      ...(node.source_excerpt == null ? {} : { source_excerpt: node.source_excerpt }),
      ...(node.thread_id == null ? {} : { thread_id: node.thread_id }),
      ...(node.speaker_id == null ? {} : { speaker_id: node.speaker_id }),
      ...(node.parent_id == null ? {} : { parent_id: node.parent_id }),
      ...(node.children_ids == null ? {} : { children_ids: [...node.children_ids] }),
      ...(memberships == null ? {} : { memberships }),
    };
    nodeById.set(node.id, copy);
    return copy;
  });

  for (const node of nodes) {
    if (node.parent_id != null) {
      const parent = nodeById.get(node.parent_id);
      if (!parent || parent.semantic_level <= node.semantic_level
        || !parent.children_ids?.includes(node.id)) throw invalid('hierarchy');
    }
    const primary = (node.memberships || []).find((membership) => membership.role === 'primary');
    if (primary && primary.parent_id !== node.parent_id) throw invalid('hierarchy');
    for (const membership of node.memberships || []) {
      const parent = nodeById.get(membership.parent_id);
      if (!parent || parent.semantic_level <= node.semantic_level
        || !parent.children_ids?.includes(node.id)
        || (membership.role === 'secondary' && membership.parent_id === node.parent_id)) throw invalid('hierarchy');
    }
    for (const childId of node.children_ids || []) {
      const child = nodeById.get(childId);
      if (!child || child.semantic_level >= node.semantic_level
        || (child.parent_id !== node.id && !child.memberships?.some((membership) =>
          membership.parent_id === node.id && membership.role === 'secondary'))) throw invalid('hierarchy');
    }
  }
  // Strictly descending semantic levels already preclude a hierarchy cycle;
  // checking each parent chain keeps this invariant explicit if levels change.
  for (const node of nodes) {
    const seen = new Set();
    let current = node;
    while (current?.parent_id) {
      if (seen.has(current.id)) throw invalid('hierarchy');
      seen.add(current.id);
      current = nodeById.get(current.parent_id);
    }
  }

  let edges;
  try {
    edges = graph.edges.map((edge) => {
      if (!object(edge) || !identity(edge.id) || !identity(edge.from_node_id)
        || !identity(edge.to_node_id) || !identity(edge.relation_type)
        || (edge.edge_kind != null && !['semantic', 'temporal'].includes(edge.edge_kind))) throw invalid();
      optionalText(edge.explanation);
      optionalText(edge.relation_text);
      if (edge.confidence != null && (typeof edge.confidence !== 'number'
        || !Number.isFinite(edge.confidence) || edge.confidence < 0 || edge.confidence > 1)) throw invalid();
      return {
        id: edge.id, from_node_id: edge.from_node_id, to_node_id: edge.to_node_id,
        relation_type: edge.relation_type,
        ...(edge.edge_kind == null ? {} : { edge_kind: edge.edge_kind }),
        ...(edge.explanation == null ? {} : { explanation: edge.explanation }),
        ...(edge.relation_text == null ? {} : { relation_text: edge.relation_text }),
        ...(edge.confidence == null ? {} : { confidence: edge.confidence }),
      };
    });
    validateThreadsArtifact({ format: 'lct.threads', format_version: 2, graph_data: nodes,
      edge_schema: EDGE_SCHEMA, edges });
  } catch { throw invalid('edges'); }

  let conversationThreads;
  if (graph.conversation_threads != null) {
    if (!Array.isArray(graph.conversation_threads)) throw invalid('threads');
    try {
      conversationThreads = JSON.parse(JSON.stringify(graph.conversation_threads));
      validateThreadsArtifact({ format: 'lct.threads', format_version: 2, graph_data: nodes,
        utterances, edge_schema: EDGE_SCHEMA, edges, conversation_threads: conversationThreads });
    } catch { throw invalid('threads'); }
  }
  return { nodes, edges, conversationThreads };
}

/** Package actual generated graph output with the recording's exact source. */
export function createRecordingThreads({ recordingId, startedAt, finalTokens, complete, graph } = {}) {
  // Source validation precedes every read of generated output.
  const { document } = createRecordingTranscript({ recordingId, startedAt, finalTokens, complete });
  const { nodes, edges, conversationThreads } = normalizedGraph(graph, document.utterances);
  const linked = new Set(nodes.flatMap((node) => node.source_ref.utterance_ids));
  const covered = linked.size;
  const bundle = {
    format: 'lct.threads', format_version: 2,
    conversation_id: document.recording_id,
    conversation_title: graph.metadata?.conversation_title || 'Recorded conversation',
    executive_summary: graph.metadata?.executive_summary || '',
    recorded_at: document.recorded_at,
    transcription_complete: document.transcription_complete,
    graph_data: nodes, edge_schema: { ...EDGE_SCHEMA }, edges,
    ...(conversationThreads == null ? {} : { conversation_threads: conversationThreads }),
    argument_topology: { status: 'not_run', version: 'unknown' },
    source_tokens: document.source_tokens,
    utterances: document.utterances,
    full_transcript: document.full_transcript,
    transcript_source: 'verbatim',
    coverage: { total_turns: document.utterances.length, covered_turns: covered,
      pct: covered ? Math.round(1000 * covered / document.utterances.length) / 10 : null,
      auditable: covered > 0 },
  };
  try { validateThreadsArtifact(bundle); } catch { throw invalid('bundle_validation'); }
  let json;
  try { json = JSON.stringify(bundle); } catch { throw invalid('bundle_json'); }
  if (new TextEncoder().encode(json).byteLength > MAX_BYTES) throw invalid('bundle_size');
  const filename = `recording-${document.recording_id}.threads`;
  return { bundle, json, filename, file: new File([json], filename, { type: 'application/json' }) };
}
