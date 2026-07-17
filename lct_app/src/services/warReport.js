/**
 * War report — query-time computation of "the state of the debate" from an
 * argument-map graph payload. No new extraction: everything derives from
 * nodes' claim_type, edge_relations, speakers, and timestamps.
 *
 * Edge semantics (matches buildArgumentStatusMapForNodes): an entry
 * `{related_node: B, relation_type: "rebuts"}` on node A means A rebuts B —
 * A is the actor, B is the target.
 */

const ATTACK_TYPES = new Set(["rebuts", "disagrees", "disagreement", "refutes"]);
const SUPPORT_TYPES = new Set(["supports", "agrees", "agreement", "affirms"]);
const ARGUMENT_CLAIM_TYPES = new Set(["claim", "evidence", "question", "assumption", "definition", "value"]);

const DAY = 86400;

/** Epoch-seconds timestamp for a node, or null. Relative live-STT seconds
 * still order correctly within one conversation; wall-clock DISPLAY is
 * guarded separately by isWallClock(). */
function nodeDate(node) {
  const ts = node?.timestamp_start;
  return Number.isFinite(ts) ? ts : null;
}

export function isWallClock(ts) {
  return Number.isFinite(ts) && ts > 1e9;
}

export function fmtDate(ts) {
  if (!isWallClock(ts)) return null;
  try {
    return new Date(ts * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  } catch {
    return null;
  }
}

/** Human duration between two epoch-second stamps: "3 h", "12 days", "5 weeks". */
export function fmtSpan(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 2 * 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 2 * DAY) return `${Math.round(seconds / 3600)} h`;
  if (seconds < 15 * DAY) return `${Math.round(seconds / DAY)} days`;
  return `${Math.round(seconds / (7 * DAY))} weeks`;
}

function normType(value) {
  return String(value || "").trim().toLowerCase();
}

/** First linked utterance (by array order) as the card receipt. */
function receiptFor(node, utteranceById) {
  const ids = Array.isArray(node?.utterance_ids) ? node.utterance_ids : [];
  for (const id of ids) {
    const u = utteranceById.get(String(id));
    if (u && typeof u.text === "string" && u.text.trim()) {
      const ts = u.timestamp ?? u.timestamp_start ?? u.start_time ?? null;
      return {
        text: u.text.trim(),
        speaker: u.speaker || u.speaker_id || "",
        ts: Number.isFinite(ts) ? ts : null,
      };
    }
  }
  return null;
}

