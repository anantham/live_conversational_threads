import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AudioLines, Search } from "lucide-react";
import {
  extractImportedTurns,
  getAudioSourceStatus,
  importAudioSource,
  listAudioSources,
  processAudioSource,
} from "../../services/indrasnetAudioApi";

const PAGE_SIZE = 30;
const POLL_MS = 3000;

function shortDate(value) {
  if (!value) return "Date unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unknown"
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function duration(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return null;
  const seconds = Math.round(Number(value));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}` : `${seconds}s`;
}

function actionLabel(source) {
  if (source.status === "ready") return "Create threads";
  if (source.status === "queued" || source.status === "processing") return "Check progress";
  if (source.can_process) return source.status === "failed" ? "Retry processing" : "Process recording";
  return "Unavailable";
}

function statusLabel(status) {
  return {
    ready: "Transcript ready",
    unprocessed: "Needs transcript",
    queued: "Queued",
    processing: "Transcribing",
    failed: "Processing failed",
    unavailable: "Unavailable",
  }[status] || "Status unknown";
}

export default function IndrasNetAudioLibrary() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [listing, setListing] = useState({ q: "", offset: 0 });
  const [sources, setSources] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [listError, setListError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [action, setAction] = useState(null);
  const [pollingKey, setPollingKey] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [notice, setNotice] = useState("");
  const actionAbort = useRef(null);

  useEffect(() => {
    const timer = setTimeout(() => setListing((current) =>
      current.q === query.trim() && current.offset === 0
        ? current : { q: query.trim(), offset: 0 }), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setListError("");
    listAudioSources({ query: listing.q, offset: listing.offset, limit: PAGE_SIZE, signal: controller.signal })
      .then((body) => {
        const next = Array.isArray(body.sources) ? body.sources : [];
        setSources((previous) => {
          if (listing.offset === 0) return next;
          const seen = new Set(previous.map((source) => source.source_key));
          return [...previous, ...next.filter((source) => !seen.has(source.source_key))];
        });
        setHasMore(Boolean(body.has_more));
      })
      .catch((error) => {
        if (error?.name === "AbortError") return;
        if (error?.status === 503) {
          setAvailable(false);
          return;
        }
        setListError(error?.message || "Could not load recordings.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [listing, refreshKey]);

  useEffect(() => {
    if (!action || action.stage === "failed") return undefined;
    const tick = () => setElapsedSeconds(Math.floor((Date.now() - action.startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [action]);

  useEffect(() => () => actionAbort.current?.abort(), []);

  const updateSource = useCallback((key, status) => {
    setSources((previous) => previous.map((source) =>
      source.source_key === key
        ? { ...source, status: status.status || source.status, can_process: status.can_process ?? source.can_process }
        : source
    ));
  }, []);

  useEffect(() => {
    if (!pollingKey) return undefined;
    const controller = new AbortController();
    let inFlight = false;
    const check = async () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        const status = await getAudioSourceStatus(pollingKey, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (["ready", "queued", "processing", "failed", "unavailable", "unprocessed"].includes(status.status)) {
          updateSource(pollingKey, status);
        }
        if (status.status === "ready") {
          setPollingKey("");
          setAction(null);
          setNotice("Transcript ready. You can create threads now.");
        } else if (status.status === "failed" || status.status === "unavailable") {
          setPollingKey("");
          setAction({ key: pollingKey, kind: "process", stage: "failed",
            startedAt: Date.now(), error: status.error || "Recording processing did not finish." });
        } else if (status.status === "queued" || status.status === "processing") {
          setAction((current) => current?.key === pollingKey
            ? { ...current, stage: status.stage || "Transcribing recording" }
            : current);
        } else {
          setPollingKey("");
          setAction({ key: pollingKey, kind: "process", stage: "failed",
            startedAt: Date.now(), error: "Recording status is unknown. Try checking progress again." });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setPollingKey("");
          setAction({ key: pollingKey, kind: "process", stage: "failed",
            startedAt: Date.now(), error: error?.message || "Could not check recording progress." });
        }
      } finally {
        inFlight = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [pollingKey, updateSource]);

  const processSource = async (source) => {
    if (action && action.stage !== "failed") return;
    setNotice("");
    setAction({ key: source.source_key, kind: "process", stage: "Requesting transcription", startedAt: Date.now() });
    const controller = new AbortController();
    actionAbort.current = controller;
    try {
      const status = await processAudioSource(source.source_key, { signal: controller.signal });
      if (["ready", "queued", "processing", "failed", "unavailable", "unprocessed"].includes(status.status)) {
        updateSource(source.source_key, status);
      }
      if (status.status === "ready") {
        setAction(null);
        setNotice("Transcript ready. You can create threads now.");
      } else if (status.status === "failed" || status.status === "unavailable") {
        setAction({ key: source.source_key, kind: "process", stage: "failed",
          startedAt: Date.now(), error: status.error || "Recording processing could not start." });
      } else if (status.status === "queued" || status.status === "processing") {
        setAction((current) => ({ ...current, stage: status.stage || "Waiting for transcription" }));
        setPollingKey(source.source_key);
      } else {
        setAction({ key: source.source_key, kind: "process", stage: "failed",
          startedAt: Date.now(), error: "Recording status is unknown. Check or retry processing." });
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        setAction({ key: source.source_key, kind: "process", stage: "failed",
          startedAt: Date.now(), error: error?.message || "Could not start processing." });
      }
    } finally {
      if (actionAbort.current === controller) actionAbort.current = null;
    }
  };

  const importSource = async (source, existingConversationId = null) => {
    if (action && action.stage !== "failed") return;
    setNotice("");
    const controller = new AbortController();
    actionAbort.current = controller;
    const startedAt = Date.now();
    let conversationId = existingConversationId;
    setAction({ key: source.source_key, kind: "import", stage: conversationId ? "Building threads" : "Importing transcript", startedAt });
    try {
      if (!conversationId) {
        const saved = await importAudioSource(source.source_key, { signal: controller.signal });
        conversationId = saved.conversation_id;
        if (saved.already_imported && !saved.needs_extraction) {
          navigate("/conversation/" + encodeURIComponent(conversationId));
          return;
        }
        setAction({ key: source.source_key, kind: "import", stage: "Building threads", startedAt, conversationId });
      }
      await extractImportedTurns(conversationId, { signal: controller.signal });
      navigate(`/conversation/${encodeURIComponent(conversationId)}`);
    } catch (error) {
      if (error?.name !== "AbortError") {
        setAction({ key: source.source_key, kind: "import", stage: "failed",
          startedAt, conversationId, error: error?.message || "Could not create threads." });
      }
    } finally {
      if (actionAbort.current === controller) actionAbort.current = null;
    }
  };

  const stopChecking = () => {
    setPollingKey("");
    setAction(null);
    setNotice("Processing continues in IndraSNet. You can check its status later.");
  };

  const onSourceAction = (source) => {
    if (action && action.stage !== "failed") return;
    if (source.status === "ready") {
      const savedId = action?.key === source.source_key && action.kind === "import"
        ? action.conversationId : null;
      void importSource(source, savedId);
    } else if (source.status === "queued" || source.status === "processing") {
      setAction({ key: source.source_key, kind: "process", stage: "Checking transcription",
        startedAt: Date.now(), timeLabel: "checking" });
      setPollingKey(source.source_key);
    } else if (source.can_process) {
      void processSource(source);
    }
  };

  if (!available) return null;

  return (
    <section className="mx-auto mt-10 max-w-2xl border-t border-slate-200 pt-7" aria-labelledby="indrasnet-audio-heading">
      <div className="mb-4">
        <h2 id="indrasnet-audio-heading" className="text-base font-semibold text-slate-800">IndraSNet recordings</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">
          Find a recording, make a transcript if it needs one, then create LCT threads.
        </p>
      </div>

      <label className="relative mb-4 block">
        <span className="sr-only">Search IndraSNet recordings</span>
        <Search aria-hidden="true" size={16} className="pointer-events-none absolute left-3 top-3 text-slate-500" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search recordings"
          className="min-h-11 w-full rounded-lg border border-slate-300 bg-white pl-10 pr-3 text-sm text-slate-800 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
        />
      </label>

      {notice && <p role="status" className="mb-3 text-sm text-emerald-800">{notice}</p>}
      {action && (
        <div role="status" aria-live="polite" className="mb-3 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-950">
          {action.stage === "failed" ? (
            <>
              <p>{action.error}</p>
              {action.kind === "import" && action.conversationId && (
                <button type="button" onClick={() => void importSource({ source_key: action.key }, action.conversationId)}
                  className="mt-2 min-h-11 text-xs font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-amber-700">
                  Retry building threads
                </button>
              )}
            </>
          ) : (
            <>
              <p>{action.stage} · {elapsedSeconds}s {action.timeLabel || "elapsed"} · Time remaining unknown</p>
              {elapsedSeconds >= 300 && <p className="mt-1 text-xs">This is taking longer than usual. You can keep waiting or return later.</p>}
              {action.kind === "process" && pollingKey && (
                <button type="button" onClick={stopChecking}
                  className="mt-2 min-h-11 text-xs font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-amber-700">
                  Stop checking
                </button>
              )}
            </>
          )}
        </div>
      )}

      {listError && (
        <div role="alert" className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-900">
          <p>{listError}</p>
          <button type="button" onClick={() => setRefreshKey((key) => key + 1)}
            className="mt-2 min-h-11 text-xs font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-rose-800">
            Retry loading recordings
          </button>
        </div>
      )}
      {loading && sources.length === 0 && !listError && <p role="status" className="py-5 text-sm text-slate-600">Loading recordings…</p>}
      {!loading && !listError && sources.length === 0 && (
        <p className="py-5 text-sm text-slate-600">No recordings found{listing.q ? " for this search" : ""}.</p>
      )}
      {sources.length > 0 && (
        <ul className="space-y-2">
          {sources.map((source) => {
            const isBusy = action?.key === source.source_key && action.stage !== "failed";
            const anotherActionBusy = action && action.stage !== "failed" && action.key !== source.source_key;
            const metadata = [shortDate(source.recorded_at), duration(source.duration_seconds)].filter(Boolean).join(" · ");
            return (
              <li key={source.source_key} className="flex flex-col gap-3 rounded-lg bg-white px-4 py-3 shadow-[0_3px_14px_rgba(36,41,46,0.07)] sm:flex-row sm:items-center">
                <AudioLines aria-hidden="true" size={18} className="shrink-0 text-amber-700" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-800" title={source.title}>{source.title || "Untitled recording"}</p>
                  <p className="mt-1 text-xs text-slate-600">{metadata} · {statusLabel(source.status)}</p>
                </div>
                <button type="button" disabled={isBusy || anotherActionBusy || (!source.can_process && source.status !== "ready" && source.status !== "queued" && source.status !== "processing")}
                  onClick={() => onSourceAction(source)}
                  className="min-h-11 shrink-0 rounded-md bg-slate-800 px-3 text-xs font-semibold text-white hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
                  {isBusy ? "Working…" : actionLabel(source)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && !listError && (
        <button type="button" disabled={loading} onClick={() => setListing((current) => ({ ...current, offset: current.offset + PAGE_SIZE }))}
          className="mt-4 min-h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50">
          {loading ? "Loading…" : "Load more recordings"}
        </button>
      )}
    </section>
  );
}
