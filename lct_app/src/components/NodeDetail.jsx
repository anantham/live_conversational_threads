import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import PropTypes from "prop-types";
import { rerouteConversationArtifacts } from "../services/artifactSettingsApi";
import {
  fetchConversationUtterances,
  applySpeakerCorrection,
} from "../services/speakerNamingApi";
import { apiFetch } from "../services/apiClient";

// ADR-032 Part H — windowed speaker correction. The scope selector lives
// inline in the rename editor; the last-used choice is sticky per browser.
const SPEAKER_WINDOW_OPTIONS = [
  { label: "±1 min", value: 60 },
  { label: "±5 min", value: 300 },
  { label: "±15 min", value: 900 },
  { label: "whole conversation", value: 0 },
];
const SPEAKER_WINDOW_STORAGE_KEY = "lct.speakerCorrectionWindowSeconds";

function readStoredSpeakerWindow() {
  try {
    const raw = window.localStorage.getItem(SPEAKER_WINDOW_STORAGE_KEY);
    if (raw == null) return 300;
    const parsed = Number.parseInt(raw, 10);
    return SPEAKER_WINDOW_OPTIONS.some((opt) => opt.value === parsed) ? parsed : 300;
  } catch {
    return 300;
  }
}

function normalizeContextualRelations(contextualRelation) {
  if (!contextualRelation || typeof contextualRelation !== "object" || Array.isArray(contextualRelation)) {
    return [];
  }

  const relatedNode =
    contextualRelation.related_node_name ||
    contextualRelation.related_node ||
    contextualRelation.relatedNode ||
    contextualRelation.source ||
    contextualRelation.from ||
    contextualRelation.node;
  const relationText =
    contextualRelation.relation_text ||
    contextualRelation.relationText ||
    contextualRelation.description ||
    contextualRelation.explanation;
  const singleRelationKeys = new Set([
    "related_node_name",
    "related_node",
    "relatedNode",
    "source",
    "from",
    "node",
    "relation_text",
    "relationText",
    "description",
    "explanation",
    "relation_type",
    "type",
  ]);
  const keys = Object.keys(contextualRelation);
  const looksLikeSingleRelation =
    Boolean(relatedNode && relationText) && keys.every((key) => singleRelationKeys.has(key));

  if (looksLikeSingleRelation) {
    return [[String(relatedNode), String(relationText)]];
  }

  return Object.entries(contextualRelation)
    .filter(([name, text]) => Boolean(String(name).trim()) && Boolean(String(text).trim()))
    .map(([name, text]) => [String(name), String(text)]);
}

