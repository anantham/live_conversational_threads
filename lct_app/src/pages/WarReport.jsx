/**
 * War report — the zero-decision entry surface for an argument map.
 * One vertical scroll of the debate's state: front lines, live clashes,
 * self-contradictions, open challenges, undefended ground. Every card
 * carries a verbatim receipt with a copy affordance, so "dive deeper"
 * ends as a reply in the source app (paste the quote in WhatsApp search).
 *
 * Computation is query-time from the existing graph payload (warReport.js);
 * the full map stays one tap away as the second floor.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import PropTypes from "prop-types";
import { ArrowLeft, Check, Copy, Map as MapIcon } from "lucide-react";

const nodeShape = PropTypes.shape({
  id: PropTypes.string,
  node_name: PropTypes.string,
  speaker_id: PropTypes.string,
  thread_id: PropTypes.string,
  summary: PropTypes.string,
  timestamp_start: PropTypes.number,
});
const receiptShape = PropTypes.shape({
  text: PropTypes.string,
  speaker: PropTypes.string,
  ts: PropTypes.number,
});

import { apiFetchCached, readErrorMessage } from "../services/apiClient";
import { fetchConversationUtterances } from "../services/speakerNamingApi";
import { normalizeGraphNode } from "../components/graphNormalization";
import { buildThreadColorMapForNodes } from "../components/graph/colorModes";
import { buildWarReport, fmtDate, fmtSpan, isWallClock } from "../services/warReport";

/** graph_data arrives in several vintages (flat node list, chunked arrays,
 * wrapper objects). The feed only needs the flat node set: collect every
 * node-shaped object at any depth, then run the shared normalizer. */
function flattenGraphNodes(payload, depth = 0) {
  if (depth > 4 || !payload) return [];
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => flattenGraphNodes(item, depth + 1));
  }
  if (typeof payload === "object") {
    if (typeof payload.node_name === "string" || typeof payload.id === "string") {
      return [payload];
    }
    if (Array.isArray(payload.nodes)) return flattenGraphNodes(payload.nodes, depth + 1);
    if (Array.isArray(payload.graph_data)) return flattenGraphNodes(payload.graph_data, depth + 1);
  }
  return [];
}

const INK = "#1e293b";
const INK_SOFT = "#374151";
const META = "#64748b";
const AMBER = "#b45309";
const FUCHSIA = "#a21caf";

function Byline({ speaker, ts, prefix }) {
  const date = fmtDate(ts);
  const parts = [prefix, speaker, date].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <div className="mt-1 text-xs" style={{ color: META }}>
      {parts.join(" · ")}
    </div>
  );
}

Byline.propTypes = {
  speaker: PropTypes.string,
  ts: PropTypes.number,
  prefix: PropTypes.string,
};

function clockLabel(ts) {
  if (!isWallClock(ts)) return null;
  try {
    return new Date(ts * 1000).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

/** Verbatim quote + copy affordance. The participation bridge: the copied
 * text pasted into WhatsApp search jumps straight to the message. */
function Receipt({ receipt, copyKey, copiedKey, onCopy }) {
  if (!receipt) return null;
  const copied = copiedKey === copyKey;
  const clock = clockLabel(receipt.ts);
  return (
    <div className="mt-3 border-t border-gray-100 pt-2.5">
      <blockquote className="text-[13px] leading-relaxed" style={{ color: INK_SOFT }}>
        “{receipt.text.length > 220 ? `${receipt.text.slice(0, 220).trimEnd()}…` : receipt.text}”
      </blockquote>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs" style={{ color: META }}>
          {[receipt.speaker, clock].filter(Boolean).join(" · ")}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCopy(copyKey, receipt.text);
          }}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors duration-150 hover:bg-gray-50"
          style={{ color: copied ? "#16a34a" : META }}
          title="Copy the message, then paste it in WhatsApp search to jump there and reply"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied · paste in WhatsApp search" : "Copy to reply"}
        </button>
      </div>
    </div>
  );
}

