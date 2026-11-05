import { useCallback, useEffect, useRef, useState } from "react";
import { privateRequest, recordPrivateTiming } from "../services/privateFiles";

const TIMEOUT_MS = 30_000;

export function usePrivateFiles() {
  const [status, setStatus] = useState(null);
  const [files, setFiles] = useState([]);
  const [next, setNext] = useState(null);
  const [guest, setGuest] = useState(false);
  const [listed, setListed] = useState(false);
  const [error, setError] = useState("");
  const [activity, setActivity] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [generation, setGeneration] = useState(0);
  const current = useRef(null);
  const mounted = useRef(true);
  const retries = useRef({});

  const run = useCallback(async (operation, path, options = {}) => {
    if (current.current) return { error: new Error("Another private file operation is in progress.") };
    const controller = new AbortController();
    const started = Date.now();
    let outcome = "error";
    let reason = "cancelled";
    const retryCount = retries.current[operation] || 0;
    const task = { controller, setReason: (value) => { reason = value; } };
    current.current = task;
    setActivity(operation);
    setElapsed(0);
    const elapsedTimer = window.setInterval(() => { if (mounted.current && current.current === task) setElapsed(Math.floor((Date.now() - started) / 1000)); }, 1000);
    const timeoutTimer = window.setTimeout(() => { reason = "timeout"; controller.abort(); }, TIMEOUT_MS);
    let onAbort;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const data = await Promise.race([privateRequest(path, { ...options, signal: controller.signal }), interrupted]);
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      outcome = "success";
      retries.current[operation] = 0;
      return { data };
    } catch (cause) {
      outcome = controller.signal.aborted ? reason : "error";
      retries.current[operation] = retryCount + 1;
      return { error: cause, outcome };
    } finally {
      window.clearInterval(elapsedTimer);
      window.clearTimeout(timeoutTimer);
      controller.signal.removeEventListener("abort", onAbort);
      recordPrivateTiming(operation, Date.now() - started, outcome, retryCount);
      if (current.current === task) {
        current.current = null;
        if (mounted.current) setActivity(null);
      }
    }
  }, []);

  const cancel = useCallback(() => {
    if (current.current) {
      current.current.setReason("cancelled");
      current.current.controller.abort();
    }
  }, []);

  const list = useCallback(async (cursor = null, append = false, preserveError = false) => {
    const query = cursor ? `?before=${encodeURIComponent(cursor.before)}&before_id=${encodeURIComponent(cursor.before_id)}` : "";
    const result = await run("list", `/api/cloud/files${query}`);
    if (!mounted.current) return result;
    if (result.data) {
      setListed(true);
      setFiles((old) => append ? [...old, ...result.data.files] : result.data.files);
      setNext(result.data.next);
      setGuest(false);
      if (!preserveError) setError("");
    } else if (result.error?.status === 401) {
      setListed(true);
      setGuest(true);
      setFiles([]);
      setError("");
    } else if (result.error?.code === "storage_inactive") {
      setStatus((old) => ({ ...old, enabled: false }));
    } else if (result.outcome !== "cancelled") setError(result.outcome === "timeout" ? "Private files took too long to load. Retry the list." : result.error.message);
    return result;
  }, [run]);

  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    (async () => {
      const result = await run("status", "/api/cloud/files/status");
      if (stopped) return;
      if (result.data) {
        setStatus(result.data);
        setError("");
        if (result.data.enabled && result.data.configured) await list();
      } else if (result.outcome !== "cancelled") setError(result.outcome === "timeout" ? "Storage status took too long. Retry." : result.error.message);
    })();
    return () => {
      stopped = true;
      mounted.current = false;
      cancel();
      current.current = null;
    };
  }, [cancel, generation, list, run]);

  return { status, files, next, guest, listed, error, setError, activity, elapsed, run, list, cancel, refresh: () => setGeneration((value) => value + 1) };
}