function humanizeThreadId(threadId) {
  return String(threadId || "")
    .replace(/^thread[-_]/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

/**
 * Build the full report.
 * @param {Array} nodes normalized graph nodes (normalizeGraphDataPayload output)
 * @param {Array} utterances rows from /api/conversations/{id}/utterances
 * @returns {Object} { empty } or { stats, span, fronts, cards }
 */
export function buildWarReport(nodes, utterances) {
  const list = Array.isArray(nodes) ? nodes : [];
  const utteranceById = new Map(
    (Array.isArray(utterances) ? utterances : []).map((u) => [String(u.id), u])
  );

  const argNodes = list.filter((n) => ARGUMENT_CLAIM_TYPES.has(normType(n.claim_type)));
  if (argNodes.length === 0) {
    return { empty: true };
  }

  const byName = new Map();
  argNodes.forEach((n) => {
    if (n.node_name) byName.set(String(n.node_name).toLowerCase(), n);
  });

  // ---- moves -------------------------------------------------------------
  const attacks = [];
  const supports = [];
  const upsetsRaw = [];
  const allMoves = [];
  argNodes.forEach((actor) => {
    (actor.edge_relations || []).forEach((e) => {
      if (!e || typeof e !== "object") return;
      const type = normType(e.relation_type);
      const target = byName.get(String(e.related_node || "").toLowerCase());
      if (!target || target.id === actor.id) return;
      const move = { actor, target, type, text: e.relation_text || "", date: nodeDate(actor) };
      allMoves.push(move);
      if (type === "contradicts") upsetsRaw.push(move);
      else if (ATTACK_TYPES.has(type)) attacks.push(move);
      else if (SUPPORT_TYPES.has(type)) supports.push(move);
    });
  });

  const supportedIds = new Set(supports.map((m) => m.target.id));
  const attackedCount = new Map();
  attacks.forEach((m) => attackedCount.set(m.target.id, (attackedCount.get(m.target.id) || 0) + 1));

  const dates = argNodes.map(nodeDate).filter((t) => t !== null);
  const spanStart = dates.length ? Math.min(...dates) : null;
  const spanEnd = dates.length ? Math.max(...dates) : null;

  // ---- clashes -----------------------------------------------------------
  // Answered = return fire: a later attack whose target is the attacker's claim.
  const clashes = attacks
    .map((m) => {
      const counter = attacks
        .filter((c) => c.target.id === m.actor.id && c.date !== null && m.date !== null && c.date >= m.date)
        .sort((a, b) => a.date - b.date)[0];
      const answered = Boolean(counter);
      return {
        target: m.target,
        actor: m.actor,
        date: m.date,
        answered,
        answeredIn: answered && counter.date !== null && m.date !== null ? counter.date - m.date : null,
        standingFor: !answered && m.date !== null && spanEnd !== null ? spanEnd - m.date : null,
        crux: Boolean(m.target.is_crux || m.actor.is_crux),
      };
    })
    .sort((a, b) => {
      if (a.answered !== b.answered) return a.answered ? 1 : -1;
      if (a.crux !== b.crux) return a.crux ? -1 : 1;
      return (b.date || 0) - (a.date || 0);
    });

  // ---- upsets (self-contradictions) --------------------------------------
  const upsets = upsetsRaw
    .map((m) => ({
      later: m.actor,
      earlier: m.target,
      speaker: m.actor.speaker_id || m.target.speaker_id || "",
      text: m.text,
      date: m.date,
    }))
    .sort((a, b) => (b.date || 0) - (a.date || 0));

  // ---- open challenges ----------------------------------------------------
  const replyCount = new Map();
  [...attacks, ...supports].forEach((m) => {
    replyCount.set(m.target.id, (replyCount.get(m.target.id) || 0) + 1);
  });
  const challenges = argNodes
    .filter((n) => normType(n.claim_type) === "question")
    .map((n) => ({
      node: n,
      date: nodeDate(n),
      replies: replyCount.get(n.id) || 0,
      standingFor:
        nodeDate(n) !== null && spanEnd !== null ? spanEnd - nodeDate(n) : null,
    }))
    .sort((a, b) => a.replies - b.replies || (b.date || 0) - (a.date || 0));

  // ---- undefended ground --------------------------------------------------
  const undefended = argNodes
    .filter((n) => normType(n.claim_type) === "claim" && !supportedIds.has(n.id))
    .map((n) => ({ node: n, attacked: attackedCount.get(n.id) || 0, crux: Boolean(n.is_crux) }))
    .sort((a, b) => {
      if (a.crux !== b.crux) return a.crux ? -1 : 1;
      if (a.attacked !== b.attacked) return b.attacked - a.attacked;
      return (nodeDate(b.node) || 0) - (nodeDate(a.node) || 0);
    });

  // ---- fronts (threads) ---------------------------------------------------
  const themeTitleByThread = new Map();
  list.forEach((n) => {
    if ((n.semantic_type === "theme" || n.semantic_level === 4) && n.thread_id) {
      if (!themeTitleByThread.has(n.thread_id)) themeTitleByThread.set(n.thread_id, n.node_name);
    }
  });
  const frontMap = new Map();
  argNodes.forEach((n) => {
    if (!n.thread_id) return;
    if (!frontMap.has(n.thread_id)) {
      frontMap.set(n.thread_id, { threadId: n.thread_id, claims: 0, attacks: 0, last: null, openMove: null });
    }
    const f = frontMap.get(n.thread_id);
    if (normType(n.claim_type) === "claim") f.claims += 1;
    const d = nodeDate(n);
    if (d !== null && (f.last === null || d > f.last)) f.last = d;
  });
  attacks.forEach((m) => {
    const f = frontMap.get(m.target.thread_id) || frontMap.get(m.actor.thread_id);
    if (!f) return;
    f.attacks += 1;
  });
  clashes
    .filter((c) => !c.answered)
    .forEach((c) => {
      const f = frontMap.get(c.target.thread_id) || frontMap.get(c.actor.thread_id);
      if (f && (f.openMove === null || (c.date || 0) > (f.openMove.date || 0))) {
        f.openMove = { name: c.actor.node_name, date: c.date };
      }
    });
  const lastQuarter = spanStart !== null && spanEnd !== null ? spanEnd - (spanEnd - spanStart) * 0.25 : null;
  const fronts = [...frontMap.values()]
    .map((f) => ({
      ...f,
      title: themeTitleByThread.get(f.threadId) || humanizeThreadId(f.threadId),
      state:
        f.openMove && lastQuarter !== null && (f.openMove.date || 0) >= lastQuarter
          ? "active"
          : f.attacks > 0
            ? "contested"
            : "quiet",
    }))
    .sort((a, b) => {
      const rank = { active: 0, contested: 1, quiet: 2 };
      return rank[a.state] - rank[b.state] || b.attacks - a.attacks;
    });

  // ---- feed assembly ------------------------------------------------------
  const receipt = (n) => receiptFor(n, utteranceById);
  const cards = [];
  const clashCards = clashes.slice(0, 8).map((c) => ({
    kind: "clash",
    ...c,
    targetReceipt: receipt(c.target),
    actorReceipt: receipt(c.actor),
  }));
  const upsetCards = upsets.map((u) => ({ kind: "upset", ...u, receipt: receipt(u.later) }));
  const challengeCards = challenges.slice(0, 6).map((q) => ({ kind: "challenge", ...q, receipt: receipt(q.node) }));

  // Weave for scroll rhythm: clash, upset, clash, challenge, repeat.
  const lanes = [clashCards, upsetCards, clashCards, challengeCards];
  const cursors = [0, 0, 0, 0];
  const seen = new Set();
  let exhausted = 0;
  while (exhausted < lanes.length) {
    exhausted = 0;
    for (let i = 0; i < lanes.length; i += 1) {
      const lane = lanes[i];
      let picked = null;
      while (cursors[i] < lane.length) {
        const candidate = lane[cursors[i]];
        cursors[i] += 1;
        const key = candidate.kind + ":" + (candidate.target?.id || candidate.later?.id || candidate.node?.id) + ":" + (candidate.actor?.id || "");
        if (!seen.has(key)) {
          seen.add(key);
          picked = candidate;
          break;
        }
      }
      if (picked) cards.push(picked);
      else exhausted += 1;
    }
  }

  const stats = {
    claims: argNodes.filter((n) => normType(n.claim_type) === "claim").length,
    attacks: attacks.length,
    upsets: upsets.length,
    openQuestions: challenges.filter((q) => q.replies === 0).length,
    unsupported: undefended.length,
    speakers: new Set(argNodes.map((n) => n.speaker_id).filter(Boolean)).size,
  };

  return {
    empty: false,
    stats,
    span: { start: spanStart, end: spanEnd },
    fronts,
    cards,
    moves: allMoves,
    undefended: undefended.slice(0, 5).map((u) => ({ ...u, receipt: receipt(u.node) })),
    undefendedTotal: undefended.length,
  };
}

// ---- card ordering & filtering (the feed's sort/filter dropdowns) --------

/** The single date a card sorts by. */
export function cardDate(card) {
  if (card.kind === "clash") return card.date ?? null;
  if (card.kind === "upset") return card.date ?? null;
  if (card.kind === "challenge") return card.date ?? null;
  return null;
}

/** Speakers a card involves (for the "who said what" filter). */
export function cardSpeakers(card) {
  const out = new Set();
  const add = (s) => {
    if (s && String(s).trim()) out.add(String(s).trim());
  };
  if (card.kind === "clash") {
    add(card.target?.speaker_id);
    add(card.actor?.speaker_id);
  } else if (card.kind === "upset") {
    add(card.speaker);
  } else if (card.kind === "challenge") {
    add(card.node?.speaker_id);
  }
  return [...out];
}

/**
 * Order + filter the feed's cards.
 * sort: "story" (the built weave) | "oldest" | "newest"
 * speaker: "" (everyone) or an exact speaker id
 */
export function orderCards(cards, { sort = "story", speaker = "" } = {}) {
  let list = Array.isArray(cards) ? [...cards] : [];
  if (speaker) {
    list = list.filter((c) => cardSpeakers(c).includes(speaker));
  }
  if (sort === "oldest") {
    list.sort((a, b) => (cardDate(a) ?? Infinity) - (cardDate(b) ?? Infinity));
  } else if (sort === "newest") {
    list.sort((a, b) => (cardDate(b) ?? -Infinity) - (cardDate(a) ?? -Infinity));
  }
  return list;
}

// ---- argument neighborhood (the per-card tree) ----------------------------

const TREE_RELATION_LABELS = {
  rebuts: "countered by",
  disagrees: "countered by",
  refutes: "countered by",
  supports: "supported by",
  agrees: "supported by",
  affirms: "supported by",
  contradicts: "contradicted by",
  clarifies: "clarified by",
  asks: "questioned by",
  contextual: "related",
};

function treeLabel(type, incoming) {
  if (incoming) return TREE_RELATION_LABELS[type] || `${type} by`;
  // Outgoing: this node acting on another.
  const out = {
    rebuts: "counters",
    disagrees: "counters",
    refutes: "counters",
    supports: "supports",
    agrees: "supports",
    affirms: "supports",
    contradicts: "contradicts",
    clarifies: "clarifies",
    asks: "asks about",
    contextual: "related",
  };
  return out[type] || type;
}

/**
 * Local argument tree around a node: incoming moves (what lands ON it) and
 * outgoing moves (what it acts on), recursively to `depth`, cycle-safe.
 * Returns { node, children: [{ label, type, incoming, node, children }] }.
 */
export function buildArgumentTree(rootNode, moves, depth = 2) {
  const list = Array.isArray(moves) ? moves : [];
  const expand = (node, remaining, seen) => {
    if (remaining <= 0) return [];
    const children = [];
    list.forEach((m) => {
      let other = null;
      let incoming = false;
      if (m.target?.id === node.id) {
        other = m.actor;
        incoming = true;
      } else if (m.actor?.id === node.id) {
        other = m.target;
        incoming = false;
      }
      if (!other || seen.has(other.id)) return;
      seen.add(other.id);
      children.push({
        label: treeLabel(m.type, incoming),
        type: m.type,
        incoming,
        node: other,
        children: [],
      });
    });
    // Typed argument moves outrank weak contextual links in the display.
    const weight = (t) =>
      ATTACK_TYPES.has(t) || t === "contradicts" ? 0 : SUPPORT_TYPES.has(t) ? 1 : t === "contextual" ? 3 : 2;
    children.sort((a, b) => weight(a.type) - weight(b.type));
    // Recurse only after the whole level is claimed — a shared `seen` with
    // depth-first recursion would let a deep branch swallow a node that
    // belongs beside it as a sibling of the root.
    children.forEach((child) => {
      child.children = expand(child.node, remaining - 1, seen);
    });
    return children;
  };
  const seen = new Set([rootNode.id]);
  return { node: rootNode, children: expand(rootNode, depth, seen) };
}
