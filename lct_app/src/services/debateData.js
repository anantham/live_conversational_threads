/**
 * Debate data — the two-level shared-debate view's compute layer.
 *
 * Level 1: every argument node becomes ONE card holding its verbatim,
 * timestamped source message plus an AI tag (claim / evidence / question /
 * assumption, and a derived "counter" role). The AI's job here is only to
 * sort and filter — no synthesis, no editorial cards.
 *
 * Level 2: relationsAround(node) — the clicked idea centered, every
 * connected card grouped by relation kind, each with the extraction's own
 * one-line explanation of HOW it relates (edge relation_text), not a vague
 * type word.
 *
 * Edge semantics (matches the graph reader): an entry
 * {related_node: B, relation_type: "rebuts"} on node A means A rebuts B.
 */

const ATTACK_TYPES = new Set(["rebuts", "disagrees", "disagreement", "refutes"]);
const SUPPORT_TYPES = new Set(["supports", "agrees", "agreement", "affirms"]);
const ARGUMENT_CLAIM_TYPES = new Set(["claim", "evidence", "question", "assumption", "definition", "value"]);

const DAY = 86400;

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

export function fmtClock(ts) {
  if (!isWallClock(ts)) return null;
  try {
    return new Date(ts * 1000).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return null;
  }
}

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

function nodeDate(node) {
  const ts = node?.timestamp_start;
  return Number.isFinite(ts) ? ts : null;
}

/** First linked utterance = the card's verbatim source message. */
function quoteFor(node, utteranceById) {
  const ids = Array.isArray(node?.utterance_ids) ? node.utterance_ids : [];
  for (const id of ids) {
    const u = utteranceById.get(String(id));
    if (u && typeof u.text === "string" && u.text.trim()) {
      const ts = u.timestamp ?? u.timestamp_start ?? u.start_time ?? null;
      // The vision pass left "[Image: caption]" in the text; when the real
      // image rides along, the bracket becomes redundant on screen — keep
      // the caption separately as the image's alt text.
      const raw = u.text.replace(/<This message was edited>/gi, "").trim();
      const imageCaption = (raw.match(/\[Image:\s*([^\]]*)\]/) || [])[1] || "";
      return {
        text: u.image ? raw.replace(/\[Image:[^\]]*\]/g, "").replace(/\s{2,}/g, " ").trim() : raw,
        speaker: u.speaker || u.speaker_id || "",
        ts: Number.isFinite(ts) ? ts : null,
        image: typeof u.image === "string" ? u.image : null,
        imageAlt: imageCaption,
      };
    }
  }
  return null;
}

/**
 * Build the card set + move list for one debate snapshot.
 * Returns { empty } or { cards, byId, moves, span, speakers, tags }.
 */
