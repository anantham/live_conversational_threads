export const EDGE_RELATION_STYLE = {
  supports: { color: "#16a34a", width: 2.8 },
  rebuts: { color: "#dc2626", width: 2.8 },
  clarifies: { color: "#2563eb", width: 2.6 },
  asks: { color: "#0f766e", width: 2.6 },
  tangent: { color: "#d97706", width: 2.6 },
  return_to_thread: { color: "#0284c7", width: 3.0 },
  contextual: { color: "#6b7280", width: 2.2 },
  temporal_next: { color: "#9ca3af", width: 2.0 },
};

export const GRAPH_DEBUG = import.meta.env.VITE_GRAPH_DEBUG === "true";

export const graphDebugLog = (...args) => {
  if (GRAPH_DEBUG) {
    console.log(...args);
  }
};

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
