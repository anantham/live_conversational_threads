import { useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";

import { EDGE_COLORS } from "./graphConstants";
import { rerouteConversationArtifacts } from "../services/artifactSettingsApi";
import {
  fetchConversationSpeakers,
  updateConversationSpeakerName,
} from "../services/speakerNamingApi";

const EDGE_LEGEND = [
  { label: "supports", color: EDGE_COLORS.supports },
  { label: "rebuts", color: EDGE_COLORS.rebuts },
  { label: "clarifies", color: EDGE_COLORS.clarifies },
  { label: "tangent", color: EDGE_COLORS.tangent },
  { label: "returns", color: EDGE_COLORS.return_to_thread },
];

function buildFallbackSpeakers(speakerColorMap) {
  return Object.entries(speakerColorMap || {}).map(([speakerId]) => ({
    speaker_id: speakerId,
    speaker_name: "",
    display_name: speakerId,
    utterance_count: 0,
    confirmed: false,
  }));
}

function buildDraftMap(rows) {
  const next = {};
  (rows || []).forEach((row) => {
    next[row.speaker_id] = row.speaker_name || "";
  });
  return next;
}

export default function MinimalLegend({ speakerColorMap, conversationId, refreshKey }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savingSpeakerId, setSavingSpeakerId] = useState("");
  const [speakers, setSpeakers] = useState([]);
  const [draftNames, setDraftNames] = useState({});
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");

  const fallbackSpeakers = useMemo(
    () => buildFallbackSpeakers(speakerColorMap),
    [speakerColorMap]
  );
  const displaySpeakers = speakers.length > 0 ? speakers : fallbackSpeakers;

  const loadSpeakers = useCallback(async () => {
    if (!conversationId) {
      setSpeakers([]);
      setDraftNames({});
      return;
    }

    setLoading(true);
    setError("");
    setFeedback("");
    try {
      const rows = await fetchConversationSpeakers(conversationId);
      setSpeakers(Array.isArray(rows) ? rows : []);
      setDraftNames(buildDraftMap(Array.isArray(rows) ? rows : []));
    } catch (err) {
      if (String(err?.message || "").toLowerCase().includes("not found")) {
        setSpeakers([]);
        setDraftNames({});
      } else {
        console.error("Failed to load conversation speakers:", err);
        setError(err?.message || "Unable to load speakers.");
      }
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (!open) return;
    void loadSpeakers();
  }, [loadSpeakers, open, refreshKey]);

  useEffect(() => {
    if (speakers.length === 0) return;
    setDraftNames(buildDraftMap(speakers));
  }, [speakers]);

  const handleDraftChange = useCallback((speakerId) => (event) => {
    const value = event.target.value;
    setDraftNames((previous) => ({
      ...previous,
      [speakerId]: value,
    }));
  }, []);

  const handleSave = useCallback(async (speakerId) => {
    if (!conversationId || !speakerId) return;
    setSavingSpeakerId(speakerId);
    setError("");
    try {
      const rows = await updateConversationSpeakerName(
        conversationId,
        speakerId,
        draftNames[speakerId] || ""
      );
      const normalizedRows = Array.isArray(rows) ? rows : [];
      setSpeakers(normalizedRows);
      setDraftNames(buildDraftMap(normalizedRows));
      setFeedback("Speaker name saved.");
      try {
        const rerouteResult = await rerouteConversationArtifacts(conversationId);
        if (rerouteResult?.rerouted) {
          const target =
            rerouteResult?.resolved_root_path || rerouteResult?.root_path || "configured folder";
          setFeedback(`Speaker name saved. Artifacts updated in ${target}.`);
        }
      } catch (rerouteErr) {
        console.error("Artifact reroute after speaker rename failed:", rerouteErr);
        setFeedback(
          `Speaker name saved. Artifact reroute failed: ${
            rerouteErr?.message || "unknown error"
          }`
        );
      }
    } catch (err) {
      console.error("Failed to update speaker name:", err);
      setError(err?.message || "Unable to update speaker name.");
      setFeedback("");
    } finally {
      setSavingSpeakerId("");
    }
  }, [conversationId, draftNames]);

  return (
    <div className="absolute bottom-14 right-4 z-20">
      {open ? (
        <div className="bg-white/95 backdrop-blur rounded-lg shadow-md border border-gray-200 p-3 text-xs space-y-3 min-w-[220px] animate-slideIn">
          <button
            onClick={() => setOpen(false)}
            className="absolute top-1 right-1 p-2 text-gray-400 hover:text-gray-600 text-xs"
          >
            close
          </button>

          {displaySpeakers.length > 0 && (
            <div>
              <span className="font-medium text-gray-400 uppercase tracking-wider text-[10px]">
                Speakers
              </span>
              <div className="mt-2 space-y-2">
                {displaySpeakers.map((speaker) => {
                  const speakerId = speaker.speaker_id;
                  const color = speakerColorMap?.[speakerId] || "#cbd5e1";
                  const draftValue = draftNames[speakerId] ?? speaker.speaker_name ?? "";
                  const confirmed = Boolean(speaker.confirmed);
                  return (
                    <div key={speakerId} className="rounded border border-gray-200 px-2 py-2 space-y-2">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full border border-gray-300"
                          style={{ backgroundColor: color }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-gray-700 font-medium truncate">
                            {speaker.display_name || speakerId}
                          </div>
                          <div className="text-[10px] text-gray-400">
                            {speakerId}
                            {speaker.utterance_count > 0 ? ` • ${speaker.utterance_count} turns` : ""}
                            {confirmed ? " • confirmed" : ""}
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={draftValue}
                          onChange={handleDraftChange(speakerId)}
                          placeholder={speakerId}
                          className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700"
                        />
                        <button
                          type="button"
                          onClick={() => handleSave(speakerId)}
                          disabled={!conversationId || savingSpeakerId === speakerId}
                          className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          {savingSpeakerId === speakerId ? "Saving..." : "Save"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {loading ? (
            <div className="text-[11px] text-gray-500">Loading speaker aliases...</div>
          ) : null}

          {error ? (
            <div className="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-600">
              {error}
            </div>
          ) : null}

          {feedback ? (
            <div className="rounded border border-green-200 bg-green-50 px-2 py-1 text-[11px] text-green-700">
              {feedback}
            </div>
          ) : null}

          <div>
            <span className="font-medium text-gray-400 uppercase tracking-wider text-[10px]">
              Edges
            </span>
            <div className="mt-1 space-y-1">
              {EDGE_LEGEND.map(({ label, color }) => (
                <div key={label} className="flex items-center gap-2">
                  <div className="w-4 h-0.5" style={{ backgroundColor: color }} />
                  <span className="text-gray-600">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-white/85 hover:bg-white/95 backdrop-blur rounded-full shadow-sm border border-gray-200 text-gray-500 hover:text-gray-700 transition opacity-80 hover:opacity-100 text-[10px] font-medium"
          title="Speaker colors and edge key"
          aria-label="Show legend: speakers and edge colors"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
          Legend
        </button>
      )}
    </div>
  );
}

MinimalLegend.propTypes = {
  speakerColorMap: PropTypes.object,
  conversationId: PropTypes.string,
  refreshKey: PropTypes.number,
};
