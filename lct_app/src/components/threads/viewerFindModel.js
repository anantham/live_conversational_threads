import { buildArgumentStatusMapForNodes } from "../graph/colorModes";

// These are graph-link questions, not fact-checking verdicts. A lens that
// matches every claim offers no navigation value, so leave it out of Find.
export function buildViewerFindGroups(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const status = buildArgumentStatusMapForNodes(list);
  const claims = list.filter((node) => node.argument_role
    ? node.argument_role === "claim" : Number(node.semantic_level) === 2);
  const hasArgumentLinks = Object.values(status).some((value) => value.sup > 0 || value.reb > 0);
  const groups = [];
  if (hasArgumentLinks && claims.length) {
    const unsupported = claims.filter((node) => !status[node.id]?.sup);
    const uncontested = claims.filter((node) => !status[node.id]?.reb);
    if (unsupported.length && unsupported.length < claims.length) groups.push({
      id: "unsupported", label: "No support link", description: "No authored support relationship; this is not a fact check.", nodes: unsupported,
    });
    if (uncontested.length && uncontested.length < claims.length) groups.push({
      id: "uncontested", label: "No rebuttal link", description: "No authored rebuttal relationship; this does not prove agreement.", nodes: uncontested,
    });
  }
  const questions = list.filter((node) => node.argument_role === "question"
    || String(node.node_name || "").toLowerCase().startsWith("open question"));
  if (questions.length) groups.push({
    id: "questions", label: "Open questions", description: "Questions identified in this conversation.", nodes: questions,
  });
  return groups;
}
