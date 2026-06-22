/**
 * Drill-subset layout helpers extracted from MinimalGraph.jsx.
 * Re-packs filtered children into a compact local layout near the origin.
 */

import { layoutWithDagre } from "./graphLayout";

const LAYOUT_STOPWORDS = new Set(
  ("the a an and or but of to in on for with as is are was were be been being it its this that these those you your "
    + "i we he she they them his her their our not no so if then than at by from about into over under can will would "
    + "just like really actually kind sort thing things stuff what which who when where how why do does did have has "
    + "had get got make made one two also more most much very some any all out up down here there now")
    .split(" ")
);

function layoutTextVec(node) {
  const fd = node.data?.fullData || {};
  const text = `${fd.node_name || node.data?.title || ""} ${fd.summary || node.data?.summary || ""}`.toLowerCase();
  const v = new Map();
  for (const tok of text.split(/[^a-z0-9]+/)) {
    if (tok.length < 3 || LAYOUT_STOPWORDS.has(tok)) continue;
    v.set(tok, (v.get(tok) || 0) + 1);
  }
  let norm = 0;
  for (const c of v.values()) norm += c * c;
  norm = Math.sqrt(norm) || 1;
  for (const key of v.keys()) v.set(key, v.get(key) / norm);
  return v;
}

function layoutCosine(a, b) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [key, va] of small) {
    const vb = big.get(key);
    if (vb) s += va * vb;
  }
  return s;
}

function similarityLayout(nodes, edges, { nodeWidth = 480, nodeHeight = 360 } = {}) {
  const n = nodes.length;
  const gapX = nodeWidth + 90;
  const gapY = nodeHeight + 70;
  if (n <= 2) return nodes.map((nd, i) => ({ ...nd, position: { x: i * gapX, y: 0 } }));
  const embs = nodes.map((nd) => nd.data?.fullData?.embed);
  const useEmbed = embs.every((e) => Array.isArray(e) && e.length >= 4);
  const vecs = useEmbed ? null : nodes.map(layoutTextVec);
  const affPair = useEmbed
    ? (i, j) => {
        const a = embs[i];
        const b = embs[j];
        let s = 0;
        for (let t = 0; t < a.length; t++) s += a[t] * b[t];
        return s;
      }
    : (i, j) => layoutCosine(vecs[i], vecs[j]);
  const aff = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = affPair(i, j);
      aff[i][j] = s;
      aff[j][i] = s;
    }
  }
  const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
  (edges || []).forEach((e) => {
    const a = idx.get(e.source);
    const b = idx.get(e.target);
    if (a != null && b != null && a !== b) { aff[a][b] += 0.5; aff[b][a] += 0.5; }
  });
  let start = 0;
  let bestSum = -1;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += aff[i][j];
    if (s > bestSum) { bestSum = s; start = i; }
  }
  const used = new Array(n).fill(false);
  const order = [start];
  used[start] = true;
  for (let step = 1; step < n; step++) {
    const last = order[order.length - 1];
    let nxt = -1;
    let bs = -2;
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      if (aff[last][j] > bs) { bs = aff[last][j]; nxt = j; }
    }
    if (nxt === -1) nxt = used.indexOf(false);
    order.push(nxt);
    used[nxt] = true;
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  return order.map((nodeIdx, p) => {
    const row = Math.floor(p / cols);
    let col = p % cols;
    if (row % 2 === 1) col = cols - 1 - col;
    return { ...nodes[nodeIdx], position: { x: col * gapX, y: row * gapY } };
  });
}

function deOverlap(P, nodeWidth, nodeHeight, passes = 140) {
  const minDX = nodeWidth + 60;
  const minDY = nodeHeight + 50;
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        const dx = P[j].x - P[i].x;
        const dy = P[j].y - P[i].y;
        const ox = minDX - Math.abs(dx);
        const oy = minDY - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          moved = true;
          if (ox <= oy) { const s = ((dx < 0 ? -1 : 1) * ox) / 2 || 0.5; P[i].x -= s; P[j].x += s; }
          else { const s = ((dy < 0 ? -1 : 1) * oy) / 2 || 0.5; P[i].y -= s; P[j].y += s; }
        }
      }
    }
    if (!moved) break;
  }
}

