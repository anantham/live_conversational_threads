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
import { useLocation, useNavigate, useParams } from "react-router-dom";
import PropTypes from "prop-types";
import { ArrowLeft, Check, Copy, Map as MapIcon } from "lucide-react";

import { apiFetchCached, readErrorMessage } from "../services/apiClient";
import { fetchConversationUtterances } from "../services/speakerNamingApi";
import { normalizeGraphNode } from "../components/graphNormalization";
import { SPEAKER_COLORS } from "../components/graphConstants";
import {
  buildDebateData,
  fmtClock,
  fmtDate,
  focusThread,
  orderQuoteCards,
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

function TagChip({ tag, isCounter, asksQuestion }) {
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
      {asksQuestion && tag !== "question" ? (
        <span className="text-[10px] font-medium" style={{ color: TAG_STYLES.question.color }}>
          asks
        </span>
      ) : null}
    </span>
  );
}

TagChip.propTypes = {
  tag: PropTypes.string,
  isCounter: PropTypes.bool,
  asksQuestion: PropTypes.bool,
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
        <TagChip tag={card.tag} isCounter={card.isCounter} asksQuestion={card.asksQuestion} />
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
      ) : null}
      {quote?.image ? (
        <img
          src={quote.image}
          alt={quote.imageAlt || "image shared in the chat"}
          loading="lazy"
          className={`mt-2 w-auto rounded-lg border border-gray-100 ${compact ? "max-h-40" : "max-h-72"}`}
        />
      ) : null}
      {!quote ? (
        <p className={`mt-2 leading-snug ${compact ? "text-[13px]" : "text-[15px]"}`} style={{ color: INK }}>
          {card.node.node_name}
        </p>
      ) : null}
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
    asksQuestion: PropTypes.bool,
    pushbackCount: PropTypes.number,
    supportCount: PropTypes.number,
    quote: PropTypes.shape({
      text: PropTypes.string,
      speaker: PropTypes.string,
      ts: PropTypes.number,
      image: PropTypes.string,
      imageAlt: PropTypes.string,
    }),
    date: PropTypes.number,
  }).isRequired,
  copiedKey: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onFocus: PropTypes.func,
  compact: PropTypes.bool,
  highlight: PropTypes.bool,
};

/** Speaker -> bubble color, stable by first appearance in the thread. */
function speakerColorMap(entries) {
  const map = new Map();
  entries.forEach(({ card }) => {
    const s = card?.node.speaker_id || card?.quote?.speaker || "";
    if (s && !map.has(s)) map.set(s, SPEAKER_COLORS[map.size % SPEAKER_COLORS.length]);
  });
  return map;
}

const RELATION_CAPTIONS = {
  pushback: "pushback",
  tension: "in tension",
  support: "support",
  outgoing: "responded to",
  context: "context",
};

