/**
 * Debate view — two levels.
 *
 * Level 1: every card is a verbatim, timestamped message with an AI tag
 * (claim / evidence / question / assumption, plus a derived "counters"
 * role). The AI only sorts and filters here — it authors nothing.
 *
 * Level 2 (tap a card): that idea centered, every connected card grouped
 * around it, each connection carrying the extraction's own one-line
 * explanation of HOW it relates.
 *
 * The same feed renders locally (backend fetch, map one tap away) and on
 * the public encrypted-snapshot page (/debate/s, no backend at all).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import PropTypes from "prop-types";
import { ArrowLeft, Check, Copy, Map as MapIcon } from "lucide-react";

import { apiFetchCached, readErrorMessage } from "../services/apiClient";
import { fetchConversationUtterances } from "../services/speakerNamingApi";
import { normalizeGraphNode } from "../components/graphNormalization";
import {
  buildDebateData,
  fmtClock,
  fmtDate,
  orderQuoteCards,
  relationsAround,
} from "../services/debateData";

const INK = "#1e293b";
const INK_SOFT = "#374151";
const META = "#64748b";

const TAG_STYLES = {
  claim: { bg: "#dbeafe", color: "#1d4ed8", label: "claim" },
  evidence: { bg: "#dcfce7", color: "#15803d", label: "evidence" },
  question: { bg: "#fef3c7", color: "#b45309", label: "question" },
  assumption: { bg: "#ede9fe", color: "#6d28d9", label: "assumption" },
  definition: { bg: "#ccfbf1", color: "#0f766e", label: "definition" },
  value: { bg: "#fce7f3", color: "#be185d", label: "value" },
};

const RELATION_STYLES = {
  pushback: "#b91c1c",
  tension: "#a21caf",
  support: "#15803d",
  outgoing: "#b45309",
  context: "#64748b",
};

/** graph_data arrives in several vintages; the feed needs the flat node set. */
function flattenGraphNodes(payload, depth = 0) {
  if (depth > 4 || !payload) return [];
  if (Array.isArray(payload)) return payload.flatMap((item) => flattenGraphNodes(item, depth + 1));
  if (typeof payload === "object") {
    if (typeof payload.node_name === "string" || typeof payload.id === "string") return [payload];
    if (Array.isArray(payload.nodes)) return flattenGraphNodes(payload.nodes, depth + 1);
    if (Array.isArray(payload.graph_data)) return flattenGraphNodes(payload.graph_data, depth + 1);
  }
  return [];
}

function TagChip({ tag, isCounter }) {
  const s = TAG_STYLES[tag] || { bg: "#f1f5f9", color: META, label: tag || "note" };
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="rounded-full px-2 py-0.5 text-[10px] font-medium"
        style={{ background: s.bg, color: s.color }}
      >
        {s.label}
      </span>
      {isCounter ? (
        <span className="text-[10px] font-medium" style={{ color: RELATION_STYLES.pushback }}>
          counters
        </span>
      ) : null}
    </span>
  );
}

TagChip.propTypes = {
  tag: PropTypes.string,
  isCounter: PropTypes.bool,
};

function CopyButton({ text, copyKey, copiedKey, onCopy }) {
  const copied = copiedKey === copyKey;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onCopy(copyKey, text);
      }}
      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors duration-150 hover:bg-gray-50"
      style={{ color: copied ? "#16a34a" : META }}
      title="Copy the message, then paste it in WhatsApp search to jump there and reply"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? "Copied · paste in WhatsApp search" : "Copy to reply"}
    </button>
  );
}

CopyButton.propTypes = {
  text: PropTypes.string.isRequired,
  copyKey: PropTypes.string.isRequired,
  copiedKey: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
};

