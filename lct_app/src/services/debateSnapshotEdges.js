import { explicitEdgeKind } from "./edgeContract";

/** Minimize canonical edges for the scoped, semantic-only debate artifact. */
export function projectDebateSnapshotEdges(edges, keptNodeIds) {
  if (!Array.isArray(edges)) return undefined;
  const allowed = keptNodeIds instanceof Set ? keptNodeIds : new Set(keptNodeIds || []);

  return edges
    .filter((edge) => (
      explicitEdgeKind(edge) !== "temporal"
      && allowed.has(String(edge?.from_node_id || ""))
      && allowed.has(String(edge?.to_node_id || ""))
    ))
    .map((edge) => ({
      id: edge?.id || "",
      from_node_id: edge?.from_node_id || "",
      to_node_id: edge?.to_node_id || "",
      relation_type: edge?.relation_type || "",
      edge_kind: explicitEdgeKind(edge),
      explanation: edge?.explanation || "",
    }));
}