/** One chat bubble in the focus thread. */
function Bubble({ entry, color, focal, copiedKey, onCopy, onFocus, bubbleRef }) {
  const { card, relation } = entry;
  if (!card) return null;
  const quote = card.quote;
  const speaker = card.node.speaker_id || quote?.speaker || "";
  const clock = fmtClock(quote?.ts) || fmtDate(card.date);
  return (
    <div ref={bubbleRef}>
      {relation ? (
        <div className="mb-1 pl-1 text-[11px] leading-snug">
          <span className="font-medium" style={{ color: RELATION_STYLES[relation.key] }}>
            {RELATION_CAPTIONS[relation.key]}
          </span>
          {relation.text ? (
            <span className="italic" style={{ color: INK_SOFT }}>
              {" "}&middot; {relation.text}
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        className={"rounded-2xl px-3.5 py-2.5" + (onFocus && !focal ? " cursor-pointer" : "")}
        style={{
          background: color + "2E",
          boxShadow: focal ? "0 0 0 2px #f59e0b" : "none",
        }}
        onClick={onFocus && !focal ? () => onFocus(card.node.id) : undefined}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium" style={{ color: INK_SOFT }}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
            <span className="truncate">{speaker}</span>
          </span>
          <span className="shrink-0 text-[10px]" style={{ color: META }}>
            {clock}
          </span>
        </div>
        {quote ? (
          <blockquote
            className={"mt-1.5 leading-relaxed " + (focal ? "text-[15px]" : "text-[13px]")}
            style={{ color: INK }}
          >
            &ldquo;{quote.text}&rdquo;
          </blockquote>
        ) : null}
        {quote?.image ? (
          <img
            src={quote.image}
            alt={quote.imageAlt || "image shared in the chat"}
            loading="lazy"
            className="mt-2 max-h-72 w-auto rounded-lg border border-black/5"
          />
        ) : null}
        {!quote ? (
          <p className={"mt-1.5 leading-snug " + (focal ? "text-[15px]" : "text-[13px]")} style={{ color: INK }}>
            {card.node.node_name}
          </p>
        ) : null}
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <TagChip tag={card.tag} isCounter={card.isCounter} asksQuestion={card.asksQuestion} />
          {quote ? (
            <CopyButton text={quote.text} copyKey={"b:" + card.node.id} copiedKey={copiedKey} onCopy={onCopy} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

Bubble.propTypes = {
  entry: PropTypes.shape({ card: PropTypes.object, relation: PropTypes.object }).isRequired,
  color: PropTypes.string.isRequired,
  focal: PropTypes.bool,
  copiedKey: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onFocus: PropTypes.func,
  bubbleRef: PropTypes.object,
};

/** Level 2: the clicked idea ringed, its 1-hop neighborhood re-assembled as
 * a time-ordered chat thread with per-speaker bubble colors and a legend. */
function FocusView({ card, data, copiedKey, onCopy, onFocus, onBack }) {
  const thread = useMemo(() => focusThread(card.node, data.moves, data.byId), [card, data]);
  const all = useMemo(() => [...thread.before, thread.focal, ...thread.after], [thread]);
  const colors = useMemo(() => speakerColorMap(all), [all]);
  const focalRef = useRef(null);
  useEffect(() => {
    if (focalRef.current && thread.before.length > 0) {
      focalRef.current.scrollIntoView({ block: "center" });
    }
  }, [card.node.id, thread.before.length]);

  const rolesPresent = [...new Set(all.map((e) => e.card?.tag).filter(Boolean))];
  const colorFor = (entry) =>
    colors.get(entry.card.node.speaker_id || entry.card.quote?.speaker || "") || "#e5e7eb";

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex shrink-0 items-center gap-1.5 rounded px-1.5 py-1 text-sm transition-colors duration-150 hover:bg-gray-100"
          style={{ color: INK_SOFT }}
        >
          <ArrowLeft size={15} /> All messages
        </button>
        <div className="flex max-w-[60%] flex-wrap items-center justify-end gap-x-2 gap-y-0.5">
          {[...colors.entries()].map(([s, c]) => (
            <span key={s} className="flex items-center gap-1 text-[10px]" style={{ color: META }}>
              <span className="h-2 w-2 rounded-full" style={{ background: c }} /> {s}
            </span>
          ))}
          {rolesPresent.map((t) => (
            <span key={t} className="flex items-center gap-1 text-[10px]" style={{ color: META }}>
              <span
                className="h-2 w-2 rounded-sm"
                style={{
                  background: (TAG_STYLES[t] || {}).bg,
                  border: "1px solid " + ((TAG_STYLES[t] || {}).color || "#cbd5e1"),
                }}
              />
              {(TAG_STYLES[t] || { label: t }).label}
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {thread.before.map((entry) => (
          <Bubble
            key={entry.card.node.id}
            entry={entry}
            color={colorFor(entry)}
            copiedKey={copiedKey}
            onCopy={onCopy}
            onFocus={onFocus}
          />
        ))}
        <Bubble
          entry={thread.focal}
          color={colorFor(thread.focal)}
          focal
          copiedKey={copiedKey}
          onCopy={onCopy}
          bubbleRef={focalRef}
        />
        {thread.after.map((entry) => (
          <Bubble
            key={entry.card.node.id}
            entry={entry}
            color={colorFor(entry)}
            copiedKey={copiedKey}
            onCopy={onCopy}
            onFocus={onFocus}
          />
        ))}
        {thread.before.length === 0 && thread.after.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: META }}>
            Nothing else connects to this message yet &mdash; it stands on its own.
          </p>
        ) : null}
        <p className="pt-1 text-[11px]" style={{ color: META }}>
          The AI&rsquo;s gloss of the focused message: {card.node.node_name}
        </p>
      </div>
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
  const navigate = useNavigate();
  const location = useLocation();
  const [sort, setSort] = useState("oldest");
  const [tag, setTag] = useState("");
  const [speaker, setSpeaker] = useState("");
  const feedScrollRef = useRef(0);

  // The focused card lives in the URL (?n=<id>) as a REAL history entry:
  // the browser/gesture back closes the focus view instead of leaving the
  // page (mobile swipe-back used to land on a blank about:blank), and a
  // focused card becomes deep-linkable. The #fragment (decryption key on
  // /debate/s) is explicitly preserved on every navigation.
  const focusId = new URLSearchParams(location.search).get("n");
  const prevFocusRef = useRef(focusId);
  useEffect(() => {
    const prev = prevFocusRef.current;
    prevFocusRef.current = focusId;
    if (typeof window === "undefined") return;
    if (!prev && focusId) window.scrollTo({ top: 0 });
    if (prev && !focusId) {
      requestAnimationFrame(() => window.scrollTo({ top: feedScrollRef.current }));
    }
  }, [focusId]);

  const cards = useMemo(
    () => orderQuoteCards(data?.cards || [], { sort, tag, speaker }),
    [data, sort, tag, speaker]
  );

  if (!data || data.empty) return null;

  const focusCard = focusId ? data.byId.get(focusId) : null;
  const enterFocus = (id) => {
    if (!focusId && typeof window !== "undefined") {
      feedScrollRef.current = window.scrollY;
    }
    const params = new URLSearchParams(location.search);
    params.set("n", id);
    navigate(
      { search: `?${params.toString()}`, hash: location.hash },
      { state: { debateFocus: true } }
    );
  };
  const exitFocus = () => {
    if (location.state?.debateFocus) {
      navigate(-1);
      return;
    }
    // Deep-linked straight into a focus view: there is no feed entry behind
    // us, so strip the param in place instead of leaving the site.
    const params = new URLSearchParams(location.search);
    params.delete("n");
    navigate({ search: `?${params.toString()}`, hash: location.hash }, { replace: true });
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
        {dateRange ? (
          <p className="mt-1.5 text-[13px]" style={{ color: META }}>
            {dateRange}
          </p>
        ) : null}
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