function topEigenvector(C, d) {
  let v = new Float64Array(d);
  for (let i = 0; i < d; i++) v[i] = Math.cos(i + 1);
  for (let it = 0; it < 80; it++) {
    const nv = new Float64Array(d);
    for (let i = 0; i < d; i++) {
      let s = 0;
      for (let j = 0; j < d; j++) s += C[i][j] * v[j];
      nv[i] = s;
    }
    let norm = 0;
    for (let i = 0; i < d; i++) norm += nv[i] * nv[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < d; i++) v[i] = nv[i] / norm;
  }
  return v;
}

function embedLayout(nodes, { nodeWidth = 480, nodeHeight = 360 } = {}) {
  const n = nodes.length;
  const embs = nodes.map((nd) => nd.data?.fullData?.embed);
  if (n <= 2 || embs.some((e) => !Array.isArray(e) || e.length < 4)) return null;
  const d = embs[0].length;
  const mean = new Float64Array(d);
  for (const e of embs) for (let i = 0; i < d; i++) mean[i] += e[i];
  for (let i = 0; i < d; i++) mean[i] /= n;
  const X = embs.map((e) => { const r = new Float64Array(d); for (let i = 0; i < d; i++) r[i] = e[i] - mean[i]; return r; });
  const C = Array.from({ length: d }, () => new Float64Array(d));
  for (const r of X) for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] += r[i] * r[j];
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] /= n;
  const v1 = topEigenvector(C, d);
  let lam1 = 0;
  for (let i = 0; i < d; i++) { let s = 0; for (let j = 0; j < d; j++) s += C[i][j] * v1[j]; lam1 += v1[i] * s; }
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] -= lam1 * v1[i] * v1[j];
  const v2 = topEigenvector(C, d);
  const coords = X.map((r) => {
    let a = 0;
    let b = 0;
    for (let i = 0; i < d; i++) { a += r[i] * v1[i]; b += r[i] * v2[i]; }
    return { x: a, y: b };
  });
  let mx2 = 0;
  let my2 = 0;
  coords.forEach((c) => { mx2 += c.x * c.x; my2 += c.y * c.y; });
  const rmsX = Math.sqrt(mx2 / n) || 1;
  const rmsY = Math.sqrt(my2 / n) || 1;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);
  const fx = (cols * (nodeWidth + 90)) / (4 * rmsX);
  const fy = (rows * (nodeHeight + 70)) / (4 * rmsY);
  const P = coords.map((c) => ({ x: c.x * fx, y: c.y * fy }));
  deOverlap(P, nodeWidth, nodeHeight);
  let minX = Infinity;
  let minY = Infinity;
  P.forEach((p) => { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; });
  return nodes.map((nd, i) => ({ ...nd, position: { x: Math.round(P[i].x - minX), y: Math.round(P[i].y - minY) } }));
}

export function repackSubset(nodes, edges) {
  if (!nodes || nodes.length <= 1) return nodes;
  const NW = 480;
  const NH = 360;
  if (edges && edges.length >= Math.ceil(nodes.length * 0.6)) {
    return layoutWithDagre(nodes.map((n) => ({ ...n })), edges, { nodeWidth: NW, nodeHeight: NH });
  }
  if (nodes.length <= 80) {
    return embedLayout(nodes, { nodeWidth: NW, nodeHeight: NH })
      || similarityLayout(nodes, edges, { nodeWidth: NW, nodeHeight: NH });
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const gapX = NW + 90;
  const gapY = NH + 70;
  return nodes.map((n, i) => ({
    ...n,
    position: { x: (i % cols) * gapX, y: Math.floor(i / cols) * gapY },
  }));
}

export const MIN_READABLE_ZOOM = 0.65;