Receipt.propTypes = {
  receipt: receiptShape,
  copyKey: PropTypes.string.isRequired,
  copiedKey: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
};

function stateLine(clash) {
  if (!clash.answered) {
    const span = fmtSpan(clash.standingFor);
    return { text: span ? `standing unanswered · ${span}` : "standing unanswered", color: AMBER, weight: 500 };
  }
  const span = fmtSpan(clash.answeredIn);
  return { text: span ? `met with a counter in ${span}` : "met with a counter", color: META, weight: 400 };
}

function ThreadTag({ node, threadColors, threadTitles }) {
  const color = threadColors[node?.id];
  const title = threadTitles.get(node?.thread_id) || "";
  if (!title) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11px]" style={{ color: META }}>
      {color ? (
        <span
          className="h-2 w-2 shrink-0 rounded-full border border-black/10"
          style={{ background: color }}
        />
      ) : null}
      <span className="truncate">{title}</span>
    </span>
  );
}

ThreadTag.propTypes = {
  node: nodeShape,
  threadColors: PropTypes.object.isRequired,
  threadTitles: PropTypes.instanceOf(Map).isRequired,
};

function ClashCard({ clash, threadColors, threadTitles, copiedKey, onCopy }) {
  const [open, setOpen] = useState(false);
  const state = stateLine(clash);
  const key = `clash:${clash.target.id}:${clash.actor.id}`;
  return (
    <article className="rounded-xl border border-gray-200 bg-white px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <ThreadTag node={clash.target} threadColors={threadColors} threadTitles={threadTitles} />
        <span className="shrink-0 text-[11px]" style={{ color: state.color, fontWeight: state.weight }}>
          {state.text}
        </span>
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-2.5 block w-full text-left"
      >
        <h3
          className="text-[17px] font-semibold leading-snug"
          style={{ color: INK, textWrap: "balance" }}
        >
          {clash.target.node_name}
        </h3>
        <Byline speaker={clash.target.speaker_id} ts={clash.target.timestamp_start} />

        <div className="mt-3 flex items-center gap-2 text-[11px]" style={{ color: META }}>
          <span className="h-px flex-1 bg-gray-100" />
          countered by
          <span className="h-px flex-1 bg-gray-100" />
        </div>

        <p className="mt-2.5 text-[15px] font-medium leading-snug" style={{ color: INK_SOFT }}>
          {clash.actor.node_name}
        </p>
        <Byline speaker={clash.actor.speaker_id} ts={clash.actor.timestamp_start} />

        {open ? (
          <div className="mt-3 space-y-3 text-[13px] leading-relaxed" style={{ color: INK_SOFT }}>
            {clash.target.summary ? <p>{clash.target.summary}</p> : null}
            {clash.actor.summary ? <p>{clash.actor.summary}</p> : null}
          </div>
        ) : null}
        <div className="mt-2 text-[11px]" style={{ color: META }}>
          {open ? "Show less" : "Both positions in full"}
        </div>
      </button>

      <Receipt
        receipt={clash.actorReceipt || clash.targetReceipt}
        copyKey={key}
        copiedKey={copiedKey}
        onCopy={onCopy}
      />
    </article>
  );
}

ClashCard.propTypes = {
  clash: PropTypes.shape({
    target: nodeShape.isRequired,
    actor: nodeShape.isRequired,
    answered: PropTypes.bool,
    answeredIn: PropTypes.number,
    standingFor: PropTypes.number,
    targetReceipt: receiptShape,
    actorReceipt: receiptShape,
  }).isRequired,
  threadColors: PropTypes.object.isRequired,
  threadTitles: PropTypes.instanceOf(Map).isRequired,
  copiedKey: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
};

