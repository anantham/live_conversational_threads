import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTranscriptReview, correctTranscriptText } from "../../services/transcriptReviewApi";

const HISTORY_KEY = "lct.transcript-review.timing.v1";
function recordRun(stage, started, outcome) {
  try {
    const previous = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    localStorage.setItem(HISTORY_KEY, JSON.stringify([
      ...(Array.isArray(previous) ? previous : []).slice(-31),
      { stage, milliseconds: Math.round(performance.now() - started), outcome },
    ]));
  } catch { /* Storage is optional; never retain payloads or conversation identities. */ }
}

export default function useTranscriptReview(conversationId) {
  const [data, setData] = useState(null);
  const [operation, setOperation] = useState(null);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const controller = useRef(null);
  const generation = useRef(0);
  const run = useCallback(async (stage, action) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const current = ++generation.current;
    const started = performance.now();
    setOperation(stage); setError(""); setElapsed(0);
    try {
      const result = await action(abort.signal);
      recordRun(stage, started, "success");
      if (current !== generation.current) return null;
      return result;
    } catch (failure) {
      recordRun(stage, started, failure.name === "AbortError" ? "cancelled" : "failed");
      if (current === generation.current) setError(failure.name === "AbortError"
        ? "Stopped waiting. Reload to check whether the change was saved."
        : failure.message || "Transcript request failed. Try again.");
      return null;
    } finally {
      if (current === generation.current) setOperation(null);
    }
  }, []);
  const reload = useCallback(async () => {
    const result = await run("Loading transcript", (signal) => fetchTranscriptReview(conversationId, signal));
    if (result) setData(result);
  }, [conversationId, run]);
  useEffect(() => {
    setData(null);
    void reload();
    return () => { generation.current += 1; controller.current?.abort(); };
  }, [reload]);
  useEffect(() => {
    if (!operation) return undefined;
    const started = Date.now();
    const interval = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [operation]);
  const save = useCallback(async (row, text) => {
    const result = await run("Saving correction", (signal) => correctTranscriptText(conversationId, row, text, signal));
    if (result) setData((previous) => ({ ...previous,
      graph_refresh_required: result.graph_refresh_required,
      utterances: previous.utterances.map((value) => value.id === row.id ? result.utterance : value),
    }));
    return result;
  }, [conversationId, run]);
  return { data, operation, error, elapsed, reload, save, stopWaiting: () => controller.current?.abort() };
}
