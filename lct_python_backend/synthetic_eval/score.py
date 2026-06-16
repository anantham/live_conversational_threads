"""Score an extracted graph against a conversation's authored ground truth.

The hard part of scoring is alignment: extracted nodes are chunks/ideas that span
one or more turns, not a 1:1 map to turns. We solve it by computing, for each
extracted node, the set of ground-truth TURN ids it covers (via token containment
of the turn text inside the node's excerpt/summary). Everything else — flags,
edges, claims — is then scored in turn-space.

Metrics are deliberately asymmetric and reported explicitly rather than collapsed:
  * Flag recall  = fraction of ground-truth-flagged turns whose covering node carries the flag.
  * Flag precision = fraction of flagged nodes that cover at least one ground-truth-flagged turn.
  * Edge recall/precision = direction-agnostic (extraction direction is unreliable),
    matched per relation type; a stricter directed score is also reported.
  * Claim scoring (generate-mode) covers ONLY factual claims, because the
    generation prompt's ``claims`` field is explicitly "fact-checkable assertions,
    be conservative". Normative/worldview claims are recorded in ground truth but
    are out of scope here (they belong to the separate three-layer claim detector).

Known limitations (documented, not hidden):
  * Token-containment alignment can mis-assign very short turns; we require a
    minimum overlap count to reduce that.
  * A node that merges a tangent turn with an on-topic turn is scored as covering
    both — so a single mega-node can inflate recall. Inspect the per-item detail
    lists, not just the headline F1.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from lct_python_backend.synthetic_eval.schema import (
    SCORED_EDGE_TYPES,
    SCORED_FLAGS,
    SyntheticConversation,
)

# ── Tokenization ─────────────────────────────────────────────────────────────

_STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "for",
    "with", "as", "is", "are", "was", "were", "be", "been", "being", "it", "its",
    "that", "this", "these", "those", "i", "you", "we", "they", "he", "she",
    "them", "us", "our", "your", "their", "so", "not", "no", "yes", "do", "did",
    "does", "have", "has", "had", "will", "would", "can", "could", "should",
    "about", "just", "really", "like", "okay", "ok", "right", "sure", "thing",
    "actually", "anyway", "back", "here", "there", "what", "how", "why", "who",
    "from", "at", "by", "up", "out", "off", "than", "then", "now", "more", "very",
}

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def tokenize(text: str) -> Set[str]:
    toks = _TOKEN_RE.findall(str(text or "").lower())
    return {t for t in toks if len(t) >= 2 and t not in _STOPWORDS}


def containment(small: Set[str], big: Set[str]) -> float:
    """Fraction of ``small`` that appears in ``big``."""
    if not small:
        return 0.0
    return len(small & big) / len(small)


# ── Alignment: extracted node -> set of covered ground-truth turn ids ────────

def _node_text(node: Dict[str, Any]) -> str:
    parts = [
        str(node.get("source_excerpt", "")),
        str(node.get("summary", "")),
        str(node.get("node_name", "")),
    ]
    return " ".join(p for p in parts if p)


def compute_node_coverage(
    convo: SyntheticConversation,
    nodes: List[Dict[str, Any]],
    *,
    threshold: float = 0.5,
    min_overlap: int = 3,
) -> List[Set[str]]:
    """For each node, the set of turn ids whose text is contained in the node."""
    turn_tokens: List[Tuple[str, Set[str]]] = [
        (turn.id, tokenize(turn.text)) for turn in convo.turns
    ]
    coverage: List[Set[str]] = []
    for node in nodes:
        node_toks = tokenize(_node_text(node))
        covered: Set[str] = set()
        for turn_id, tt in turn_tokens:
            if not tt:
                continue
            overlap = len(tt & node_toks)
            need = min(min_overlap, len(tt))
            if overlap >= need and containment(tt, node_toks) >= threshold:
                covered.add(turn_id)
        coverage.append(covered)
    return coverage


# ── Metric container ─────────────────────────────────────────────────────────

@dataclass
class DimMetric:
    label: str
    recall_hit: int = 0
    recall_total: int = 0          # ground-truth items
    precision_hit: int = 0
    precision_total: int = 0       # extracted items
    missed: List[str] = field(default_factory=list)          # GT items not recalled
    false_positives: List[str] = field(default_factory=list)  # extracted items with no GT match

    @property
    def recall(self) -> Optional[float]:
        if self.recall_total == 0:
            return None
        return self.recall_hit / self.recall_total

    @property
    def precision(self) -> Optional[float]:
        if self.precision_total == 0:
            return None
        return self.precision_hit / self.precision_total

    @property
    def f1(self) -> Optional[float]:
        p, r = self.precision, self.recall
        if p is None or r is None or (p + r) == 0:
            return None
        return 2 * p * r / (p + r)

    def to_json(self) -> Dict[str, Any]:
        return {
            "label": self.label,
            "precision": self.precision,
            "recall": self.recall,
            "f1": self.f1,
            "recall_hit": self.recall_hit,
            "recall_total": self.recall_total,
            "precision_hit": self.precision_hit,
            "precision_total": self.precision_total,
            "missed": self.missed,
            "false_positives": self.false_positives,
        }


@dataclass
class ScoreReport:
    slug: str
    provider: str
    backend_label: str
    node_count: int
    flag_metrics: Dict[str, DimMetric] = field(default_factory=dict)
    edge_metrics: Dict[str, DimMetric] = field(default_factory=dict)
    edge_overall: Optional[DimMetric] = None
    edge_overall_directed: Optional[DimMetric] = None
    claim_factual: Optional[DimMetric] = None
    notes: List[str] = field(default_factory=list)

    def to_json(self) -> Dict[str, Any]:
        return {
            "slug": self.slug,
            "provider": self.provider,
            "backend_label": self.backend_label,
            "node_count": self.node_count,
            "flags": {k: m.to_json() for k, m in self.flag_metrics.items()},
            "edges": {k: m.to_json() for k, m in self.edge_metrics.items()},
            "edge_overall": self.edge_overall.to_json() if self.edge_overall else None,
            "edge_overall_directed": self.edge_overall_directed.to_json() if self.edge_overall_directed else None,
            "claim_factual": self.claim_factual.to_json() if self.claim_factual else None,
            "notes": self.notes,
        }


# ── Flag scoring ─────────────────────────────────────────────────────────────

def _score_flags(
    convo: SyntheticConversation,
    nodes: List[Dict[str, Any]],
    coverage: List[Set[str]],
) -> Dict[str, DimMetric]:
    # turn_id -> indices of nodes covering it
    turn_to_nodes: Dict[str, List[int]] = {}
    for idx, cov in enumerate(coverage):
        for turn_id in cov:
            turn_to_nodes.setdefault(turn_id, []).append(idx)

    metrics: Dict[str, DimMetric] = {}
    for flag in SCORED_FLAGS:
        gt_turns = set(convo.ground_truth.turns_for_flag(flag))
        flagged_nodes = [i for i, n in enumerate(nodes) if bool(n.get(flag))]
        m = DimMetric(label=flag)

        # Recall over ground-truth turns.
        m.recall_total = len(gt_turns)
        for turn_id in sorted(gt_turns):
            covering = turn_to_nodes.get(turn_id, [])
            if any(bool(nodes[i].get(flag)) for i in covering):
                m.recall_hit += 1
            else:
                m.missed.append(turn_id)

        # Precision over flagged nodes.
        m.precision_total = len(flagged_nodes)
        for i in flagged_nodes:
            if coverage[i] & gt_turns:
                m.precision_hit += 1
            else:
                name = str(nodes[i].get("node_name", f"node#{i}"))
                m.false_positives.append(name)

        metrics[flag] = m
    return metrics


# ── Edge scoring ─────────────────────────────────────────────────────────────

def _extracted_edges(
    convo: SyntheticConversation,
    nodes: List[Dict[str, Any]],
    coverage: List[Set[str]],
) -> List[Tuple[str, Set[str], Set[str], str]]:
    """Return (relation_type, endpointA_turns, endpointB_turns, descriptor).

    endpointA is the node that holds the edge_relations entry; endpointB is the
    related node (resolved by name, else by fuzzy text coverage of the name).
    """
    name_to_index: Dict[str, int] = {}
    for i, n in enumerate(nodes):
        nm = str(n.get("node_name", "")).strip()
        if nm and nm not in name_to_index:
            name_to_index[nm] = i

    turn_tokens = [(t.id, tokenize(t.text)) for t in convo.turns]

    def _cover_from_name(name: str) -> Set[str]:
        toks = tokenize(name)
        if not toks:
            return set()
        out: Set[str] = set()
        for turn_id, tt in turn_tokens:
            if tt and containment(toks, tt) >= 0.6 and len(toks & tt) >= 2:
                out.add(turn_id)
        return out

    edges: List[Tuple[str, Set[str], Set[str], str]] = []
    seen: Set[Tuple[str, int, str]] = set()
    for i, n in enumerate(nodes):
        for rel in n.get("edge_relations", []) or []:
            if not isinstance(rel, dict):
                continue
            rtype = str(rel.get("relation_type", "")).strip().lower()
            related = str(rel.get("related_node", "")).strip()
            if not related:
                continue
            dedupe_key = (rtype, i, related)
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            j = name_to_index.get(related)
            b_cov = coverage[j] if j is not None else _cover_from_name(related)
            descriptor = f"{n.get('node_name','?')} <{rtype}> {related}"
            edges.append((rtype, coverage[i], b_cov, descriptor))
    return edges


def _score_edges(
    convo: SyntheticConversation,
    nodes: List[Dict[str, Any]],
    coverage: List[Set[str]],
) -> Tuple[Dict[str, DimMetric], DimMetric, DimMetric]:
    extracted = _extracted_edges(convo, nodes, coverage)
    gt_edges = convo.ground_truth.edges

    def _match(edge_type: str, a: Set[str], b: Set[str], directed: bool) -> Optional[int]:
        """Return index of a matching GT edge of the same type, else None."""
        for gi, ge in enumerate(gt_edges):
            if ge.type != edge_type:
                continue
            if directed:
                if ge.from_turn in a and ge.to_turn in b:
                    return gi
            else:
                if (ge.from_turn in a and ge.to_turn in b) or (ge.from_turn in b and ge.to_turn in a):
                    return gi
        return None

    per_type: Dict[str, DimMetric] = {t: DimMetric(label=t) for t in SCORED_EDGE_TYPES}
    overall = DimMetric(label="edges (any type, undirected)")
    overall_directed = DimMetric(label="edges (any type, directed)")

    # Precision: iterate extracted edges of scored types.
    for rtype, a, b, desc in extracted:
        if rtype not in SCORED_EDGE_TYPES:
            continue
        m = per_type[rtype]
        m.precision_total += 1
        overall.precision_total += 1
        overall_directed.precision_total += 1
        if _match(rtype, a, b, directed=False) is not None:
            m.precision_hit += 1
            overall.precision_hit += 1
        else:
            m.false_positives.append(desc)
            overall.false_positives.append(desc)
        if _match(rtype, a, b, directed=True) is not None:
            overall_directed.precision_hit += 1

    # Recall: iterate GT edges, see if any extracted edge matches.
    for ge in gt_edges:
        m = per_type[ge.type]
        m.recall_total += 1
        overall.recall_total += 1
        overall_directed.recall_total += 1
        desc = f"{ge.type}: {ge.from_turn}->{ge.to_turn}"
        matched_undirected = any(
            rtype == ge.type and (
                (ge.from_turn in a and ge.to_turn in b) or (ge.from_turn in b and ge.to_turn in a)
            )
            for rtype, a, b, _ in extracted
        )
        matched_directed = any(
            rtype == ge.type and (ge.from_turn in a and ge.to_turn in b)
            for rtype, a, b, _ in extracted
        )
        if matched_undirected:
            m.recall_hit += 1
            overall.recall_hit += 1
        else:
            m.missed.append(desc)
            overall.missed.append(desc)
        if matched_directed:
            overall_directed.recall_hit += 1

    return per_type, overall, overall_directed


# ── Claim scoring (factual only) ─────────────────────────────────────────────

def _score_claims_factual(
    convo: SyntheticConversation,
    nodes: List[Dict[str, Any]],
) -> DimMetric:
    gt_factual = [c for c in convo.ground_truth.claims if c.type == "factual"]
    extracted_claims: List[str] = []
    for n in nodes:
        for c in n.get("claims", []) or []:
            s = str(c).strip()
            if s:
                extracted_claims.append(s)
    extracted_tok = [(s, tokenize(s)) for s in extracted_claims]

    m = DimMetric(label="claims (factual)")
    m.recall_total = len(gt_factual)
    for claim in gt_factual:
        ctoks = tokenize(claim.text)
        found = any(containment(ctoks, et) >= 0.5 for _, et in extracted_tok)
        if found:
            m.recall_hit += 1
        else:
            m.missed.append(f"{claim.turn}: {claim.text}")

    m.precision_total = len(extracted_claims)
    gt_tok = [tokenize(c.text) for c in gt_factual]
    for s, et in extracted_tok:
        if any(containment(gt, et) >= 0.5 or containment(et, gt) >= 0.5 for gt in gt_tok):
            m.precision_hit += 1
        else:
            m.false_positives.append(s)
    return m


# ── Top-level entry point ────────────────────────────────────────────────────

def score_extraction(
    convo: SyntheticConversation,
    nodes: List[Dict[str, Any]],
    *,
    provider: str = "",
    backend_label: str = "",
) -> ScoreReport:
    coverage = compute_node_coverage(convo, nodes)
    report = ScoreReport(
        slug=convo.slug,
        provider=provider,
        backend_label=backend_label,
        node_count=len(nodes),
    )
    report.flag_metrics = _score_flags(convo, nodes, coverage)
    per_type, overall, overall_directed = _score_edges(convo, nodes, coverage)
    report.edge_metrics = per_type
    report.edge_overall = overall
    report.edge_overall_directed = overall_directed
    report.claim_factual = _score_claims_factual(convo, nodes)

    # Note the out-of-scope claim types so the reader isn't misled.
    n_norm = sum(1 for c in convo.ground_truth.claims if c.type == "normative")
    n_world = sum(1 for c in convo.ground_truth.claims if c.type == "worldview")
    if n_norm or n_world:
        report.notes.append(
            f"{n_norm} normative + {n_world} worldview claim(s) in ground truth are "
            "NOT scored in generate-mode (handled by the separate three-layer claim detector)."
        )
    avg_cov = sum(len(c) for c in coverage) / len(coverage) if coverage else 0.0
    uncovered = sum(1 for c in coverage if not c)
    report.notes.append(
        f"alignment: {len(nodes)} nodes, avg {avg_cov:.1f} turns/node, "
        f"{uncovered} node(s) covered no turn (possible hallucinated/over-abstract nodes)."
    )
    return report