function UpsetCard({ upset, copiedKey, onCopy }) {
  const key = `upset:${upset.later.id}`;
  const earlierDate = fmtDate(upset.earlier.timestamp_start);
  const laterDate = fmtDate(upset.later.timestamp_start);
  return (
    <article className="rounded-xl border border-gray-200 bg-white px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium" style={{ color: FUCHSIA }}>
          Self-contradiction
        </span>
        <span className="shrink-0 text-[11px]" style={{ color: META }}>
          {upset.speaker}
        </span>
      </div>
      <div className="mt-2.5 space-y-2">
        <p className="text-[15px] font-semibold leading-snug" style={{ color: INK, textWrap: "balance" }}>
          {upset.earlier.node_name}
          {earlierDate ? (
            <span className="ml-1.5 text-xs font-normal" style={{ color: META }}>
              {earlierDate}
            </span>
          ) : null}
        </p>
        <p className="text-[15px] font-semibold leading-snug" style={{ color: INK, textWrap: "balance" }}>
          {upset.later.node_name}
          {laterDate ? (
            <span className="ml-1.5 text-xs font-normal" style={{ color: META }}>
              {laterDate}
            </span>
          ) : null}
        </p>
      </div>
      {upset.text ? (
        <p className="mt-3 text-[13px] leading-relaxed" style={{ color: INK_SOFT }}>
          {upset.text}
        </p>
      ) : null}
      <Receipt receipt={upset.receipt} copyKey={key} copiedKey={copiedKey} onCopy={onCopy} />
    </article>
  );
}

UpsetCard.propTypes = {
  upset: PropTypes.shape({
    earlier: nodeShape.isRequired,
    later: nodeShape.isRequired,
    speaker: PropTypes.string,
    text: PropTypes.string,
    receipt: receiptShape,
  }).isRequired,
  copiedKey: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
};

function ChallengeCard({ challenge, copiedKey, onCopy }) {
  const key = `challenge:${challenge.node.id}`;
  const standing = fmtSpan(challenge.standingFor);
  return (
    <article className="rounded-xl border border-gray-200 bg-white px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium" style={{ color: AMBER }}>
          Open question
        </span>
        <span className="shrink-0 text-[11px]" style={{ color: challenge.replies === 0 ? AMBER : META }}>
          {challenge.replies === 0
            ? standing
              ? `no answer · stood ${standing}`
              : "no answer recorded"
            : `${challenge.replies} repl${challenge.replies === 1 ? "y" : "ies"}`}
        </span>
      </div>
      <h3 className="mt-2 text-[16px] font-semibold leading-snug" style={{ color: INK, textWrap: "balance" }}>
        {challenge.node.node_name}
      </h3>
      <Byline speaker={challenge.node.speaker_id} ts={challenge.node.timestamp_start} prefix="asked by" />
      {challenge.node.summary ? (
        <p className="mt-2 text-[13px] leading-relaxed" style={{ color: INK_SOFT }}>
          {challenge.node.summary}
        </p>
      ) : null}
      <Receipt receipt={challenge.receipt} copyKey={key} copiedKey={copiedKey} onCopy={onCopy} />
    </article>
  );
}

ChallengeCard.propTypes = {
  challenge: PropTypes.shape({
    node: nodeShape.isRequired,
    replies: PropTypes.number,
    standingFor: PropTypes.number,
    receipt: receiptShape,
  }).isRequired,
  copiedKey: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
};

