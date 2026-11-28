// Quiet background epistemic extraction pass (cruxes, factual claims, normative assumptions).
import { extractEpistemicMap } from './openRouterClient.js';

function contiguousRanges(utteranceIds, indexById) {
  const ordered = [...new Set((utteranceIds || []).map(String))]
    .filter(id => indexById.has(id))
    .sort((a, b) => indexById.get(a) - indexById.get(b));
  const runs = [];
  for (const id of ordered) {
    const idx = indexById.get(id);
    const prev = runs.at(-1);
    if (prev && idx === prev.last + 1) {
      prev.to = id;
      prev.last = idx;
    } else {
      runs.push({ from: id, to: id, last: idx });
    }
  }
  return runs.map(({ from, to }) => ({ from, to }));
}

/** Build bounded map_nodes payload for epistemic-v1 (preferring topics/ideas/arcs with cited ranges). */
export function buildEpistemicMapNodes(bundle) {
  const utterances = Array.isArray(bundle?.utterances) ? bundle.utterances : [];
  const indexById = new Map(utterances.map((u, i) => [String(u.id), i]));
  const nodes = Array.isArray(bundle?.graph_data) ? bundle.graph_data : [];
  const out = [];
  for (const node of nodes) {
    if (!node?.id || !Number.isInteger(node.semantic_level)) continue;
    const ranges = contiguousRanges(node.source_ref?.utterance_ids, indexById);
    if (!ranges.length) continue;
    out.push({
      id: String(node.id),
      semantic_level: node.semantic_level,
      node_name: String(node.node_name || node.id).slice(0, 300),
      summary: typeof node.summary === 'string' ? node.summary.slice(0, 1000) : '',
      ranges: ranges.slice(0, 200),
    });
    if (out.length >= 300) break;
  }
  return out;
}

/**
 * Run a single quiet epistemic extraction pass over a completed map and attach
 * `bundle.epistemic` so the Spatial Landscape Lens bar lights up automatically.
 */
export async function runEpistemicAnalysis({ source, bundle, routes, signal, extract = extractEpistemicMap }) {
  const mapNodes = buildEpistemicMapNodes(bundle);
  const res = await extract(source, signal, routes, mapNodes);
  const epistemic = {
    cruxes: res.epistemic.cruxes,
    factual_claims: res.epistemic.factual_claims,
    normative_assumptions: res.epistemic.normative_assumptions,
    analyzed_at: new Date().toISOString(),
    ...(res.backend ? { backend: res.backend } : {}),
    ...(res.model ? { model: res.model } : {}),
  };
  const updated = { ...bundle, epistemic };
  return {
    bundle: updated,
    json: JSON.stringify(updated, null, 2),
    epistemic,
    backend: res.backend,
    model: res.model,
    attempts: res.attempts || [],
  };
}
