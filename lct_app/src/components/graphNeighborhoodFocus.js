/**
 * Project a temporary one-hop view around a selected graph node.
 * The full tier remains the source of truth; this only filters and repositions.
 */

const CARD_WIDTH = 480;
const CARD_HEIGHT = 360;
const COLUMN_GAP = 120;
const ROW_GAP = 140;

function nodeLabel(node) {
  return String(node?.data?.title || node?.data?.fullData?.node_name || node?.id || "");
}

function stableNodeSort(left, right) {
  return nodeLabel(left).localeCompare(nodeLabel(right)) || String(left.id).localeCompare(String(right.id));
}

function placeBand(nodes, { startY, columns, width }) {
  if (nodes.length === 0) return { positions: new Map(), rows: 0 };
  const positions = new Map();
  const rows = Math.ceil(nodes.length / columns);
  nodes.forEach((node, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const rowCount = Math.min(columns, nodes.length - row * columns);
    const rowWidth = rowCount * CARD_WIDTH + Math.max(0, rowCount - 1) * COLUMN_GAP;
    const rowStart = (width - rowWidth) / 2;
    positions.set(node.id, {
      x: rowStart + column * (CARD_WIDTH + COLUMN_GAP),
      y: startY + row * (CARD_HEIGHT + ROW_GAP),
    });
  });
  return { positions, rows };
}

/** Returns null when focusNodeId is not present in the current visible tier. */
export function buildFocusedNeighborhood(nodes, edges, focusNodeId, { compact = false } = {}) {
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const edgeList = Array.isArray(edges) ? edges : [];
  if (!focusNodeId) return null;

  const nodeById = new Map(nodeList.map((node) => [node.id, node]));
  const focus = nodeById.get(focusNodeId);
  if (!focus) return null;

  const incidentEdges = edgeList.filter(
    (edge) => edge?.data?.category !== "temporal"
      && (edge?.source === focusNodeId || edge?.target === focusNodeId),
  );
  const incomingIds = new Set();
  const outgoingIds = new Set();
  incidentEdges.forEach((edge) => {
    if (edge.target === focusNodeId && edge.source !== focusNodeId && nodeById.has(edge.source)) {
      incomingIds.add(edge.source);
    }
    if (edge.source === focusNodeId && edge.target !== focusNodeId && nodeById.has(edge.target)) {
      outgoingIds.add(edge.target);
    }
  });

  // A bidirectional neighbour appears once, in the incoming band. Both arrows
  // remain visible, so direction is explicit without duplicating the card.
  const incoming = [...incomingIds].map((id) => nodeById.get(id)).sort(stableNodeSort);
  const outgoing = [...outgoingIds]
    .filter((id) => !incomingIds.has(id))
    .map((id) => nodeById.get(id))
    .sort(stableNodeSort);
  // Desktop keeps each directional band on one row. A high-degree star remains
  // pannable at readable scale instead of wrapping later edges through earlier
  // cards. Compact screens use one card per row and pan vertically.
  const columns = compact ? 1 : Math.max(incoming.length, outgoing.length, 1);
  const width = columns * CARD_WIDTH + Math.max(0, columns - 1) * COLUMN_GAP;
  const incomingBand = placeBand(incoming, { startY: 0, columns, width });
  const focusY = incomingBand.rows > 0
    ? incomingBand.rows * CARD_HEIGHT + incomingBand.rows * ROW_GAP
    : 0;
  const outgoingStartY = focusY + CARD_HEIGHT + ROW_GAP;
  const outgoingBand = placeBand(outgoing, { startY: outgoingStartY, columns, width });

  const positions = new Map(incomingBand.positions);
  positions.set(focusNodeId, { x: (width - CARD_WIDTH) / 2, y: focusY });
  outgoingBand.positions.forEach((position, id) => positions.set(id, position));

  const visibleIds = new Set([focusNodeId, ...incomingIds, ...outgoingIds]);
  return {
    nodes: nodeList
      .filter((node) => visibleIds.has(node.id))
      .map((node) => ({
        ...node,
        draggable: false,
        position: positions.get(node.id) || { x: 0, y: 0 },
        data: { ...(node.data || {}), isNeighborhoodFocus: node.id === focusNodeId },
      })),
    edges: incidentEdges.map((edge) => ({
      ...edge,
      animated: false,
      style: {
        ...(edge.style || {}),
        opacity: 1,
        strokeWidth: Math.max(2, Number(edge.style?.strokeWidth) || 0),
      },
      labelStyle: {
        ...(edge.labelStyle || {}),
        fontSize: 12,
        fontWeight: 600,
        opacity: 1,
      },
    })),
    focusNode: focus,
    directNeighborCount: Math.max(0, visibleIds.size - 1),
    incomingCount: incomingIds.size,
    outgoingCount: outgoingIds.size,
  };
}