function FrontLines({ fronts, threadColorsByThread }) {
  const stateColor = { active: AMBER, contested: INK_SOFT, quiet: META };
  const stateText = { active: "active fire", contested: "contested", quiet: "gone quiet" };
  return (
    <section className="rounded-xl border border-gray-200 bg-white px-4 py-4">
      <h2 className="text-base font-semibold" style={{ color: INK }}>
        Front lines
      </h2>
      <ul className="mt-3 space-y-2.5">
        {fronts.map((f) => (
          <li key={f.threadId}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2 text-sm font-medium" style={{ color: INK_SOFT }}>
                <span
                  className="h-2 w-2 shrink-0 rounded-full border border-black/10"
                  style={{ background: threadColorsByThread.get(f.threadId) || "#e5e7eb" }}
                />
                <span className="truncate">{f.title}</span>
              </span>
              <span className="shrink-0 text-[11px]" style={{ color: stateColor[f.state] }}>
                {stateText[f.state]}
                {f.last && fmtDate(f.last) ? ` · ${fmtDate(f.last)}` : ""}
              </span>
            </div>
            {f.state === "active" && f.openMove ? (
              <div className="mt-0.5 truncate pl-4 text-xs" style={{ color: META }}>
                open: {f.openMove.name}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

FrontLines.propTypes = {
  fronts: PropTypes.arrayOf(
    PropTypes.shape({
      threadId: PropTypes.string,
      title: PropTypes.string,
      state: PropTypes.string,
      last: PropTypes.number,
      openMove: PropTypes.shape({ name: PropTypes.string, date: PropTypes.number }),
    })
  ).isRequired,
  threadColorsByThread: PropTypes.instanceOf(Map).isRequired,
};

function UndefendedCard({ items, total, onOpenMap }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white px-4 py-4">
      <h2 className="text-base font-semibold" style={{ color: INK }}>
        Undefended ground
      </h2>
      <p className="mt-1 text-[13px] leading-relaxed" style={{ color: META }}>
        {total} claims entered the field with no evidence offered. The most exposed:
      </p>
      <ol className="mt-3 space-y-2.5">
        {items.map((u, i) => (
          <li key={u.node.id} className="flex gap-2.5">
            <span className="w-4 shrink-0 text-right text-xs tabular-nums" style={{ color: META }}>
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium leading-snug" style={{ color: INK_SOFT }}>
                {u.node.node_name}
              </div>
              <div className="mt-0.5 text-xs" style={{ color: META }}>
                {[u.node.speaker_id, u.attacked > 0 ? `attacked ×${u.attacked}, never defended` : "unchallenged, unevidenced"]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={onOpenMap}
        className="mt-3 text-xs underline decoration-gray-300 underline-offset-2 transition-colors duration-150 hover:decoration-gray-500"
        style={{ color: META }}
      >
        See all {total} on the map
      </button>
    </section>
  );
}

UndefendedCard.propTypes = {
  items: PropTypes.arrayOf(
    PropTypes.shape({ node: nodeShape.isRequired, attacked: PropTypes.number })
  ).isRequired,
  total: PropTypes.number.isRequired,
  onOpenMap: PropTypes.func.isRequired,
};

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-4">
      <div className="h-2.5 w-24 animate-pulse rounded bg-gray-100 motion-reduce:animate-none" />
      <div className="mt-3 h-4 w-4/5 animate-pulse rounded bg-gray-100 motion-reduce:animate-none" />
      <div className="mt-2 h-4 w-3/5 animate-pulse rounded bg-gray-100 motion-reduce:animate-none" />
      <div className="mt-4 h-3 w-2/3 animate-pulse rounded bg-gray-100 motion-reduce:animate-none" />
    </div>
  );
}

export default function WarReport() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const [nodes, setNodes] = useState(null);
  const [utterances, setUtterances] = useState([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [copiedKey, setCopiedKey] = useState(null);

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
          // receipts degrade gracefully without utterances
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

  const report = useMemo(
    () => (nodes ? buildWarReport(nodes, utterances) : null),
    [nodes, utterances]
  );

  const threadColors = useMemo(() => buildThreadColorMapForNodes(nodes || []), [nodes]);
  const threadColorsByThread = useMemo(() => {
    const m = new Map();
    (nodes || []).forEach((n) => {
      if (n.thread_id && !m.has(n.thread_id) && threadColors[n.id]) m.set(n.thread_id, threadColors[n.id]);
    });
    return m;
  }, [nodes, threadColors]);
  const threadTitles = useMemo(() => {
    const m = new Map();
    (report?.fronts || []).forEach((f) => m.set(f.threadId, f.title));
    return m;
  }, [report]);

  const onCopy = (key, text) => {
    try {
      navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2200);
    } catch {
      // clipboard unavailable: the quote is selectable text
    }
  };

  const openMap = () => navigate(`/conversation/${conversationId}`);

  const dekParts = report && !report.empty
    ? [
        report.stats.speakers ? `${report.stats.speakers} voices` : null,
        `${report.stats.claims} claims`,
        `${report.stats.attacks} clashes`,
        report.stats.upsets ? `${report.stats.upsets} self-contradictions` : null,
        report.stats.openQuestions ? `${report.stats.openQuestions} open questions` : null,
        report.span.start && report.span.end && fmtDate(report.span.start)
          ? `${fmtDate(report.span.start)} – ${fmtDate(report.span.end)}`
          : null,
      ].filter(Boolean)
    : [];

  return (
    <div className="min-h-screen" style={{ background: "#fdfdfb" }}>
      <header className="sticky top-0 z-20 border-b border-gray-100" style={{ background: "rgba(253,253,251,0.92)", backdropFilter: "blur(6px)" }}>
        <div className="mx-auto flex h-12 max-w-[560px] items-center justify-between px-4">
          <button
            type="button"
            onClick={openMap}
            className="flex items-center gap-1.5 rounded px-1.5 py-1 text-sm transition-colors duration-150 hover:bg-gray-100"
            style={{ color: INK_SOFT }}
          >
            <ArrowLeft size={15} /> Map
          </button>
          <span className="text-[11px]" style={{ color: META }}>
            {report && !report.empty ? `${report.cards.length + 2} dispatches` : ""}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-[560px] px-4 pb-16 pt-6">
        {loading ? (
          <div className="space-y-4">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
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
        ) : report?.empty ? (
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-6">
            <h2 className="text-base font-semibold" style={{ color: INK }}>
              No argument map yet
            </h2>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: INK_SOFT }}>
              This report reads the claim / evidence / question structure of a conversation, and this
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
        ) : report ? (
          <>
            <div className="mb-6">
              <div className="text-[10px] font-medium uppercase" style={{ color: AMBER, letterSpacing: "0.42em" }}>
                War report
              </div>
              <h1
                className="mt-1.5 text-2xl font-semibold leading-tight"
                style={{ color: INK, letterSpacing: "-0.02em", textWrap: "balance" }}
              >
                {title || "The debate"}
              </h1>
              {dekParts.length > 0 ? (
                <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: META }}>
                  {dekParts.map((part, i) => (
                    <span key={part} className="whitespace-nowrap">
                      {part}
                      {i < dekParts.length - 1 ? <span aria-hidden="true"> · </span> : null}
                    </span>
                  ))}
                </p>
              ) : null}
            </div>

            <div className="space-y-4">
              <FrontLines fronts={report.fronts} threadColorsByThread={threadColorsByThread} />

              {report.cards.map((card) => {
                if (card.kind === "clash") {
                  return (
                    <ClashCard
                      key={`clash:${card.target.id}:${card.actor.id}`}
                      clash={card}
                      threadColors={threadColors}
                      threadTitles={threadTitles}
                      copiedKey={copiedKey}
                      onCopy={onCopy}
                    />
                  );
                }
                if (card.kind === "upset") {
                  return (
                    <UpsetCard key={`upset:${card.later.id}:${card.earlier.id}`} upset={card} copiedKey={copiedKey} onCopy={onCopy} />
                  );
                }
                if (card.kind === "challenge") {
                  return (
                    <ChallengeCard key={`challenge:${card.node.id}`} challenge={card} copiedKey={copiedKey} onCopy={onCopy} />
                  );
                }
                return null;
              })}

              <UndefendedCard items={report.undefended} total={report.undefendedTotal} onOpenMap={openMap} />

              <section className="rounded-xl border border-gray-200 bg-white px-4 py-5 text-center">
                <p className="text-sm leading-relaxed" style={{ color: INK_SOFT }}>
                  This feed is the surface. The map underneath holds every claim, every edge, every
                  receipt.
                </p>
                <button
                  type="button"
                  onClick={openMap}
                  className="mt-3 inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90"
                  style={{ background: INK }}
                >
                  <MapIcon size={15} /> Open the full map
                </button>
                <p className="mt-3 text-xs leading-relaxed" style={{ color: META }}>
                  To join in: copy any quote, paste it in WhatsApp search, reply there.
                </p>
              </section>
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}