export default function NodeDetail({
  node,
  chunkDict,
  conversationId,
  audioUrl,
  onClose,
  onSpeakerRenamed,
  onTraceAncestors,
  participantNames = [],
  contextNodes = null,
  onSelectNode = null,
}) {
  const safeNode = node ?? null;

  // ADR-032 Part H — structured utterances + windowed inline correction.
  const [utterances, setUtterances] = useState(null);
  const [editingUtteranceId, setEditingUtteranceId] = useState(null);
  const [correctionDraft, setCorrectionDraft] = useState("");
  const [correctionWindow, setCorrectionWindow] = useState(readStoredSpeakerWindow);
  const [correctionSaving, setCorrectionSaving] = useState(false);
  const [correctionError, setCorrectionError] = useState("");
  const [correctionFeedback, setCorrectionFeedback] = useState("");

  const [factCheckData, setFactCheckData] = useState(null);
  const [factCheckLoading, setFactCheckLoading] = useState(false);

  const audioRef = useRef(null);
  // The DESIRED seek time, kept until it actually sticks. Mobile browsers ignore
  // preload="metadata" and may not be "seekable" until the user taps play, so a
  // one-shot currentTime assignment gets dropped -> playback from 0. We re-apply
  // on every media-ready event + on play, clearing only once it lands on target.
  const targetSeekRef = useRef(null);
  const [audioState, setAudioState] = useState("idle");

  // Backend timestamps are seconds (Float on DBUtterance.timestamp_start,
  // derived from utterance.start_time which is seconds throughout the
  // pipeline). Don't try to auto-detect ms — the old heuristic
  // `ts > 10000 ? ts/1000 : ts` silently mis-seeked anything past ~2.8h.
  const applyPendingSeek = useCallback((autoplay) => {
    const audio = audioRef.current;
    const t = targetSeekRef.current;
    if (!audio || t == null || audio.readyState < 1) return;
    try {
      audio.currentTime = t;
    } catch {
      return;  // not seekable yet (mobile) — a later event will retry
    }
    if (Math.abs((audio.currentTime || 0) - t) < 1.0) {
      targetSeekRef.current = null;  // landed — stop retrying
      if (autoplay) audio.play().catch((e) => console.warn("Auto-play prevented:", e));
    }
  }, []);

  const seekTo = useCallback((timeInSeconds) => {
    targetSeekRef.current = timeInSeconds;
    applyPendingSeek(true);  // desktop: sticks now; mobile: re-applied on ready/play
  }, [applyPendingSeek]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;

    // Re-apply the pending seek whenever the media becomes more ready (mobile
    // loads lazily, so the first attempt in seekTo is usually too early).
    const onLoadedMetadata = () => { setAudioState((s) => (s === "playing" ? s : "ready")); applyPendingSeek(true); };
    const onLoadedData = () => applyPendingSeek(true);
    const onCanPlay = () => { setAudioState((s) => (s === "playing" ? s : "ready")); applyPendingSeek(true); };
    // User tapped the native play control: jump to the target first, keep playing.
    const onPlay = () => applyPendingSeek(false);
    const onWaiting = () => setAudioState("loading");
    const onSeeking = () => setAudioState("seeking");
    const onPlaying = () => setAudioState("playing");
    const onPause = () => setAudioState("paused");
    const onError = () => setAudioState("error");
    const onStalled = () => setAudioState("loading");

    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("loadeddata", onLoadedData);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("seeking", onSeeking);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("error", onError);
    audio.addEventListener("stalled", onStalled);
    return () => {
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("loadeddata", onLoadedData);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("seeking", onSeeking);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("error", onError);
      audio.removeEventListener("stalled", onStalled);
    };
  }, [audioUrl, applyPendingSeek]);

  useEffect(() => {
    if (!audioRef.current || !safeNode) return;
    // Match TimelineRibbon's field coverage — a node's start time may live under
    // any of these (top-level or in metadata); reading only timestamp_start meant
    // the seek silently never fired for some nodes (-> playback from 0).
    const meta = safeNode.metadata && typeof safeNode.metadata === "object" ? safeNode.metadata : null;
    const ts = safeNode.timestamp_start ?? safeNode.start_time ?? safeNode.timestamp
      ?? safeNode.time ?? safeNode.start
      ?? meta?.timestamp_start ?? meta?.start_time ?? meta?.timestamp;
    const n = Number(ts);
    if (!Number.isFinite(n) || n < 0) return;
    seekTo(n);
  }, [safeNode, seekTo]);

  const relations = Array.isArray(safeNode?.edge_relations) ? safeNode.edge_relations : [];
  const contextualRelations = normalizeContextualRelations(safeNode?.contextual_relation);

  // "In context" — for a chunk-level moment, reconstruct a mini-transcript from
  // the neighboring chunks (who said what just before/after). Used in the static
  // .threads viewer, where there's no backend/utterance feed but every chunk
  // (with speaker + source_excerpt) is present in the graph. ±4 in graph order.
  const CONTEXT_WINDOW = 4;
  const contextWindow = useMemo(() => {
    if (!Array.isArray(contextNodes) || contextNodes.length === 0 || !safeNode) return null;
    const lvl = Number(safeNode.semantic_level || safeNode.level || 0);
    if (lvl !== 1) return null; // moments only
    const chunks = contextNodes.filter(
      (n) => Number(n.semantic_level || n.level || 0) === 1
    );
    const idx = chunks.findIndex((n) => String(n.id) === String(safeNode.id));
    if (idx === -1) return null;
    const from = Math.max(0, idx - CONTEXT_WINDOW);
    const to = Math.min(chunks.length, idx + CONTEXT_WINDOW + 1);
    return {
      rows: chunks.slice(from, to),
      currentId: String(safeNode.id),
      truncated: from > 0 || to < chunks.length,
    };
  }, [contextNodes, safeNode]);

  // Raw transcript for this node's chunk. NOTE: for live-recorded
  // conversations the backend (conversation_reader.build_chunk_dict...)
  // stores the WHOLE transcript under every chunk_id because
  // utterance.chunk_id wasn't linked to node.chunk_ids by the live-STT
  // writer. So `rawTranscript` is often the entire conversation, not
  // just this node's slice — hence the windowing below.
  const rawTranscript = safeNode?.chunk_id ? chunkDict?.[safeNode.chunk_id] || null : null;
  const [showFullTranscript, setShowFullTranscript] = useState(false);
  const TRANSCRIPT_CONTEXT_LINES = 4;

  // Split raw transcript into lines and find the node's text within it
  const highlightedTranscript = useMemo(() => {
    if (!rawTranscript || !safeNode?.full_text) return null;
    const lines = rawTranscript.split("\n");
    const needle = safeNode.full_text.trim().substring(0, 40);
    if (!needle) return null;
    const startIdx = lines.findIndex((l) => l.includes(needle));
    const nodeLineCount = safeNode.full_text.split("\n").length;
    return { lines, startIdx, nodeLineCount };
  }, [rawTranscript, safeNode?.full_text]);

  // Render a window around the highlighted lines (or full transcript if
  // toggled, or if we couldn't locate the node's text).
  const visibleTranscript = useMemo(() => {
    if (!highlightedTranscript) return null;
    const { lines, startIdx, nodeLineCount } = highlightedTranscript;
    if (showFullTranscript || startIdx === -1) {
      return { lines, startIdx, nodeLineCount, sliceOffset: 0, truncated: false };
    }
    const from = Math.max(0, startIdx - TRANSCRIPT_CONTEXT_LINES);
    const to = Math.min(lines.length, startIdx + nodeLineCount + TRANSCRIPT_CONTEXT_LINES);
    return {
      lines: lines.slice(from, to),
      startIdx: startIdx - from,
      nodeLineCount,
      sliceOffset: from,
      truncated: from > 0 || to < lines.length,
    };
  }, [highlightedTranscript, showFullTranscript]);

  // ADR-032 Part H: window the structured utterance list around this node's
  // own utterances (node.utterance_ids), mirroring the plain-text windowing
  // above. Falls back to the full list when the node has no utterance
  // linkage (live-STT conversations) or when expanded.
  const UTTERANCE_CONTEXT_ROWS = 4;
  const nodeUtteranceIds = useMemo(
    () => new Set((safeNode?.utterance_ids || []).map(String)),
    [safeNode?.utterance_ids]
  );
  const visibleUtterances = useMemo(() => {
    if (!Array.isArray(utterances) || utterances.length === 0) return null;
    const rows = utterances.map((u) => ({ ...u, _hl: nodeUtteranceIds.has(String(u.id)) }));
    const firstHL = rows.findIndex((r) => r._hl);
    const firstHlId = firstHL === -1 ? null : rows[firstHL].id;
    if (showFullTranscript || firstHL === -1) {
      return { rows, truncated: false, firstHlId };
    }
    let lastHL = firstHL;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i]._hl) {
        lastHL = i;
        break;
      }
    }
    const from = Math.max(0, firstHL - UTTERANCE_CONTEXT_ROWS);
    const to = Math.min(rows.length, lastHL + 1 + UTTERANCE_CONTEXT_ROWS);
    return { rows: rows.slice(from, to), truncated: from > 0 || to < rows.length, firstHlId };
  }, [utterances, nodeUtteranceIds, showFullTranscript]);

  // Reset full-transcript toggle when switching nodes.
  useEffect(() => {
    setShowFullTranscript(false);
  }, [safeNode?.id]);

  // Scroll the highlighted block into view *within the transcript box*
  // (not the whole page). scrollIntoView would walk up scrollable
  // ancestors and could jump the panel itself; scrollTop is local.
  const highlightedLineRef = useRef(null);
  const transcriptScrollRef = useRef(null);
  useEffect(() => {
    const line = highlightedLineRef.current;
    const box = transcriptScrollRef.current;
    if (!line || !box) return;
    const target = line.offsetTop - box.clientHeight / 2 + line.clientHeight / 2;
    box.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [visibleTranscript, visibleUtterances]);

  useEffect(() => {
    if (!safeNode) return undefined;
    const handleKeydown = (event) => {
      if (event.key === "Escape") {
        // Escape cancels an open rename editor first, then closes the panel.
        if (editingUtteranceId) {
          setEditingUtteranceId(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [safeNode, onClose, editingUtteranceId]);

  useEffect(() => {
    if (!conversationId) {
      setFactCheckData(null);
      return;
    }

    let cancelled = false;

    async function loadFactCheck() {
      setFactCheckLoading(true);
      try {
        const response = await apiFetch(
          `/api/conversations/${conversationId}/fact_check?turns=10`
        );
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        if (cancelled) return;
        setFactCheckData(data);
      } catch (error) {
        console.warn("[NodeDetail] Fact check failed:", error);
      } finally {
        if (!cancelled) {
          setFactCheckLoading(false);
        }
      }
    }

    void loadFactCheck();

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Load structured utterances for the inline-rename transcript (Part H).
  // On failure or empty result, fall back to the plain-text chunk render.
  useEffect(() => {
    if (!conversationId) {
      setUtterances(null);
      return undefined;
    }
    let cancelled = false;
    async function loadUtterances() {
      try {
        const payload = await fetchConversationUtterances(conversationId);
        if (cancelled) return;
        setUtterances(Array.isArray(payload?.utterances) ? payload.utterances : []);
      } catch (error) {
        if (cancelled) return;
        console.warn("[NodeDetail] utterance load failed:", error);
        setUtterances([]);
      }
    }
    void loadUtterances();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const refetchUtterances = useCallback(async () => {
    if (!conversationId) return;
    try {
      const payload = await fetchConversationUtterances(conversationId);
      setUtterances(Array.isArray(payload?.utterances) ? payload.utterances : []);
    } catch (error) {
      console.warn("[NodeDetail] utterance refetch failed:", error);
    }
  }, [conversationId]);

  const startEditUtterance = useCallback((utt) => {
    setEditingUtteranceId(utt.id);
    setCorrectionDraft(utt.speaker_name || "");
    setCorrectionError("");
    setCorrectionFeedback("");
  }, []);

  const cancelEditUtterance = useCallback(() => {
    setEditingUtteranceId(null);
    setCorrectionDraft("");
    setCorrectionError("");
  }, []);

  const handleWindowChange = useCallback((seconds) => {
    setCorrectionWindow(seconds);
    try {
      window.localStorage.setItem(SPEAKER_WINDOW_STORAGE_KEY, String(seconds));
    } catch {
      /* localStorage unavailable — keep the in-memory value */
    }
  }, []);

  const handleSaveCorrection = useCallback(
    async (utt) => {
      const newSpeaker = correctionDraft.trim();
      if (!newSpeaker || correctionSaving) return;
      setCorrectionSaving(true);
      setCorrectionError("");
      setCorrectionFeedback("");
      try {
        const result = await applySpeakerCorrection(conversationId, {
          utteranceId: utt.id,
          newSpeaker,
          timeWindowSeconds: correctionWindow,
          source: "node_detail_panel",
        });
        const baseFeedback = `Relabeled ${
          result?.relabeled_count ?? 0
        } utterance(s) (${result?.scope || "?"}).`;
        setCorrectionFeedback(baseFeedback);
        setEditingUtteranceId(null);
        setCorrectionDraft("");
        await refetchUtterances();
        onSpeakerRenamed?.(utt.speaker_id, newSpeaker);
        // Carried over from the retired global Speaker section: a rename can
        // change the participant folder, so re-route the exported artifacts.
        try {
          const reroute = await rerouteConversationArtifacts(conversationId);
          if (reroute?.rerouted) {
            const target =
              reroute?.resolved_root_path || reroute?.root_path || "configured folder";
            setCorrectionFeedback(`${baseFeedback} Artifacts updated in ${target}.`);
          }
        } catch (rerouteError) {
          console.error("Artifact reroute after speaker correction failed:", rerouteError);
        }
      } catch (error) {
        console.error("Speaker correction failed:", error);
        setCorrectionError(error?.message || "Unable to apply speaker correction.");
      } finally {
        setCorrectionSaving(false);
      }
    },
    [conversationId, correctionDraft, correctionWindow, correctionSaving, onSpeakerRenamed, refetchUtterances]
  );

  if (!safeNode) return null;

  return (
    <div className="fixed left-0 right-0 bottom-0 max-h-[75vh] rounded-t-2xl border-t border-gray-200 bg-white shadow-lg z-40 flex flex-col lct-detail-enter sm:left-auto sm:top-0 sm:h-full sm:max-h-none sm:w-80 sm:max-w-[85vw] sm:rounded-t-none sm:border-t-0 sm:border-l">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <h2
          className="text-sm font-semibold text-gray-800 pr-2 break-words leading-snug"
          title={safeNode.node_name}
        >
          {safeNode.node_name}
        </h2>
        <button
          onClick={onClose}
          className="p-3 text-gray-400 hover:text-gray-600 transition shrink-0"
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-sm">
        {/* Audio Player */}
        {audioUrl && (
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                Audio playback
              </span>
              {(audioState === "loading" || audioState === "seeking") && (
                <span className="flex items-center gap-1 text-[10px] text-gray-500">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-gray-300 border-t-gray-600"
                  />
                  {audioState === "seeking" ? "Seeking…" : "Buffering…"}
                </span>
              )}
              {audioState === "error" && (
                <span className="text-[10px] text-red-600">Audio error</span>
              )}
            </div>
            <audio
              ref={audioRef}
              src={audioUrl}
              controls
              className="w-full h-8"
              preload="metadata"
            />
          </div>
        )}

        {/* Summary */}
        {safeNode.summary && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Summary</span>
            <p className="text-gray-700 mt-0.5 leading-relaxed">{safeNode.summary}</p>
          </div>
        )}

        {/* Provenance (P0) — the auditable link from this node back to the exact
            raw turns it covers. source_ref ({utterance_ids, source_identifiers,
            start_seq, end_seq}) is the mechanism; the Source/Transcript evidence
            below is what those turns actually said. A null source_ref renders an
            honest "not traceable" notice — never a faked turn range. */}
        {(() => {
          const sr = safeNode.source_ref;
          const uids = Array.isArray(sr?.utterance_ids) ? sr.utterance_ids : [];
          const auditable = Boolean(sr) && uids.length > 0;
          const startSeq = sr?.start_seq;
          const endSeq = sr?.end_seq;
          // Number(null) === 0 and Number.isFinite(0) === true, so guard the
          // null case explicitly — a node with utterance_ids but a null span is
          // still auditable, it just has no turn number to point at (renders
          // "Linked to source" with no range, never a phantom "turns 0–0").
          const hasSpan =
            startSeq != null &&
            endSeq != null &&
            Number.isFinite(Number(startSeq)) &&
            Number.isFinite(Number(endSeq));
          const turnLabel = hasSpan
            ? Number(startSeq) === Number(endSeq)
              ? `turn ${startSeq}`
              : `turns ${startSeq}–${endSeq}`
            : null;
          const sources = Array.from(
            new Set((sr?.source_identifiers || []).filter((s) => s && String(s).trim()))
          );
          return (
            <div>
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                Provenance
              </span>
              {auditable ? (
                <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                    <span aria-hidden="true">✓</span>
                    {turnLabel ? `Covers ${turnLabel}` : "Linked to source"}
                  </span>
                  <span className="text-gray-500">
                    {uids.length} raw turn{uids.length === 1 ? "" : "s"}
                  </span>
                  {sources.length > 0 && (
                    <span className="text-gray-400" title={sources.join("\n")}>
                      · from {sources.length === 1 ? sources[0] : `${sources.length} sources`}
                    </span>
                  )}
                </div>
              ) : (
                <p className="mt-1 text-xs leading-relaxed text-gray-400">
                  No source link — this node is not traceable to specific raw
                  turns (legacy or live capture). Any summary or excerpt shown
                  here is unverified reference, not audited against the
                  transcript.
                </p>
              )}
            </div>
          );
        })()}

        {/* Full text / transcript excerpt */}
        {safeNode.full_text && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Transcript</span>
            <p className="text-gray-600 mt-0.5 leading-relaxed text-xs bg-gray-50 rounded p-2">
              {safeNode.full_text}
            </p>
          </div>
        )}

        {/* Source excerpt */}
        {safeNode.source_excerpt && !safeNode.full_text && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Source</span>
            <p className="text-gray-600 mt-0.5 leading-relaxed text-xs bg-gray-50 rounded p-2">
              {safeNode.source_excerpt}
            </p>
          </div>
        )}

        {/* In context — neighboring moments with speakers, so an isolated chunk
            reads as part of an exchange. Static-viewer path (no utterance feed). */}
        {contextWindow && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
              In context · who said what around this
            </span>
            <div className="mt-1 max-h-60 overflow-y-auto rounded bg-gray-50 border border-gray-100 px-2 py-1.5 text-xs leading-relaxed">
              {contextWindow.rows.map((n) => {
                const speaker = n.speaker_display || n.speaker_id || "?";
                const text = n.source_excerpt || n.summary || n.node_name || "";
                const isCur = String(n.id) === contextWindow.currentId;
                const clickable = !isCur && typeof onSelectNode === "function";
                return (
                  <div
                    key={n.id}
                    onClick={clickable ? () => onSelectNode(n.id) : undefined}
                    className={`py-0.5 ${isCur ? "bg-amber-100 rounded px-0.5" : ""} ${
                      clickable ? "cursor-pointer hover:bg-gray-100 rounded px-0.5" : ""
                    }`}
                  >
                    <span className="font-medium text-gray-500">{speaker}</span>
                    <span className="text-gray-300">: </span>
                    <span className={isCur ? "text-gray-800" : "text-gray-600"}>{text}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Raw transcript. ADR-032 Part H: when structured utterances are
            available, render them as rows with a clickable speaker label
            for windowed inline rename; otherwise fall back to the plain-text
            chunk (legacy / live-STT conversations with no utterance rows).
            The node's own utterances stay highlighted + windowed either way. */}
        {(visibleUtterances || rawTranscript) && (
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                Raw Transcript
              </span>
              {!showFullTranscript &&
                (visibleUtterances?.truncated || visibleTranscript?.truncated) && (
                  <button
                    type="button"
                    onClick={() => setShowFullTranscript(true)}
                    className="text-[10px] text-gray-500 underline-offset-2 hover:text-gray-700 hover:underline"
                  >
                    Show full
                  </button>
                )}
              {showFullTranscript && (
                <button
                  type="button"
                  onClick={() => setShowFullTranscript(false)}
                  className="text-[10px] text-gray-500 underline-offset-2 hover:text-gray-700 hover:underline"
                >
                  Collapse
                </button>
              )}
            </div>

            {visibleUtterances ? (
              <div
                ref={transcriptScrollRef}
                className="mt-1 max-h-56 overflow-y-auto rounded bg-gray-50 border border-gray-100 px-2 py-1.5 text-xs text-gray-600 leading-relaxed"
              >
                {visibleUtterances.rows.map((u) => {
                  const label = u.speaker_name || u.speaker_id || "?";
                  const isEditing = editingUtteranceId === u.id;
                  return (
                    <div
                      key={u.id}
                      ref={
                        u.id === visibleUtterances.firstHlId && !editingUtteranceId
                          ? highlightedLineRef
                          : undefined
                      }
                      className={`py-0.5 ${u._hl ? "bg-amber-100 rounded px-0.5" : ""}`}
                    >
                      {isEditing ? (
                        <span className="font-medium text-gray-400">{label}</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEditUtterance(u)}
                          title="Rename this speaker (windowed correction)"
                          className="font-medium text-gray-500 hover:text-amber-700 hover:underline underline-offset-2"
                        >
                          {label}
                        </button>
                      )}
                      <span className="text-gray-300">: </span>
                      <span>{u.text}</span>

                      {isEditing && (
                        <div className="my-1 rounded border border-gray-300 bg-white p-2 space-y-1.5">
                          {/* Scoped quick-picks: the conversation's picker
                              participants. Tapping one fills the draft so a
                              multi-speaker rename is a tap, not typing. */}
                          {participantNames.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1">
                              {participantNames.map((name) => (
                                <button
                                  key={name}
                                  type="button"
                                  onClick={() => setCorrectionDraft(name)}
                                  className={`rounded-full border px-2 py-0.5 text-[11px] ${
                                    correctionDraft.trim() === name
                                      ? "border-amber-400 bg-amber-100 text-amber-800"
                                      : "border-gray-200 text-gray-600 hover:bg-gray-50"
                                  }`}
                                >
                                  {name}
                                </button>
                              ))}
                            </div>
                          )}
                          <input
                            type="text"
                            autoFocus
                            value={correctionDraft}
                            onChange={(event) => setCorrectionDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void handleSaveCorrection(u);
                            }}
                            placeholder={u.speaker_id || "Speaker name"}
                            className="w-full rounded border border-gray-300 px-2 py-1 text-xs text-gray-700"
                          />
                          <div className="flex flex-wrap items-center gap-1">
                            {SPEAKER_WINDOW_OPTIONS.map((opt) => (
                              <button
                                key={opt.value}
                                type="button"
                                onClick={() => handleWindowChange(opt.value)}
                                className={`rounded border px-1.5 py-0.5 text-[10px] ${
                                  correctionWindow === opt.value
                                    ? "border-amber-400 bg-amber-100 text-amber-800"
                                    : "border-gray-200 text-gray-500 hover:bg-gray-50"
                                }`}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => void handleSaveCorrection(u)}
                              disabled={correctionSaving || !correctionDraft.trim()}
                              className="rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                            >
                              {correctionSaving ? "Saving..." : "Save"}
                            </button>
                            <button
                              type="button"
                              onClick={cancelEditUtterance}
                              className="rounded px-2 py-0.5 text-[11px] text-gray-500 hover:text-gray-700"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div
                ref={transcriptScrollRef}
                className="mt-1 max-h-48 overflow-y-auto rounded bg-gray-50 border border-gray-100 px-2 py-1.5 text-xs text-gray-600 leading-relaxed whitespace-pre-wrap"
              >
                {visibleTranscript
                  ? visibleTranscript.lines.map((line, i) => {
                      const isHL =
                        visibleTranscript.startIdx !== -1 &&
                        i >= visibleTranscript.startIdx &&
                        i < visibleTranscript.startIdx + visibleTranscript.nodeLineCount;
                      const isFirstHL = isHL && i === visibleTranscript.startIdx;
                      return (
                        <div
                          key={`${visibleTranscript.sliceOffset}-${i}`}
                          ref={isFirstHL ? highlightedLineRef : undefined}
                          className={isHL ? "bg-amber-100 rounded px-0.5" : ""}
                        >
                          {line || "\u00A0"}
                        </div>
                      );
                    })
                  : rawTranscript}
              </div>
            )}

            {correctionError && (
              <div className="mt-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-600">
                {correctionError}
              </div>
            )}
            {correctionFeedback && (
              <div className="mt-1 rounded border border-green-200 bg-green-50 px-2 py-1 text-[11px] text-green-700">
                {correctionFeedback}
              </div>
            )}
          </div>
        )}

        {/* Thread */}
        {safeNode.thread_id && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Thread</span>
            <p className="text-gray-700 mt-0.5">
              {safeNode.thread_id}
              {safeNode.thread_state && (
                <span className="ml-2 text-xs text-gray-400">({safeNode.thread_state})</span>
              )}
            </p>
          </div>
        )}

        {/* Edge relations */}
        {relations.length > 0 && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Relations</span>
            <ul className="mt-1 space-y-1">
              {relations.map((rel, i) => (
                <li key={i} className="text-xs text-gray-600 flex items-start gap-1.5">
                  <span className="font-medium text-gray-500 shrink-0">
                    {rel.relation_type}
                  </span>
                  <span className="text-gray-400">
                    {rel.related_node}: {rel.relation_text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ADR-032 Part B pattern 3: argument-scaffold trace. Only meaningful
            if this node has incoming semantic edges authored. Render the button
            unconditionally for now — the trace shows 0 ancestors when the
            graph is sparse, which is itself useful signal. */}
        {onTraceAncestors && safeNode?.id && (
          <button
            type="button"
            onClick={() => onTraceAncestors(safeNode.id)}
            className="self-start rounded border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100 transition-colors"
            title="Dim everything except the nodes that support, imply, or clarify this one. Press Esc to exit."
          >
            ↑ Show what led here
          </button>
        )}

        {/* Fallback contextual relations */}
        {relations.length === 0 && contextualRelations.length > 0 && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Context</span>
            <ul className="mt-1 space-y-1">
              {contextualRelations.map(([name, text]) => (
                <li key={name} className="text-xs text-gray-600">
                  <span className="font-medium text-gray-500">{name}:</span>{" "}
                  {text}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Claims */}
        {safeNode.claims && safeNode.claims.length > 0 && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Claims</span>
            <ul className="mt-1 space-y-0.5">
              {safeNode.claims.map((claim, i) => (
                <li key={i} className="text-xs text-gray-600">
                  {claim}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Fact Check Analysis — only render when there's actual content
            to show. Empty {} or {claims:[]} returns no value and clutters
            the panel; suppress entirely. Loading spinner still shows so
            the user knows something's happening. */}
        {(factCheckLoading
          || (factCheckData
              && (factCheckData.summary
                  || (Array.isArray(factCheckData.claims) && factCheckData.claims.length > 0)))
        ) && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Analysis</span>
            {factCheckLoading && (
              <div className="mt-1 text-[11px] text-gray-500">Analyzing transcript...</div>
            )}
            {factCheckData && factCheckData.summary && (
              <div className="mt-1 text-xs text-gray-700 leading-relaxed bg-gray-50 rounded p-2">
                {factCheckData.summary}
              </div>
            )}
            {factCheckData && factCheckData.claims && factCheckData.claims.length > 0 && (
              <ul className="mt-2 space-y-2">
                {factCheckData.claims.map((claim, i) => (
                  <li
                    key={i}
                    className={`text-xs rounded p-2 ${
                      claim.flags?.includes("contradiction")
                        ? "bg-orange-50 border border-orange-200"
                        : claim.flags?.includes("fallacy") || claim.flags?.includes("uncertainty")
                        ? "bg-yellow-50 border border-yellow-200"
                        : "bg-gray-50 border border-gray-100"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <span
                        className={`text-[10px] font-medium uppercase px-1.5 py-0.5 rounded ${
                          claim.type === "factual"
                            ? "bg-blue-100 text-blue-700"
                            : claim.type === "normative"
                            ? "bg-purple-100 text-purple-700"
                            : "bg-teal-100 text-teal-700"
                        }`}
                      >
                        {claim.type}
                      </span>
                      {claim.flags?.length > 0 &&
                        claim.flags.map((flag) => (
                          <span
                            key={flag}
                            className={`text-[10px] font-medium uppercase px-1.5 py-0.5 rounded ${
                              flag === "contradiction"
                                ? "bg-orange-200 text-orange-800"
                                : "bg-yellow-200 text-yellow-800"
                            }`}
                          >
                            {flag}
                          </span>
                        ))}
                    </div>
                    <div className="text-gray-700">{claim.text}</div>
                    {claim.speaker && (
                      <div className="text-[10px] text-gray-400 mt-1">— {claim.speaker}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

NodeDetail.propTypes = {
  node: PropTypes.object,
  chunkDict: PropTypes.object,
  conversationId: PropTypes.string,
  audioUrl: PropTypes.string,
  onClose: PropTypes.func.isRequired,
  onSpeakerRenamed: PropTypes.func,
  onTraceAncestors: PropTypes.func,
  participantNames: PropTypes.arrayOf(PropTypes.string),
  contextNodes: PropTypes.arrayOf(PropTypes.object),
  onSelectNode: PropTypes.func,
};
