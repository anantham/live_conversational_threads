import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const SOCKET_STATES = new Set(["idle", "connecting", "connected", "closed", "error"]);

const SPEECH_ACTIVITY_WINDOW_MS = 900;
const SPEECH_RESET_MS = 1400;
const BACKEND_STALE_MS = 10000;
const STT_WARN_MS = 3000;
const STT_ERROR_MS = 6000;
const GRAPH_WARN_MS = 8000;
const GRAPH_ERROR_MS = 12000;
const SPEECH_RMS_THRESHOLD = 0.018;

const PROVIDER_LABELS = {
  parakeet: "Parakeet",
  whisper: "Whisper",
  openai_audio: "OpenAI",
  openrouter_audio: "OpenRouter",
  external: "External",
};

function normalizeSocketState(state) {
  if (!state) return "idle";
  const normalized = String(state).trim().toLowerCase();
  return SOCKET_STATES.has(normalized) ? normalized : "idle";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatLatency(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  if (ms < 1000) return "now";
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s ago`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
  return `${Math.round(ms / 60000)}m ago`;
}

function toLatency(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100) / 100;
}

function providerLabel(provider) {
  const normalized = String(provider || "").trim().toLowerCase();
  return PROVIDER_LABELS[normalized] || (normalized ? normalized : "STT");
}

function buildChip(state, label, detail) {
  return { state, label, detail };
}

export default function useLiveSessionStatus({
  recording,
  backendSocketState,
  providerSocketState,
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [sessionAck, setSessionAck] = useState(null);
  const [audioLevel, setAudioLevel] = useState({ rms: 0, peak: 0, tsMs: null });
  const [lastSpeechAtMs, setLastSpeechAtMs] = useState(null);
  const [speechWindowStartedAtMs, setSpeechWindowStartedAtMs] = useState(null);
  const [lastServerMessageAtMs, setLastServerMessageAtMs] = useState(null);
  const [backendRttMs, setBackendRttMs] = useState(null);
  const [lastTranscriptAtMs, setLastTranscriptAtMs] = useState(null);
  const [lastFinalAtMs, setLastFinalAtMs] = useState(null);
  const [firstCaptionMs, setFirstCaptionMs] = useState(null);
  const [firstFinalCaptionMs, setFirstFinalCaptionMs] = useState(null);
  const [firstGraphNodeMs, setFirstGraphNodeMs] = useState(null);
  const [lastSttRequestMs, setLastSttRequestMs] = useState(null);
  const [lastProviderError, setLastProviderError] = useState("");
  const [graphPhase, setGraphPhase] = useState("idle");
  const [graphQueuedFinals, setGraphQueuedFinals] = useState(0);
  const [lastGraphUpdateAtMs, setLastGraphUpdateAtMs] = useState(null);
  const [lastGraphQueueWaitMs, setLastGraphQueueWaitMs] = useState(null);
  const [lastGraphLatencyMs, setLastGraphLatencyMs] = useState(null);
  const [lastGraphTotalUpdateMs, setLastGraphTotalUpdateMs] = useState(null);
  const [lastGraphError, setLastGraphError] = useState("");
  const [backgroundRefinementPhase, setBackgroundRefinementPhase] = useState("idle");
  const [lastBackgroundRefinementAtMs, setLastBackgroundRefinementAtMs] = useState(null);
  const [lastBackgroundRefinementLatencyMs, setLastBackgroundRefinementLatencyMs] = useState(null);
  const [lastBackgroundRefinementError, setLastBackgroundRefinementError] = useState("");
  const [backgroundRefinementStats, setBackgroundRefinementStats] = useState({
    provider: "",
    model: "",
    segmentsCount: null,
    updatedUtterances: null,
  });
  const [detailOpen, setDetailOpen] = useState(false);

  const graphStartedAtRef = useRef(null);
  const lastSpeechSignalAtRef = useRef(null);
  const speechWindowStartedAtRef = useRef(null);

  const resetSession = useCallback(() => {
    const nextNow = Date.now();
    graphStartedAtRef.current = null;
    lastSpeechSignalAtRef.current = null;
    speechWindowStartedAtRef.current = null;
    setNowMs(nextNow);
    setSessionAck(null);
    setAudioLevel({ rms: 0, peak: 0, tsMs: null });
    setLastSpeechAtMs(null);
    setSpeechWindowStartedAtMs(null);
    setLastServerMessageAtMs(null);
    setBackendRttMs(null);
    setLastTranscriptAtMs(null);
    setLastFinalAtMs(null);
    setFirstCaptionMs(null);
    setFirstFinalCaptionMs(null);
    setFirstGraphNodeMs(null);
    setLastSttRequestMs(null);
    setLastProviderError("");
    setGraphPhase("idle");
    setGraphQueuedFinals(0);
    setLastGraphUpdateAtMs(null);
    setLastGraphQueueWaitMs(null);
    setLastGraphLatencyMs(null);
    setLastGraphTotalUpdateMs(null);
    setLastGraphError("");
    setBackgroundRefinementPhase("idle");
    setLastBackgroundRefinementAtMs(null);
    setLastBackgroundRefinementLatencyMs(null);
    setLastBackgroundRefinementError("");
    setBackgroundRefinementStats({
      provider: "",
      model: "",
      segmentsCount: null,
      updatedUtterances: null,
    });
    setDetailOpen(false);
  }, []);

  useEffect(() => {
    if (
      !recording
      && normalizeSocketState(backendSocketState) !== "connecting"
      && normalizeSocketState(providerSocketState) !== "connecting"
      && !detailOpen
    ) {
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 400);
    return () => window.clearInterval(intervalId);
  }, [backendSocketState, detailOpen, providerSocketState, recording]);

  const speechPresent = Boolean(
    recording && lastSpeechAtMs && nowMs - lastSpeechAtMs <= SPEECH_ACTIVITY_WINDOW_MS
  );

  useEffect(() => {
    if (
      speechWindowStartedAtMs !== null
      && lastSpeechAtMs
      && nowMs - lastSpeechAtMs > SPEECH_RESET_MS
    ) {
      speechWindowStartedAtRef.current = null;
      setSpeechWindowStartedAtMs(null);
    }
  }, [lastSpeechAtMs, nowMs, speechWindowStartedAtMs]);

  const handleAudioLevel = useCallback((sample) => {
    const nextTsMs = Number.isFinite(sample?.tsMs) ? sample.tsMs : Date.now();
    const rms = clamp(Number(sample?.rms) || 0, 0, 1);
    const peak = clamp(Number(sample?.peak) || 0, 0, 1);
    const speechDetected = Math.max(rms, peak * 0.35) >= SPEECH_RMS_THRESHOLD;

    setAudioLevel({ rms, peak, tsMs: nextTsMs });
    if (!speechDetected) {
      return;
    }

    if (
      !speechWindowStartedAtRef.current
      || !lastSpeechSignalAtRef.current
      || nextTsMs - lastSpeechSignalAtRef.current > SPEECH_RESET_MS
    ) {
      speechWindowStartedAtRef.current = nextTsMs;
      setSpeechWindowStartedAtMs(nextTsMs);
    }
    lastSpeechSignalAtRef.current = nextTsMs;
    setLastSpeechAtMs(nextTsMs);
  }, []);

  const handleSessionAck = useCallback((message) => {
    setSessionAck(message || null);
    setLastServerMessageAtMs(Date.now());
    setLastProviderError("");
    if (message?.background_refinement?.enabled) {
      setBackgroundRefinementPhase("ready");
      setLastBackgroundRefinementError("");
      setBackgroundRefinementStats({
        provider: String(message?.background_refinement?.provider || ""),
        model: String(message?.background_refinement?.model || ""),
        segmentsCount: null,
        updatedUtterances: null,
      });
    } else {
      setBackgroundRefinementPhase("disabled");
      setBackgroundRefinementStats({
        provider: "",
        model: "",
        segmentsCount: null,
        updatedUtterances: null,
      });
    }
  }, []);

  const handleBackendMessage = useCallback((message) => {
    const nextNow = Date.now();
    setLastServerMessageAtMs(nextNow);
    if (message?.type === "existing_json" || message?.type === "graph_patch") {
      const patchKind =
        message?.type === "graph_patch"
          ? String(message?.data?.kind || "").trim().toLowerCase()
          : "finalized";
      const patchNodeCount =
        message?.type === "graph_patch" && Array.isArray(message?.data?.nodes)
          ? message.data.nodes.length
          : null;
      if (message?.type === "graph_patch" && patchNodeCount === 0) {
        return;
      }
      const startedAtMs = graphStartedAtRef.current;
      const firstGraphLatency = speechWindowStartedAtRef.current
        ? Math.round(Math.max(0, nextNow - speechWindowStartedAtRef.current) * 100) / 100
        : null;
      setGraphPhase(patchKind === "draft" ? "generating" : "completed");
      setGraphQueuedFinals(0);
      setLastGraphError("");
      setLastGraphUpdateAtMs(nextNow);
      setFirstGraphNodeMs((previous) => previous ?? firstGraphLatency);
      setLastGraphLatencyMs(
        startedAtMs ? Math.round((nextNow - startedAtMs) * 100) / 100 : null
      );
    }
  }, []);

  const handlePong = useCallback((message) => {
    const clientTsMs = Number(message?.client_ts_ms);
    if (!Number.isFinite(clientTsMs) || clientTsMs <= 0) {
      return;
    }
    setBackendRttMs(Math.round(Math.max(0, Date.now() - clientTsMs) * 100) / 100);
  }, []);

  const handleTranscriptEvent = useCallback((event) => {
    const nextNow = Date.now();
    const telemetry =
      event?.metadata && typeof event.metadata.telemetry === "object"
        ? event.metadata.telemetry
        : {};
    const isFinal = event?.eventType === "transcript_final";
    const partialTurnaroundMs = toLatency(telemetry.partial_turnaround_ms);
    const finalTurnaroundMs = toLatency(telemetry.final_turnaround_ms);
    const sttRequestMs = toLatency(telemetry.stt_request_ms);

    setLastTranscriptAtMs(nextNow);
    if (sttRequestMs !== null) {
      setLastSttRequestMs(sttRequestMs);
    }
    if (partialTurnaroundMs !== null) {
      setFirstCaptionMs((previous) => previous ?? partialTurnaroundMs);
    } else if (!isFinal && speechWindowStartedAtRef.current) {
      setFirstCaptionMs((previous) => (
        previous ?? Math.round((nextNow - speechWindowStartedAtRef.current) * 100) / 100
      ));
    }
    if (isFinal) {
      setLastFinalAtMs(nextNow);
      if (finalTurnaroundMs !== null) {
        setFirstFinalCaptionMs((previous) => previous ?? finalTurnaroundMs);
      }
      setGraphPhase((previous) => (previous === "generating" ? previous : "queued"));
      setGraphQueuedFinals((previous) => Math.max(previous, 1));
    }
    setLastProviderError("");
  }, []);

  const handleProcessingStatus = useCallback((status) => {
    const nextNow = Date.now();
    const level = String(status?.level || "info").trim().toLowerCase();
    const message = String(status?.message || "").trim();
    const context = status?.context && typeof status.context === "object" ? status.context : {};
    const stage = String(context.stage || "").trim().toLowerCase();
    const phase = String(context.phase || "").trim().toLowerCase();
    const queueWaitMs = toLatency(context.queue_wait_ms);
    const generationMs = toLatency(context.generation_ms ?? context.latency_ms);
    const totalUpdateMs = toLatency(context.total_update_ms);

    if (stage === "stt" && level === "error" && message) {
      setLastProviderError(message);
    }

    const graphErrorStage = stage === "graph" || stage === "handle_final_text" || stage === "flush";
    if (graphErrorStage && level === "error" && message) {
      setGraphPhase("error");
      setGraphQueuedFinals(0);
      setLastGraphError(message);
      if (queueWaitMs !== null) {
        setLastGraphQueueWaitMs(queueWaitMs);
      }
      if (generationMs !== null) {
        setLastGraphLatencyMs(generationMs);
      } else if (graphStartedAtRef.current) {
        setLastGraphLatencyMs(
          Math.round(Math.max(0, nextNow - graphStartedAtRef.current) * 100) / 100
        );
      }
      if (totalUpdateMs !== null) {
        setLastGraphTotalUpdateMs(totalUpdateMs);
      } else if (queueWaitMs !== null || generationMs !== null) {
        setLastGraphTotalUpdateMs(
          Math.round(((queueWaitMs || 0) + (generationMs || 0)) * 100) / 100
        );
      } else if (graphStartedAtRef.current) {
        setLastGraphTotalUpdateMs(
          Math.round(Math.max(0, nextNow - graphStartedAtRef.current) * 100) / 100
        );
      }
      return;
    }

    if (stage === "stt_refinement") {
      const refinementLatencyMs = toLatency(context.latency_ms);
      if (phase === "completed") {
        setBackgroundRefinementPhase("completed");
        setLastBackgroundRefinementAtMs(nextNow);
        setLastBackgroundRefinementLatencyMs(refinementLatencyMs);
        setLastBackgroundRefinementError("");
        setBackgroundRefinementStats({
          provider: String(context.provider || ""),
          model: String(context.model || ""),
          segmentsCount: Number.isFinite(Number(context.segments_count))
            ? Number(context.segments_count)
            : null,
          updatedUtterances: Number.isFinite(Number(context.updated_utterances))
            ? Number(context.updated_utterances)
            : null,
        });
        return;
      }
      if (phase === "error" || level === "warning" || level === "error") {
        setBackgroundRefinementPhase("error");
        setLastBackgroundRefinementAtMs(nextNow);
        setLastBackgroundRefinementLatencyMs(refinementLatencyMs);
        setLastBackgroundRefinementError(message || String(context.error || "").trim());
        setBackgroundRefinementStats((previous) => ({
          ...previous,
          provider: String(context.provider || previous.provider || ""),
          model: String(context.model || previous.model || ""),
        }));
        return;
      }
    }

    if (stage !== "graph") {
      return;
    }

    if (phase === "queued") {
      setGraphPhase("queued");
      setGraphQueuedFinals(Math.max(1, Number(context.queued_finals) || 0));
      if (queueWaitMs !== null) {
        setLastGraphQueueWaitMs(queueWaitMs);
      }
      setLastGraphError("");
      return;
    }

    if (phase === "generating") {
      graphStartedAtRef.current = nextNow;
      setGraphPhase("generating");
      setGraphQueuedFinals(Math.max(1, Number(context.queued_finals) || 0));
      if (queueWaitMs !== null) {
        setLastGraphQueueWaitMs(queueWaitMs);
      }
      setLastGraphError("");
      return;
    }

    if (phase === "completed") {
      const firstGraphLatency = speechWindowStartedAtRef.current
        ? Math.round(Math.max(0, nextNow - speechWindowStartedAtRef.current) * 100) / 100
        : totalUpdateMs ?? generationMs;
      setGraphPhase("completed");
      setGraphQueuedFinals(0);
      setLastGraphUpdateAtMs(nextNow);
      setFirstGraphNodeMs((previous) => previous ?? firstGraphLatency);
      setLastGraphQueueWaitMs(queueWaitMs);
      setLastGraphLatencyMs(
        generationMs ?? (
          graphStartedAtRef.current
            ? Math.round(Math.max(0, nextNow - graphStartedAtRef.current) * 100) / 100
            : null
        )
      );
      setLastGraphTotalUpdateMs(
        totalUpdateMs ?? (
          queueWaitMs !== null || generationMs !== null
            ? Math.round(((queueWaitMs || 0) + (generationMs || 0)) * 100) / 100
            : null
        )
      );
      setLastGraphError("");
      return;
    }

    if (phase === "empty" && message) {
      setGraphPhase("error");
      setGraphQueuedFinals(0);
      setLastGraphError(message);
      if (queueWaitMs !== null) {
        setLastGraphQueueWaitMs(queueWaitMs);
      }
      if (generationMs !== null) {
        setLastGraphLatencyMs(generationMs);
      }
      if (totalUpdateMs !== null) {
        setLastGraphTotalUpdateMs(totalUpdateMs);
      }
    }
  }, []);

  const micLevel = useMemo(
    () => clamp(Math.max(audioLevel.rms * 8, audioLevel.peak * 1.8), 0, 1),
    [audioLevel.peak, audioLevel.rms]
  );

  const backendSocket = normalizeSocketState(backendSocketState);
  const providerSocket = normalizeSocketState(providerSocketState);
  const providerName = providerLabel(sessionAck?.provider);
  const fallbackLabels = Array.isArray(sessionAck?.fallback_candidates)
    ? sessionAck.fallback_candidates
        .map((candidate) => providerLabel(candidate?.provider))
        .filter(Boolean)
        .join(", ")
    : "";
  const backgroundRefinementEnabled = Boolean(sessionAck?.background_refinement?.enabled);
  const backgroundRefinementLabel = useMemo(() => {
    if (!backgroundRefinementEnabled) return "off";
    if (backgroundRefinementPhase === "error") {
      return lastBackgroundRefinementError ? "error" : "failed";
    }
    if (backgroundRefinementPhase === "completed") return "completed";
    if (backgroundRefinementPhase === "ready") return "pending";
    return backgroundRefinementPhase || "pending";
  }, [
    backgroundRefinementEnabled,
    backgroundRefinementPhase,
    lastBackgroundRefinementError,
  ]);

  const backendStaleMs = lastServerMessageAtMs ? nowMs - lastServerMessageAtMs : null;
  const lastTranscriptAgeMs = lastTranscriptAtMs ? nowMs - lastTranscriptAtMs : null;
  const lastSpeechAgeMs = lastSpeechAtMs ? nowMs - lastSpeechAtMs : null;
  const sttAwaitingMs = speechPresent && speechWindowStartedAtMs
    ? nowMs - speechWindowStartedAtMs
    : null;
  const graphAwaitingMs = lastFinalAtMs && (!lastGraphUpdateAtMs || lastGraphUpdateAtMs < lastFinalAtMs)
    ? nowMs - lastFinalAtMs
    : null;
  const graphWorkingMs = graphPhase === "generating" && graphStartedAtRef.current
    ? nowMs - graphStartedAtRef.current
    : graphAwaitingMs;

  const backend = useMemo(() => {
    if (backendSocket === "error") {
      return buildChip("error", "Backend lost", "WebSocket failed");
    }
    if (backendSocket === "connecting") {
      return buildChip("connecting", "Backend...", "Opening websocket");
    }
    if (backendSocket === "connected") {
      if (backendStaleMs !== null && backendStaleMs > BACKEND_STALE_MS) {
        return buildChip("error", "Backend lost", "No recent server messages");
      }
      if (backendRttMs !== null && backendRttMs > 300) {
        return buildChip("degraded", `Backend ${formatLatency(backendRttMs)}`, "Transport is slow");
      }
      if (backendRttMs !== null) {
        return buildChip("healthy", `Backend ${formatLatency(backendRttMs)}`, "Transport healthy");
      }
      return buildChip("healthy", "Backend live", "Connected");
    }
    if (recording) {
      return buildChip("connecting", "Backend...", "Waiting for websocket");
    }
    return buildChip("idle", "Backend idle", "No active session");
  }, [backendRttMs, backendSocket, backendStaleMs, recording]);

  const stt = useMemo(() => {
    if (providerSocket === "error" || sessionAck?.stt_ready === false) {
      return buildChip("error", "STT failed", lastProviderError || "Provider unavailable");
    }
    if (!sessionAck && (providerSocket === "connecting" || recording)) {
      return buildChip("connecting", "STT...", "Waiting for session ack");
    }

    const latencyLabel = firstCaptionMs !== null
      ? formatLatency(firstCaptionMs)
      : (lastSttRequestMs !== null ? formatLatency(lastSttRequestMs) : null);
    const speakingWithoutCaption = Boolean(
      speechPresent && speechWindowStartedAtMs && !lastTranscriptAtMs
    );
    const speakingSinceMs = speechPresent && speechWindowStartedAtMs
      ? nowMs - speechWindowStartedAtMs
      : null;

    if (lastProviderError) {
      return buildChip("error", "STT failed", lastProviderError);
    }
    if (
      speakingWithoutCaption
      && speakingSinceMs !== null
      && speakingSinceMs > STT_ERROR_MS
    ) {
      return buildChip(
        "error",
        `STT ${providerName} ${formatLatency(speakingSinceMs)}`,
        "Speech detected but no captions returned"
      );
    }
    if (
      speakingWithoutCaption
      && speakingSinceMs !== null
      && speakingSinceMs > STT_WARN_MS
    ) {
      return buildChip(
        "degraded",
        `STT ${providerName} ${formatLatency(speakingSinceMs)}`,
        "Speech detected but captions are late"
      );
    }
    if (
      speechPresent
      && lastTranscriptAgeMs !== null
      && lastTranscriptAgeMs > STT_ERROR_MS
    ) {
      return buildChip(
        "error",
        `STT ${providerName} ${formatLatency(lastTranscriptAgeMs)}`,
        "Caption stream has gone stale"
      );
    }
    if (
      speechPresent
      && lastTranscriptAgeMs !== null
      && lastTranscriptAgeMs > STT_WARN_MS
    ) {
      return buildChip(
        "degraded",
        `STT ${providerName} ${formatLatency(lastTranscriptAgeMs)}`,
        "Caption stream is delayed"
      );
    }
    if (sessionAck?.degraded || (firstCaptionMs !== null && firstCaptionMs > STT_WARN_MS)) {
      return buildChip(
        "degraded",
        latencyLabel ? `STT ${providerName} ${latencyLabel}` : `STT ${providerName}`,
        sessionAck?.degraded ? "Degraded fallback route" : "Caption latency is above target"
      );
    }
    if (lastTranscriptAtMs) {
      return buildChip(
        "healthy",
        latencyLabel ? `STT ${providerName} ${latencyLabel}` : `STT ${providerName}`,
        "Captions flowing"
      );
    }
    if (recording || providerSocket === "connected") {
      return buildChip(
        "connecting",
        sttAwaitingMs !== null ? `STT ${providerName} ${formatLatency(sttAwaitingMs)}` : `STT ${providerName}`,
        speechPresent ? "Waiting for captions" : "Listening for speech"
      );
    }
    return buildChip("idle", "STT idle", "No active transcription");
  }, [
    firstCaptionMs,
    lastProviderError,
    lastSttRequestMs,
    lastTranscriptAgeMs,
    lastTranscriptAtMs,
    nowMs,
    providerName,
    providerSocket,
    recording,
    sessionAck,
    speechPresent,
    speechWindowStartedAtMs,
    sttAwaitingMs,
  ]);

  const graph = useMemo(() => {
    if (lastGraphError) {
      return buildChip("error", "Graph failed", lastGraphError);
    }
    if (graphPhase === "generating" || graphPhase === "queued") {
      return buildChip(
        "processing",
        graphWorkingMs !== null ? `Graph ${formatLatency(graphWorkingMs)}` : "Graph building",
        graphPhase === "generating" ? "Generating node updates" : "Waiting on finalized transcript"
      );
    }
    if (graphAwaitingMs !== null && graphAwaitingMs > GRAPH_ERROR_MS) {
      return buildChip(
        "error",
        `Graph ${formatLatency(graphAwaitingMs)}`,
        "Final transcript has not produced graph output"
      );
    }
    if (graphAwaitingMs !== null && graphAwaitingMs > GRAPH_WARN_MS) {
      return buildChip(
        "degraded",
        `Graph ${formatLatency(graphAwaitingMs)}`,
        "Node updates are behind captions"
      );
    }
    if (graphAwaitingMs !== null) {
      return buildChip("processing", `Graph ${formatLatency(graphAwaitingMs)}`, "Final transcript queued");
    }
    if (lastGraphUpdateAtMs) {
      const completedGraphLatencyMs = lastGraphTotalUpdateMs ?? lastGraphLatencyMs;
      if (completedGraphLatencyMs !== null && completedGraphLatencyMs > GRAPH_WARN_MS) {
        return buildChip("degraded", `Graph ${formatLatency(completedGraphLatencyMs)}`, "Graph generation is slow");
      }
      return buildChip(
        "healthy",
        completedGraphLatencyMs !== null ? `Graph ${formatLatency(completedGraphLatencyMs)}` : "Graph ready",
        "Node updates flowing"
      );
    }
    if (recording) {
      return buildChip("idle", "Graph idle", "No finalized transcript yet");
    }
    return buildChip("idle", "Graph idle", "No active session");
  }, [graphAwaitingMs, graphPhase, graphWorkingMs, lastGraphError, lastGraphLatencyMs, lastGraphTotalUpdateMs, lastGraphUpdateAtMs, recording]);

  const summary = useMemo(() => {
    let headline = "Ready";
    if (backend.state === "error") {
      headline = "Backend connection lost";
    } else if (stt.state === "error") {
      headline = lastProviderError || "STT is failing";
    } else if (graph.state === "error") {
      headline = "Graph generation failed";
    } else if (graph.state === "processing" && stt.state === "healthy") {
      headline = "Captions live, graph updating";
    } else if (stt.state === "degraded") {
      headline = "STT is slow";
    } else if (recording && !lastTranscriptAtMs && speechPresent) {
      headline = "Transcribing...";
    } else if (recording) {
      headline = "Listening";
    }

    const parts = [headline];
    if (recording) {
      if (lastSpeechAgeMs !== null) {
        parts.push(`last heard ${formatAge(lastSpeechAgeMs)}`);
      } else {
        parts.push("waiting for speech");
      }
      if (lastTranscriptAgeMs !== null) {
        parts.push(`last caption ${formatAge(lastTranscriptAgeMs)}`);
      } else if (speechPresent) {
        parts.push("caption pending");
      }
    }
    return parts.join(" · ");
  }, [
    backend.state,
    graph.state,
    lastProviderError,
    lastSpeechAgeMs,
    lastTranscriptAgeMs,
    lastTranscriptAtMs,
    recording,
    speechPresent,
    stt.state,
  ]);

  const details = useMemo(() => ([
    {
      title: "Capture",
      rows: [
        {
          label: "Mic state",
          value: recording ? (speechPresent ? "speech detected" : "listening") : "idle",
        },
        {
          label: "Input level",
          value: `RMS ${audioLevel.rms.toFixed(3)} / Peak ${audioLevel.peak.toFixed(3)}`,
        },
        {
          label: "Last heard",
          value: lastSpeechAgeMs !== null ? formatAge(lastSpeechAgeMs) : "no speech yet",
        },
      ],
    },
    {
      title: "Backend",
      rows: [
        { label: "State", value: backend.label },
        { label: "Round-trip", value: backendRttMs !== null ? formatLatency(backendRttMs) : "pending" },
        {
          label: "Last server event",
          value: backendStaleMs !== null ? formatAge(backendStaleMs) : "waiting",
        },
        {
          label: "Session",
          value: sessionAck?.session_id || "not started",
        },
      ],
    },
    {
      title: "STT",
      rows: [
        {
          label: "Provider",
          value: sessionAck ? `${providerName} (${sessionAck.transport || "backend_http"})` : "pending",
        },
        {
          label: "Model",
          value: sessionAck?.model || "server default",
        },
        {
          label: "First caption",
          value: firstCaptionMs !== null ? formatLatency(firstCaptionMs) : "waiting",
        },
        {
          label: "Final caption",
          value: firstFinalCaptionMs !== null ? formatLatency(firstFinalCaptionMs) : "waiting",
        },
        {
          label: "Last STT request",
          value: lastSttRequestMs !== null ? formatLatency(lastSttRequestMs) : "waiting",
        },
        {
          label: "Current wait",
          value: sttAwaitingMs !== null ? formatLatency(sttAwaitingMs) : "waiting",
        },
        {
          label: "Fallbacks",
          value: fallbackLabels || "none",
        },
        {
          label: "Background pass",
          value: backgroundRefinementLabel,
        },
        {
          label: "Refinement route",
          value: backgroundRefinementEnabled
            ? [
                backgroundRefinementStats.provider || sessionAck?.background_refinement?.provider || "",
                backgroundRefinementStats.model || sessionAck?.background_refinement?.model || "",
              ].filter(Boolean).join(" · ") || "configured"
            : "disabled",
        },
        {
          label: "Last refinement",
          value: lastBackgroundRefinementAtMs
            ? `${formatAge(nowMs - lastBackgroundRefinementAtMs)}${
                lastBackgroundRefinementLatencyMs !== null
                  ? ` · ${formatLatency(lastBackgroundRefinementLatencyMs)}`
                  : ""
              }`
            : "waiting",
        },
        {
          label: "Refined segments",
          value: backgroundRefinementStats.segmentsCount !== null
            ? String(backgroundRefinementStats.segmentsCount)
            : "waiting",
        },
        {
          label: "Updated utterances",
          value: backgroundRefinementStats.updatedUtterances !== null
            ? String(backgroundRefinementStats.updatedUtterances)
            : "waiting",
        },
        {
          label: "Latest error",
          value: lastBackgroundRefinementError || lastProviderError || "none",
        },
      ],
    },
    {
      title: "Graph",
      rows: [
        { label: "State", value: graph.label },
        {
          label: "Phase",
          value: graphPhase || "idle",
        },
        {
          label: "Queued finals",
          value: graphQueuedFinals > 0 ? String(graphQueuedFinals) : "0",
        },
        {
          label: "Queue wait",
          value: lastGraphQueueWaitMs !== null ? formatLatency(lastGraphQueueWaitMs) : "waiting",
        },
        {
          label: "Generation",
          value: lastGraphLatencyMs !== null ? formatLatency(lastGraphLatencyMs) : "waiting",
        },
        {
          label: "Last total",
          value: lastGraphTotalUpdateMs !== null ? formatLatency(lastGraphTotalUpdateMs) : "waiting",
        },
        {
          label: "First node",
          value: firstGraphNodeMs !== null ? formatLatency(firstGraphNodeMs) : "waiting",
        },
        {
          label: "Last update",
          value: lastGraphUpdateAtMs ? formatAge(nowMs - lastGraphUpdateAtMs) : "waiting",
        },
        {
          label: "Latest error",
          value: lastGraphError || "none",
        },
      ],
    },
  ]), [
    audioLevel.peak,
    audioLevel.rms,
    backend.label,
    backendRttMs,
    backendStaleMs,
    backgroundRefinementEnabled,
    backgroundRefinementLabel,
    backgroundRefinementStats.model,
    backgroundRefinementStats.provider,
    backgroundRefinementStats.segmentsCount,
    backgroundRefinementStats.updatedUtterances,
    fallbackLabels,
    firstCaptionMs,
    firstFinalCaptionMs,
    firstGraphNodeMs,
    graph.label,
    graphPhase,
    graphQueuedFinals,
    lastGraphError,
    lastGraphQueueWaitMs,
    lastGraphLatencyMs,
    lastGraphTotalUpdateMs,
    lastGraphUpdateAtMs,
    lastBackgroundRefinementAtMs,
    lastBackgroundRefinementError,
    lastBackgroundRefinementLatencyMs,
    lastProviderError,
    lastSpeechAgeMs,
    lastSttRequestMs,
    nowMs,
    providerName,
    recording,
    sessionAck,
    speechPresent,
    sttAwaitingMs,
  ]);

  return {
    backend,
    detailOpen,
    details,
    graph,
    handleAudioLevel,
    handleBackendMessage,
    handlePong,
    handleProcessingStatus,
    handleSessionAck,
    handleTranscriptEvent,
    micLevel,
    recording,
    resetSession,
    sessionAck,
    setDetailOpen,
    statusLine: summary,
    stt,
  };
}
