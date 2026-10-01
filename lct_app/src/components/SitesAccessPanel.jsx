import { useCallback, useEffect, useState } from "react";

const SESSION_TIMEOUT_MS = 10_000;
const TIMING_KEY = "lct.sites_session_check_timing.v1";
const TIMING_OUTCOMES = new Set(["guest", "signed-in", "error", "timeout", "cancelled"]);

// Keep only small, payload-free samples; storage may be unavailable in private browsing.
function recordTiming(durationMs, outcome, retryCount) {
  try {
    const storage = window.localStorage;
    const saved = JSON.parse(storage.getItem(TIMING_KEY) || "[]");
    const previous = Array.isArray(saved) ? saved.filter((sample) =>
      Number.isFinite(sample?.durationMs) &&
      TIMING_OUTCOMES.has(sample?.outcome) &&
      Number.isInteger(sample?.retryCount) && sample.retryCount >= 0,
    ).map((sample) => ({
      durationMs: sample.durationMs,
      outcome: sample.outcome,
      retryCount: sample.retryCount,
    })) : [];
    storage.setItem(TIMING_KEY, JSON.stringify([
      ...previous,
      { durationMs: Math.max(0, Math.round(durationMs)), outcome, retryCount },
    ].slice(-8)));
  } catch {
    // Timing history is optional and must never interrupt public browsing.
  }
}

export default function SitesAccessPanel() {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState("checking");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    let finished = false;
    const controller = new AbortController();
    const startedAt = Date.now();
    setStatus("checking");
    setElapsedSeconds(0);

    const elapsedTimer = window.setInterval(() => {
      if (active) setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    const finish = (result) => {
      if (finished) return;
      finished = true;
      window.clearInterval(elapsedTimer);
      window.clearTimeout(timeoutTimer);
      recordTiming(Date.now() - startedAt, result, attempt);
      if (active) setStatus(result === "timeout" ? "error" : result);
    };
    const timeoutTimer = window.setTimeout(() => {
      controller.abort();
      finish("timeout");
    }, SESSION_TIMEOUT_MS);

    async function checkSession() {
      try {
        const response = await fetch("/api/auth/session", {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!active) return;
        if (response.status === 401) {
          finish("guest");
          return;
        }
        if (response.status !== 200) throw new Error("Session check failed");
        const session = await response.json();
        if (!active) return;
        if (session?.authenticated === true && typeof session.user?.id === "string" && session.user.id.trim()) {
          finish("signed-in");
        } else {
          finish("error");
        }
      } catch {
        if (active) finish("error");
      }
    }

    void checkSession();
    return () => {
      active = false;
      controller.abort();
      finish("cancelled");
    };
  }, [attempt]);

  return (
    <aside className="fixed bottom-4 right-4 z-50 max-h-[45dvh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-xl bg-white px-4 py-3 text-sm text-slate-700 shadow-[0_8px_28px_rgba(15,23,42,0.16)]" aria-label="Site access">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-slate-800">Public access</p>
        {status === "checking" && (
          <span role="status" className="text-xs tabular-nums text-slate-600">
            Checking sign-in · {elapsedSeconds}s elapsed · Time remaining unknown
          </span>
        )}
        {status === "guest" && <span role="status" className="text-xs text-slate-600">Browsing as guest</span>}
        {status === "signed-in" && <span role="status" className="text-xs text-slate-600">Signed in</span>}
        {status === "error" && <span role="alert" className="text-xs text-rose-700">Sign-in check failed</span>}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-600">
        Sign-in is optional for private storage and history. Cloud recording, public sharing and private storage are coming next. Opening browser-local files does not publish them.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-medium">
        {status !== "signed-in" && (
          <a className="text-slate-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700" href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a>
        )}
        {status === "signed-in" && (
          <a className="text-slate-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700" href="/signout-with-chatgpt?return_to=%2F" target="_top">Sign out</a>
        )}
        {status === "error" && (
          <button type="button" className="text-slate-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700" onClick={retry}>Retry sign-in check</button>
        )}
      </div>
      {status === "error" && <p className="mt-2 text-xs text-slate-600">You can keep browsing public content and browser-local files.</p>}
    </aside>
  );
}