/** One verbatim message, tagged. The whole card opens the focus view. */
function QuoteCard({ card, copiedKey, onCopy, onFocus, compact, highlight }) {
  const quote = card.quote;
  const counts = [
    card.pushbackCount ? `${card.pushbackCount} pushback${card.pushbackCount > 1 ? "s" : ""}` : null,
    card.supportCount ? `${card.supportCount} support` : null,
  ].filter(Boolean);
  return (
    <article
      className={`rounded-xl border bg-white ${compact ? "px-3 py-2.5" : "px-4 py-3.5"} ${
        onFocus ? "cursor-pointer transition-colors duration-150 hover:border-gray-300" : ""
      }`}
      style={{ borderColor: highlight ? INK_SOFT : "#e5e7eb" }}
      onClick={onFocus ? () => onFocus(card.node.id) : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <TagChip tag={card.tag} isCounter={card.isCounter} />
        {!compact && counts.length > 0 ? (
          <span className="shrink-0 text-[10px]" style={{ color: META }}>
            {counts.join(" · ")}
          </span>
        ) : null}
      </div>
      {quote ? (
        <blockquote
          className={`mt-2 leading-relaxed ${compact ? "text-[13px]" : "text-[15px]"}`}
          style={
            compact || !onFocus
              ? { color: INK }
              : {
                  color: INK,
                  display: "-webkit-box",
                  WebkitLineClamp: 7,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }
          }
        >
          “{compact && quote.text.length > 180 ? `${quote.text.slice(0, 180).trimEnd()}…` : quote.text}”
        </blockquote>
      ) : (
        <p className={`mt-2 leading-snug ${compact ? "text-[13px]" : "text-[15px]"}`} style={{ color: INK }}>
          {card.node.node_name}
        </p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs" style={{ color: META }}>
          {[card.node.speaker_id || quote?.speaker, fmtClock(quote?.ts) || fmtDate(card.date)]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {quote ? (
          <CopyButton text={quote.text} copyKey={`q:${card.node.id}`} copiedKey={copiedKey} onCopy={onCopy} />
        ) : null}
      </div>
    </article>
  );
}

QuoteCard.propTypes = {
  card: PropTypes.shape({
    node: PropTypes.object.isRequired,
    tag: PropTypes.string,
    isCounter: PropTypes.bool,
    pushbackCount: PropTypes.number,
    supportCount: PropTypes.number,
    quote: PropTypes.shape({ text: PropTypes.string, speaker: PropTypes.string, ts: PropTypes.number }),
    date: PropTypes.number,
  }).isRequired,
  copiedKey: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onFocus: PropTypes.func,
  compact: PropTypes.bool,
  highlight: PropTypes.bool,
};

/** Level 2: the clicked idea centered, its connections grouped and explained. */
function FocusView({ card, data, copiedKey, onCopy, onFocus, onBack }) {
  const sections = useMemo(() => relationsAround(card.node, data.moves), [card, data]);
  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-3 flex items-center gap-1.5 rounded px-1.5 py-1 text-sm transition-colors duration-150 hover:bg-gray-100"
        style={{ color: INK_SOFT }}
      >
        <ArrowLeft size={15} /> All messages
      </button>

      <div className="mb-1 text-[11px] font-medium" style={{ color: META }}>
        The idea, in their words
      </div>
      <QuoteCard card={card} copiedKey={copiedKey} onCopy={onCopy} highlight />
      <p className="mt-2 text-[12px] leading-snug" style={{ color: META }}>
        {card.node.node_name}
      </p>

      {sections.length === 0 ? (
        <p className="mt-5 text-sm" style={{ color: META }}>
          Nothing else connects to this message yet — it stands on its own.
        </p>
      ) : (
        sections.map((section) => (
          <section key={section.key} className="mt-5">
            <h2 className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: RELATION_STYLES[section.key] }}>
              {section.title}
            </h2>
            <div className="mt-2 space-y-3">
              {section.entries.map((entry) => {
                const other = data.byId.get(entry.other.id);
                return (
                  <div key={`${section.key}:${entry.other.id}`}>
                    {entry.text ? (
                      <p className="mb-1 text-[12px] italic leading-snug" style={{ color: INK_SOFT }}>
                        {entry.text}
                      </p>
                    ) : null}
                    {other ? (
                      <QuoteCard card={other} copiedKey={copiedKey} onCopy={onCopy} onFocus={onFocus} compact />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

FocusView.propTypes = {
  card: PropTypes.object.isRequired,
  data: PropTypes.object.isRequired,
  copiedKey: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onFocus: PropTypes.func.isRequired,
  onBack: PropTypes.func.isRequired,
};

export function DebateSkeleton() {
  return (
    <div className="space-y-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-xl border border-gray-200 bg-white px-4 py-4">
          <div className="h-2.5 w-16 animate-pulse rounded bg-gray-100 motion-reduce:animate-none" />
          <div className="mt-3 h-4 w-4/5 animate-pulse rounded bg-gray-100 motion-reduce:animate-none" />
          <div className="mt-2 h-4 w-3/5 animate-pulse rounded bg-gray-100 motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

/** Shared view-model: data + the copy-to-reply interaction. */
export function useDebateView(nodes, utterances) {
  const [copiedKey, setCopiedKey] = useState(null);
  const data = useMemo(
    () => (nodes ? buildDebateData(nodes, utterances) : null),
    [nodes, utterances]
  );
  const onCopy = (key, text) => {
    try {
      navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2200);
    } catch {
      // clipboard unavailable: the quote is selectable text
    }
  };
  return { data, copiedKey, onCopy };
}

/** The two-level feed. */
export function DebateFeed({ title, view, onOpenMap }) {
  const { data, copiedKey, onCopy } = view;
  const [sort, setSort] = useState("oldest");
  const [tag, setTag] = useState("");
  const [speaker, setSpeaker] = useState("");
  const [focusId, setFocusId] = useState(null);
  const feedScrollRef = useRef(0);

  const cards = useMemo(
    () => orderQuoteCards(data?.cards || [], { sort, tag, speaker }),
    [data, sort, tag, speaker]
  );

  if (!data || data.empty) return null;

  const focusCard = focusId ? data.byId.get(focusId) : null;
  const enterFocus = (id) => {
    feedScrollRef.current = typeof window !== "undefined" ? window.scrollY : 0;
    setFocusId(id);
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  };
  const exitFocus = () => {
    setFocusId(null);
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => window.scrollTo({ top: feedScrollRef.current }));
    }
  };

  const dateRange =
    data.span.start && data.span.end && fmtDate(data.span.start)
      ? `${fmtDate(data.span.start)} – ${fmtDate(data.span.end)}`
      : "";
  const hasCounters = data.cards.some((c) => c.isCounter);
  const tagChips = [
    { key: "", label: "All" },
    ...data.tags.map((t) => ({ key: t, label: `${TAG_STYLES[t]?.label || t}s` })),
    ...(hasCounters ? [{ key: "counter", label: "counters" }] : []),
  ];
  const selectClass =
    "rounded-md border border-gray-200 bg-white px-2 py-1 text-xs focus:border-gray-400 focus:outline-none";

  if (focusCard) {
    return (
      <FocusView
        card={focusCard}
        data={data}
        copiedKey={copiedKey}
        onCopy={onCopy}
        onFocus={enterFocus}
        onBack={exitFocus}
      />
    );
  }

  return (
    <>
      <div className="mb-5">
        <h1
          className="text-2xl font-semibold leading-tight"
          style={{ color: INK, letterSpacing: "-0.02em", textWrap: "balance" }}
        >
          {title || "The debate"}
        </h1>
        <p className="mt-1.5 text-[13px]" style={{ color: META }}>
          {dateRange ? `${dateRange} · ` : ""}everyone&apos;s actual words, in order. Tap a card to
          see what connects to it.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {tagChips.map((c) => {
          const active = tag === c.key;
          return (
            <button
              key={c.key || "all"}
              type="button"
              onClick={() => setTag(active && c.key ? "" : c.key)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors duration-150 ${
                active
                  ? "border-gray-500 bg-gray-800 text-white"
                  : "border-gray-200 bg-white hover:bg-gray-50"
              }`}
              style={active ? undefined : { color: INK_SOFT }}
            >
              {c.label}
            </button>
          );
        })}
        <span className="flex-1" />
        <select
          aria-label="Order cards"
          className={selectClass}
          style={{ color: INK_SOFT }}
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="oldest">Oldest first</option>
          <option value="newest">Newest first</option>
        </select>
        {data.speakers.length > 1 ? (
          <select
            aria-label="Filter by speaker"
            className={selectClass}
            style={{ color: INK_SOFT }}
            value={speaker}
            onChange={(e) => setSpeaker(e.target.value)}
          >
            <option value="">Everyone</option>
            {data.speakers.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <div className="space-y-3">
        {cards.map((card) => (
          <QuoteCard
            key={card.node.id}
            card={card}
            copiedKey={copiedKey}
            onCopy={onCopy}
            onFocus={enterFocus}
          />
        ))}
        {cards.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-6 text-center text-sm" style={{ color: META }}>
            Nothing matches this filter.
          </div>
        ) : null}

        <section className="rounded-xl border border-gray-200 bg-white px-4 py-5 text-center">
          {onOpenMap ? (
            <button
              type="button"
              onClick={onOpenMap}
              className="inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90"
              style={{ background: INK }}
            >
              <MapIcon size={15} /> Open the full map
            </button>
          ) : (
            <p className="text-sm leading-relaxed" style={{ color: INK_SOFT }}>
              These are the group&apos;s own messages, tagged and connected by an AI so the argument
              is easier to follow. If a tag or connection reads wrong, that&apos;s a defect in the
              map — say so in the group and it gets fixed.
            </p>
          )}
          <p className="mt-3 text-xs leading-relaxed" style={{ color: META }}>
            To join in: copy any quote, paste it in WhatsApp search, reply there.
          </p>
        </section>
      </div>
    </>
  );
}

DebateFeed.propTypes = {
  title: PropTypes.string,
  view: PropTypes.shape({
    data: PropTypes.object,
    copiedKey: PropTypes.string,
    onCopy: PropTypes.func.isRequired,
  }).isRequired,
  onOpenMap: PropTypes.func,
};

/** Local page: fetches from the backend; the map stays one tap away. */
export default function DebateReport() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const [nodes, setNodes] = useState(null);
  const [utterances, setUtterances] = useState([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const resp = await apiFetchCached(`/conversations/${conversationId}`, { ttlMs: 5 * 60 * 1000 });
        if (!resp.ok) throw new Error(await readErrorMessage(resp));
        const payload = await resp.json();
        if (cancelled) return;
        const flat = flattenGraphNodes(payload.graph_data)
          .map((item, i) => normalizeGraphNode(item, i))
          .filter(Boolean);
        setNodes(flat);
        if (typeof payload.conversation_title === "string" && payload.conversation_title.trim()) {
          setTitle(payload.conversation_title.trim());
        }
        try {
          const list = await apiFetchCached("/conversations/", { ttlMs: 60 * 1000 });
          if (list.ok) {
            const rows = await list.json();
            const match = Array.isArray(rows) ? rows.find((r) => r?.file_id === conversationId) : null;
            if (!cancelled && match?.file_name) setTitle((t) => t || match.file_name);
          }
        } catch {
          // name lookup is cosmetic
        }
        try {
          const u = await fetchConversationUtterances(conversationId);
          if (!cancelled) setUtterances(Array.isArray(u?.utterances) ? u.utterances : []);
        } catch {
          // quotes degrade to node titles without utterances
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || "Unable to load the conversation.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const view = useDebateView(nodes, utterances);
  const openMap = () => navigate(`/conversation/${conversationId}`);

  return (
    <div className="min-h-screen" style={{ background: "#fdfdfb" }}>
      <header
        className="sticky top-0 z-20 border-b border-gray-100"
        style={{ background: "rgba(253,253,251,0.92)", backdropFilter: "blur(6px)" }}
      >
        <div className="mx-auto flex h-12 max-w-[560px] items-center justify-between px-4">
          <button
            type="button"
            onClick={openMap}
            className="flex items-center gap-1.5 rounded px-1.5 py-1 text-sm transition-colors duration-150 hover:bg-gray-100"
            style={{ color: INK_SOFT }}
          >
            <ArrowLeft size={15} /> Map
          </button>
          <span />
        </div>
      </header>

      <main className="mx-auto max-w-[560px] px-4 pb-16 pt-6">
        {loading ? (
          <DebateSkeleton />
        ) : error ? (
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-6 text-center">
            <p className="text-sm" style={{ color: INK_SOFT }}>
              {error}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-3 rounded-full border border-gray-300 px-4 py-1.5 text-sm transition-colors duration-150 hover:bg-gray-50"
              style={{ color: INK_SOFT }}
            >
              Try again
            </button>
          </div>
        ) : view.data?.empty ? (
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-6">
            <h2 className="text-base font-semibold" style={{ color: INK }}>
              No argument map yet
            </h2>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: INK_SOFT }}>
              This view reads the claim / evidence / question structure of a conversation, and this
              one hasn&apos;t been mapped that way. The graph view still works.
            </p>
            <button
              type="button"
              onClick={openMap}
              className="mt-4 rounded-full px-4 py-2 text-sm font-medium text-white transition-colors duration-150"
              style={{ background: INK }}
            >
              Open the map
            </button>
          </div>
        ) : view.data ? (
          <DebateFeed title={title} view={view} onOpenMap={openMap} />
        ) : null}
      </main>
    </div>
  );
}
