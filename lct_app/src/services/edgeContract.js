/** Canonical directed-edge contract shared by local, shared, and file views. */

export const EDGE_SCHEMA_VERSION = 1;
export const EDGE_ENDPOINT_SPACE = "graph_data.id";
export const MAX_EXPLICIT_EDGES = 200000;
const TEMPORAL_RELATIONSHIP_TYPES = new Set(["temporal", "leads_to", "next", "follows"]);

function clean(value) {
  return String(value ?? "").trim();
}

export function validateExplicitEdgeContract(edgeSchema, edges, nodes) {
  if (!edgeSchema || typeof edgeSchema !== "object" || Array.isArray(edgeSchema)) {
    throw new Error("Missing or invalid edge_schema for .threads version 2.");
  }
  if (
    edgeSchema.version !== EDGE_SCHEMA_VERSION ||
    edgeSchema.directed !== true ||
    edgeSchema.endpoint_space !== EDGE_ENDPOINT_SPACE
  ) {
    throw new Error(
      `Unsupported edge schema (${edgeSchema.version ?? "missing"}). Update the viewer.`,
    );
  }
  if (!Array.isArray(edges)) {
    throw new Error("Missing or invalid explicit edges array.");
  }
  if (edges.length > MAX_EXPLICIT_EDGES) {
    throw new Error(`Artifact has too many explicit edges (${edges.length}).`);
  }

  const nodeIds = new Set((nodes || []).map((node) => clean(node?.id)).filter(Boolean));
  const edgeIds = new Set();
  edges.forEach((edge, index) => {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
      throw new Error(`Invalid explicit edge at index ${index}.`);
    }
    const id = clean(edge.id);
    const from = clean(edge.from_node_id);
    const to = clean(edge.to_node_id);
    const type = clean(edge.relation_type);
    if (!id || !from || !to || !type) {
      throw new Error(`Explicit edge ${index} is missing id, endpoints, or relation_type.`);
    }
    if (edgeIds.has(id)) throw new Error(`Duplicate explicit edge id: ${id}.`);
    if (from === to) throw new Error(`Explicit edge ${id} cannot reference itself.`);
    if (!nodeIds.has(from)) throw new Error(`Explicit edge ${id} has unknown from_node_id: ${from}.`);
    if (!nodeIds.has(to)) throw new Error(`Explicit edge ${id} has unknown to_node_id: ${to}.`);
    if (edge.edge_kind != null && !["semantic", "temporal"].includes(clean(edge.edge_kind))) {
      throw new Error(`Explicit edge ${id} has unsupported edge_kind: ${edge.edge_kind}.`);
    }
    edgeIds.add(id);
  });
  return edges;
}

/**
 * Attach derived incoming/outgoing indexes to nodes. The top-level edge list
 * remains authoritative; these arrays are disposable render-time indexes.
 */
export function indexExplicitEdges(nodes, edges, hasExplicitContract = true) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (!hasExplicitContract) return list;

  const indexed = list.map((node) => ({
    ...node,
    explicit_edges_out: [],
    explicit_edges_in: [],
  }));
  const byId = new Map(indexed.map((node) => [clean(node.id), node]));

  (Array.isArray(edges) ? edges : []).forEach((rawEdge) => {
    if (!rawEdge || typeof rawEdge !== "object") return;
    const edge = {
      ...rawEdge,
      id: clean(rawEdge.id),
      from_node_id: clean(rawEdge.from_node_id),
      to_node_id: clean(rawEdge.to_node_id),
      relation_type: clean(rawEdge.relation_type),
    };
    const source = byId.get(edge.from_node_id);
    const target = byId.get(edge.to_node_id);
    if (!source || !target || !edge.relation_type) return;
    source.explicit_edges_out.push(edge);
    target.explicit_edges_in.push(edge);
  });

  return indexed;
}

export function usesExplicitEdges(node) {
  return Array.isArray(node?.explicit_edges_out) && Array.isArray(node?.explicit_edges_in);
}

export function explicitEdgeKind(edge) {
  const declared = clean(edge?.edge_kind).toLowerCase();
  if (declared === "semantic" || declared === "temporal") return declared;
  return TEMPORAL_RELATIONSHIP_TYPES.has(clean(edge?.relation_type).toLowerCase())
    ? "temporal"
    : "semantic";
}

/** Convert a canonical edge into React Flow's directional endpoint contract. */
export function explicitEdgeRenderEndpoints(edge) {
  return {
    source: clean(edge?.from_node_id),
    target: clean(edge?.to_node_id),
  };
}