export function buildDebateData(nodes, utterances) {
  const list = Array.isArray(nodes) ? nodes : [];
  const utteranceById = new Map(
    (Array.isArray(utterances) ? utterances : []).map((u) => [String(u.id), u])
  );

  // Statement-level nodes only: topic/theme/arc umbrella nodes (levels 3-5)
  // also carry a default claim_type in some extractions, but they're
  // hierarchy, not utterances — they'd appear as orphaned duplicate cards.
  const argNodes = list.filter(
    (n) =>
      ARGUMENT_CLAIM_TYPES.has(normType(n.claim_type)) &&
      (n.semantic_level == null || n.semantic_level <= 2)
  );
  if (argNodes.length === 0) return { empty: true };

  const byName = new Map();
  argNodes.forEach((n) => {
    if (n.node_name) byName.set(String(n.node_name).toLowerCase(), n);
  });

  const moves = [];
  argNodes.forEach((actor) => {
    (actor.edge_relations || []).forEach((e) => {
      if (!e || typeof e !== "object") return;
      const target = byName.get(String(e.related_node || "").toLowerCase());
      if (!target || target.id === actor.id) return;
      moves.push({
        actor,
        target,
        type: normType(e.relation_type),
        text: (e.relation_text || "").trim(),
        date: nodeDate(actor),
      });
    });
  });

  const outAttack = new Set();
  const inAttack = new Map();
  const inSupport = new Map();
  moves.forEach((m) => {
    if (ATTACK_TYPES.has(m.type)) {
      outAttack.add(m.actor.id);
      inAttack.set(m.target.id, (inAttack.get(m.target.id) || 0) + 1);
    } else if (SUPPORT_TYPES.has(m.type)) {
      inSupport.set(m.target.id, (inSupport.get(m.target.id) || 0) + 1);
    }
  });

  const cards = argNodes
    .map((n) => {
      const quote = quoteFor(n, utteranceById);
      const tag = normType(n.claim_type);
      return {
        node: n,
        tag,
        // Rhetorical/Socratic questions ("what is buddhism?") are typed as
        // claims by the extraction — the MOVE is an assertion — but readers
        // expect question-shaped messages under the questions filter. Any
        // card whose verbatim text asks something matches both.
        asksQuestion: tag === "question" || Boolean(quote && /\?/.test(quote.text)),
        isCounter: outAttack.has(n.id),
        pushbackCount: inAttack.get(n.id) || 0,
        supportCount: inSupport.get(n.id) || 0,
        quote,
        date: nodeDate(n),
      };
    })
    .sort((a, b) => (a.date ?? Infinity) - (b.date ?? Infinity));

  const dates = cards.map((c) => c.date).filter((t) => t !== null);
  const speakers = [...new Set(argNodes.map((n) => n.speaker_id).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
  const tags = [...new Set(cards.map((c) => c.tag))];

  return {
    empty: false,
    cards,
    byId: new Map(cards.map((c) => [c.node.id, c])),
    moves,
    span: {
      start: dates.length ? Math.min(...dates) : null,
      end: dates.length ? Math.max(...dates) : null,
    },
    speakers,
    tags,
  };
}

/**
 * Level-1 ordering + filtering.
 * sort: "oldest" | "newest"; tag: "" | claim_type | "counter"; speaker: "" | id.
 */
export function orderQuoteCards(cards, { sort = "oldest", tag = "", speaker = "" } = {}) {
  let list = Array.isArray(cards) ? [...cards] : [];
  if (tag === "counter") list = list.filter((c) => c.isCounter);
  else if (tag === "question") list = list.filter((c) => c.asksQuestion || c.tag === "question");
  else if (tag) list = list.filter((c) => c.tag === tag);
  if (speaker) list = list.filter((c) => c.node.speaker_id === speaker);
  if (sort === "newest") list.sort((a, b) => (b.date ?? -Infinity) - (a.date ?? -Infinity));
  else list.sort((a, b) => (a.date ?? Infinity) - (b.date ?? Infinity));
  return list;
}

const SECTION_ORDER = ["pushback", "tension", "support", "outgoing", "context"];
const SECTION_TITLES = {
  pushback: "Pushback on this",
  tension: "In tension with",
  support: "Support for this",
  outgoing: "What this responds to",
  context: "Context",
};

function sectionOf(move, focusIsTarget) {
  if (move.type === "contradicts") return "tension";
  if (ATTACK_TYPES.has(move.type)) return focusIsTarget ? "pushback" : "outgoing";
  if (SUPPORT_TYPES.has(move.type)) return focusIsTarget ? "support" : "outgoing";
  return "context";
}

/**
 * Level 2: everything connected to one node, grouped, each entry carrying
 * the extraction's own explanation of the link.
 * Returns [{ key, title, entries: [{ other, text, type, incoming }] }].
 */
/**
 * "As it happened" pacing: extra vertical space between consecutive cards,
 * log-scaled so minutes stay tight and days breathe, with a human label
 * once the silence is long enough to mean something (>= 6 h).
 * Returns { extraPx, label }.
 */
export function pacingGap(prevTs, ts) {
  if (!Number.isFinite(prevTs) || !Number.isFinite(ts)) return { extraPx: 0, label: null };
  const dt = ts - prevTs;
  if (dt <= 300) return { extraPx: 0, label: null };
  const extraPx = Math.min(96, Math.round(18 * Math.log10(dt / 300)));
  const label = dt >= 6 * 3600 ? `${fmtSpan(dt)} later` : null;
  return { extraPx, label };
}

const RELATION_WEIGHT = { pushback: 0, tension: 0, support: 1, outgoing: 2, context: 3 };

/**
 * The focus view's narrative thread: the focal card plus every 1-hop
 * connected card, time-ordered like the chat itself. Each related entry
 * carries its strongest relation to the focal node (typed moves outrank
 * contextual links) with the extraction's explanation.
 * Returns { before: [...], focal: entry, after: [...] } where an entry is
 * { card, relation?: { key, type, text } }.
 */
export function focusThread(focalNode, moves, byId) {
  const best = new Map();
  (Array.isArray(moves) ? moves : []).forEach((m) => {
    let other = null;
    let incoming = false;
    if (m.target?.id === focalNode.id) {
      other = m.actor;
      incoming = true;
    } else if (m.actor?.id === focalNode.id) {
      other = m.target;
      incoming = false;
    }
    if (!other) return;
    const key = sectionOf(m, incoming);
    const existing = best.get(other.id);
    if (
      !existing ||
      RELATION_WEIGHT[key] < RELATION_WEIGHT[existing.key] ||
      (existing.key === key && !existing.text && m.text)
    ) {
      best.set(other.id, { key, type: m.type, text: m.text });
    }
  });

  const entries = [];
  best.forEach((relation, id) => {
    const card = byId.get(id);
    if (card) entries.push({ card, relation });
  });
  entries.sort((a, b) => (a.card.date ?? Infinity) - (b.card.date ?? Infinity));

  const focalCard = byId.get(focalNode.id);
  const focalDate = focalCard?.date ?? null;
  const before = entries.filter((e) => (e.card.date ?? Infinity) <= (focalDate ?? -Infinity));
  const after = entries.filter((e) => !before.includes(e));
  return { before, focal: { card: focalCard, relation: null }, after };
}

export function relationsAround(node, moves) {
  const buckets = new Map();
  const seen = new Set();
  (Array.isArray(moves) ? moves : []).forEach((m) => {
    let other = null;
    let incoming = false;
    if (m.target?.id === node.id) {
      other = m.actor;
      incoming = true;
    } else if (m.actor?.id === node.id) {
      other = m.target;
      incoming = false;
    }
    if (!other) return;
    const key = sectionOf(m, incoming);
    // One entry per (section, other node); richer text wins over empty.
    const dedupeKey = `${key}:${other.id}`;
    if (seen.has(dedupeKey)) {
      if (m.text) {
        const existing = buckets.get(key)?.find((e) => e.other.id === other.id);
        if (existing && !existing.text) existing.text = m.text;
      }
      return;
    }
    seen.add(dedupeKey);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ other, text: m.text, type: m.type, incoming });
  });
  return SECTION_ORDER.filter((k) => buckets.has(k)).map((k) => ({
    key: k,
    title: SECTION_TITLES[k],
    entries: buckets.get(k),
  }));
}
