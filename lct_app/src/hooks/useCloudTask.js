import { useCallback, useEffect, useRef, useState } from "react";

const HISTORY_KEYS = { public: "lct.public_tasks_timing.v1", "private-conversation": "lct.private_conversation_timing.v1" };
const STAGES = ["list", "prepare", "publish", "remove", "load"];

function record(historyKey, stage, durationMs, outcome, retryCount) {
  try {
    const saved = JSON.parse(localStorage.getItem(historyKey) || "[]");
    const previous = Array.isArray(saved) ? saved.filter(item => STAGES.includes(item?.stage) && Number.isFinite(item?.durationMs) && ["success", "error", "timeout", "cancelled"].includes(item?.outcome) && Number.isInteger(item?.retryCount)).map(({ stage: name, durationMs: duration, outcome: result, retryCount: retries }) => ({ stage: name, durationMs: duration, outcome: result, retryCount: retries })) : [];
    localStorage.setItem(historyKey, JSON.stringify([...previous, { stage, durationMs: Math.max(0, Math.round(durationMs)), outcome, retryCount }].slice(-12)));
  } catch { /* Payload-free timing is optional. */ }
}

export function useCloudTask(scope = "public") {
  const historyKey = HISTORY_KEYS[scope];
  if (!historyKey) throw new Error("Unknown cloud task scope.");
  const [activity, setActivity] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const current = useRef(null), alive = useRef(true), retries = useRef({});
  const cancel = useCallback(() => current.current?.controller.abort(), []);
  useEffect(() => {
    alive.current = true;
    retries.current = {};
    return () => { alive.current = false; cancel(); current.current = null; };
  }, [cancel, historyKey]);
  const run = useCallback(async (stage, work) => {
    if (!STAGES.includes(stage) || current.current) return { error: new Error("Another cloud operation is in progress.") };
    const controller = new AbortController(), started = Date.now(), task = { controller };
    let outcome = "error", timeout = false, onAbort;
    const retryCount = retries.current[stage] || 0;
    current.current = task;
    setActivity(stage); setElapsed(0);
    const interval = window.setInterval(() => { if (alive.current && current.current === task) setElapsed(Math.floor((Date.now() - started) / 1000)); }, 1000);
    const deadline = window.setTimeout(() => { timeout = true; controller.abort(); }, 30_000);
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const data = await Promise.race([work(controller.signal), interrupted]);
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      outcome = "success"; retries.current[stage] = 0;
      return { data };
    } catch (error) {
      outcome = controller.signal.aborted ? timeout ? "timeout" : "cancelled" : "error";
      retries.current[stage] = retryCount + 1;
      return { error, outcome };
    } finally {
      window.clearInterval(interval); window.clearTimeout(deadline);
      controller.signal.removeEventListener("abort", onAbort);
      record(historyKey, stage, Date.now() - started, outcome, retryCount);
      if (current.current === task) { current.current = null; if (alive.current) setActivity(null); }
    }
  }, [historyKey]);
  return { run, cancel, activity, elapsed };
}
