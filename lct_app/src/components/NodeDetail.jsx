import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import PropTypes from "prop-types";
import { rerouteConversationArtifacts } from "../services/artifactSettingsApi";
import {
  fetchConversationSpeakers,
  updateConversationSpeakerName,
} from "../services/speakerNamingApi";
import { apiFetch } from "../services/apiClient";

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
}) {
  const safeNode = node ?? null;
  const [speakerNameDraft, setSpeakerNameDraft] = useState("");
  const [speakerLoading, setSpeakerLoading] = useState(false);
  const [speakerSaving, setSpeakerSaving] = useState(false);
  const [speakerError, setSpeakerError] = useState("");
  const [speakerFeedback, setSpeakerFeedback] = useState("");

  const [factCheckData, setFactCheckData] = useState(null);
  const [factCheckLoading, setFactCheckLoading] = useState(false);

  const audioRef = useRef(null);

  useEffect(() => {
    if (!audioRef.current || !safeNode) return;
    const ts = safeNode.timestamp_start ?? safeNode.start_time;
    if (ts == null || ts < 0) return;
    
    // Seek to the timestamp. If it's stored in ms, divide by 1000. It seems the backend uses seconds or ms, let's check.
    // If ts > 1000000, it's likely ms, otherwise seconds.
    // Wait, the backend uses seconds for utterance_start, but let's just assume seconds unless it's huge.
    // Or in HorizontalTimeline it did: formatTimestamp(utt.timestamp_start) which might mean seconds.
    // Let's use it as seconds.
    const timeInSeconds = ts > 10000 ? ts / 1000 : ts;
    
    audioRef.current.currentTime = timeInSeconds;
    audioRef.current.play().catch(e => console.warn("Auto-play prevented:", e));
  }, [safeNode]);

  const relations = Array.isArray(safeNode?.edge_relations) ? safeNode.edge_relations : [];
  const contextualRelations = normalizeContextualRelations(safeNode?.contextual_relation);
  const canRenameSpeaker = Boolean(conversationId && safeNode?.speaker_id);
  const displaySpeakerName = speakerNameDraft.trim() || safeNode?.speaker_display || safeNode?.speaker_id || "";

  // Raw transcript for this node's chunk
  const rawTranscript = safeNode?.chunk_id ? chunkDict?.[safeNode.chunk_id] || null : null;

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

  useEffect(() => {
    if (!safeNode) return undefined;
    const handleKeydown = (event) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [safeNode, onClose]);

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

  useEffect(() => {
    if (!canRenameSpeaker) {
      setSpeakerNameDraft("");
      setSpeakerError("");
      setSpeakerFeedback("");
      return undefined;
    }

    let cancelled = false;

    async function loadSpeakerAlias() {
      setSpeakerLoading(true);
      setSpeakerError("");
      setSpeakerFeedback("");
      try {
        const rows = await fetchConversationSpeakers(conversationId);
        if (cancelled) return;
        const row = Array.isArray(rows)
          ? rows.find((item) => item?.speaker_id === safeNode.speaker_id)
          : null;
        setSpeakerNameDraft(row?.speaker_name || "");
      } catch (error) {
        if (cancelled) return;
        console.error("Failed to load speaker alias:", error);
        setSpeakerError(error?.message || "Unable to load speaker alias.");
      } finally {
        if (!cancelled) {
          setSpeakerLoading(false);
        }
      }
    }

    void loadSpeakerAlias();

    return () => {
      cancelled = true;
    };
  }, [canRenameSpeaker, conversationId, safeNode?.speaker_id]);

  const handleSpeakerNameSave = useCallback(async () => {
    if (!canRenameSpeaker || speakerSaving) return;

    setSpeakerSaving(true);
    setSpeakerError("");
    setSpeakerFeedback("");
    try {
      await updateConversationSpeakerName(
        conversationId,
        safeNode.speaker_id,
        speakerNameDraft
      );
      setSpeakerFeedback("Speaker name saved.");
      onSpeakerRenamed?.(safeNode.speaker_id, speakerNameDraft);

      try {
        const rerouteResult = await rerouteConversationArtifacts(conversationId);
        if (rerouteResult?.rerouted) {
          const target =
            rerouteResult?.resolved_root_path || rerouteResult?.root_path || "configured folder";
          setSpeakerFeedback(`Speaker name saved. Artifacts updated in ${target}.`);
        }
      } catch (rerouteError) {
        console.error("Artifact reroute after speaker rename failed:", rerouteError);
        setSpeakerFeedback(
          `Speaker name saved. Artifact reroute failed: ${
            rerouteError?.message || "unknown error"
          }`
        );
      }
    } catch (error) {
      console.error("Failed to save speaker alias:", error);
      setSpeakerError(error?.message || "Unable to save speaker alias.");
      setSpeakerFeedback("");
    } finally {
      setSpeakerSaving(false);
    }
  }, [
    canRenameSpeaker,
    conversationId,
    onSpeakerRenamed,
    safeNode?.speaker_id,
    speakerNameDraft,
    speakerSaving,
  ]);

  if (!safeNode) return null;

  return (
    <div className="fixed top-0 right-0 h-full w-full sm:w-80 sm:max-w-[85vw] bg-white shadow-lg border-l border-gray-200 z-40 flex flex-col animate-slideIn">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800 truncate pr-2">
          {safeNode.node_name}
        </h3>
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
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider block mb-1">
              Audio playback
            </span>
            <audio 
              ref={audioRef}
              src={audioUrl}
              controls
              className="w-full h-8"
              preload="metadata"
            />
          </div>
        )}

        {/* Speaker */}
        {safeNode.speaker_id && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Speaker</span>
            <div className="mt-1 space-y-2">
              <div className="rounded border border-gray-200 px-2 py-2">
                <div className="text-gray-700 font-medium">
                  {displaySpeakerName}
                </div>
                <div className="text-[10px] text-gray-400">
                  Speaker ID: {safeNode.speaker_id}
                </div>
              </div>
              {canRenameSpeaker && (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={speakerNameDraft}
                    onChange={(event) => setSpeakerNameDraft(event.target.value)}
                    placeholder={safeNode.speaker_id}
                    className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700"
                  />
                  <button
                    type="button"
                    onClick={handleSpeakerNameSave}
                    disabled={speakerSaving}
                    className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {speakerSaving ? "Saving..." : "Save"}
                  </button>
                </div>
              )}
              {speakerLoading ? (
                <div className="text-[11px] text-gray-500">Loading speaker alias...</div>
              ) : null}
              {speakerError ? (
                <div className="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-600">
                  {speakerError}
                </div>
              ) : null}
              {speakerFeedback ? (
                <div className="rounded border border-green-200 bg-green-50 px-2 py-1 text-[11px] text-green-700">
                  {speakerFeedback}
                </div>
              ) : null}
            </div>
          </div>
        )}

        {/* Summary */}
        {safeNode.summary && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Summary</span>
            <p className="text-gray-700 mt-0.5 leading-relaxed">{safeNode.summary}</p>
          </div>
        )}

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

        {/* Raw transcript chunk (what the LLM saw) */}
        {rawTranscript && (
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
              Raw Transcript
            </span>
            <div className="mt-1 max-h-48 overflow-y-auto rounded bg-gray-50 border border-gray-100 px-2 py-1.5 text-xs text-gray-600 leading-relaxed whitespace-pre-wrap">
              {highlightedTranscript
                ? highlightedTranscript.lines.map((line, i) => {
                    const isHL =
                      highlightedTranscript.startIdx !== -1 &&
                      i >= highlightedTranscript.startIdx &&
                      i < highlightedTranscript.startIdx + highlightedTranscript.nodeLineCount;
                    return (
                      <div
                        key={i}
                        className={isHL ? "bg-amber-100 rounded px-0.5" : ""}
                      >
                        {line || "\u00A0"}
                      </div>
                    );
                  })
                : rawTranscript}
            </div>
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

        {/* Fact Check Analysis */}
        {(factCheckLoading || factCheckData) && (
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
  onClose: PropTypes.func.isRequired,
  onSpeakerRenamed: PropTypes.func,
};
