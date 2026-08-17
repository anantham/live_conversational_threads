/**
 * Node normalization helpers extracted from MinimalGraph.jsx.
 *
 * Pure functions — no React, no hooks. They sanitize and reshape raw
 * graph data (often from JSON imports of varying vintage) into the
 * uniform shape the renderer expects.
 */

/** Coerce a raw graph item into the canonical node shape. */
export function normalizeGraphNode(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }

  const rawId = typeof item.id === "string" && item.id.trim() ? item.id.trim() : "";
  const rawName =
    typeof item.node_name === "string" && item.node_name.trim() ? item.node_name.trim() : "";
  const fallbackName =
    typeof item.summary === "string" && item.summary.trim()
      ? item.summary.trim().slice(0, 48)
      : `Node ${index + 1}`;

  return {
    ...item,
    id: rawId || `node-${index}`,
    node_name: rawName || fallbackName,
    speaker_id: typeof item.speaker_id === "string" ? item.speaker_id : "",
    semantic_level:
      Number.isInteger(item.semantic_level) && item.semantic_level >= 1 && item.semantic_level <= 5
        ? item.semantic_level
        : null,
    semantic_type:
      typeof item.semantic_type === "string" && item.semantic_type.trim()
        ? item.semantic_type.trim().toLowerCase()
        : "",
    parent_id: typeof item.parent_id === "string" && item.parent_id.trim() ? item.parent_id.trim() : "",
    children_ids: Array.isArray(item.children_ids)
      ? item.children_ids.map((value) => String(value || "").trim()).filter(Boolean)
      : [],
    __graphLayer: typeof item.__graphLayer === "string" ? item.__graphLayer : "finalized",
    successor: typeof item.successor === "string" ? item.successor : "",
    edge_relations: Array.isArray(item.edge_relations) ? item.edge_relations : [],
    contextual_relation:
      item.contextual_relation &&
      typeof item.contextual_relation === "object" &&
      !Array.isArray(item.contextual_relation)
        ? item.contextual_relation
        : {},
    // #12: lift the thread/tangent structure to top level so graphLayout swim-lanes,
    // NodeDetail, and MinimalGraph markers (which read these top-level) light up.
    // Falls back to the metadata-nested shape the /api/graph endpoint still uses.
    thread_id:
      (typeof item.thread_id === "string" && item.thread_id) ||
      item.metadata?.cluster_info?.thread_id ||
      "",
    thread_label:
      (typeof item.thread_label === "string" && item.thread_label.trim()) ||
      item.metadata?.cluster_info?.thread_label ||
      "",
    thread_state:
      (typeof item.thread_state === "string" && item.thread_state) ||
      item.metadata?.cluster_info?.thread_state ||
      "",
    is_tangent: Boolean(item.is_tangent ?? item.metadata?.is_tangent),
    is_crux: Boolean(item.is_crux ?? item.metadata?.is_crux),
    // Argument-map role (claim | evidence | question | assumption). Feeds the
    // debate color mode (CLAIM_TYPE_COLORS) + the card's claim-type chip.
    claim_type:
      (typeof item.claim_type === "string" && item.claim_type.trim().toLowerCase()) ||
      (typeof item.display_preferences?.claim_type === "string"
        ? item.display_preferences.claim_type.trim().toLowerCase()
        : "") ||
      "",
    // Provenance anchor — NodeDetail's panel reads source_ref.utterance_ids.
    source_ref:
      item.source_ref && typeof item.source_ref === "object" && !Array.isArray(item.source_ref)
        ? item.source_ref
        : null,
  };
}

/** Extract [name, text] pairs from a contextual_relation object, accepting
 * both the single-relation shape (with `related_node_name` + `relation_text`
 * top-level keys) and the multi-relation shape (one entry per related node). */
export function extractContextualRelationEntries(contextualRelation) {
  if (!contextualRelation || typeof contextualRelation !== "object" || Array.isArray(contextualRelation)) {
    return [];
  }

  const relatedNode =
    contextualRelation.related_node_name ||
    contextualRelation.related_node ||
    contextualRelation.relatedNode ||
    contextualRelation.source ||
    contextualRelation.from ||
    contextualRelation.node;
  const relationText =
    contextualRelation.relation_text ||
    contextualRelation.relationText ||
    contextualRelation.description ||
    contextualRelation.explanation;
  const singleRelationKeys = new Set([
    "related_node_name",
    "related_node",
    "relatedNode",
    "source",
    "from",
    "node",
    "relation_text",
    "relationText",
    "description",
    "explanation",
    "relation_type",
    "type",
  ]);
  const keys = Object.keys(contextualRelation);
  const looksLikeSingleRelation =
    Boolean(relatedNode && relationText) && keys.every((key) => singleRelationKeys.has(key));

  if (looksLikeSingleRelation) {
    return [[String(relatedNode), String(relationText)]];
  }

  return Object.entries(contextualRelation)
    .filter(([name, text]) => Boolean(String(name).trim()) && Boolean(String(text).trim()))
    .map(([name, text]) => [String(name), String(text)]);
}

/** Semantic level from a node, or null if missing / out of [1, 5]. */
export function getAuthoredSemanticLevel(node) {
  const level = Number(node?.semantic_level);
  if (!Number.isInteger(level) || level < 1 || level > 5) return null;
  const semanticType = String(node?.semantic_type || "").trim().toLowerCase();
  if (!semanticType) return null;
  return level;
}

/** Map a continuous ReactFlow zoom value to a discrete semantic level. */
export function resolveRequestedSemanticLevel(zoomLevel) {
  if (zoomLevel < 0.42) return 4;
  if (zoomLevel < 0.62) return 3;
  if (zoomLevel < 0.82) return 2;
  return 1;
}
