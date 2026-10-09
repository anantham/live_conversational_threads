import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import SitesGoogleSignIn from "./SitesGoogleSignIn";
import { recordAuthUiTiming, requestWithin } from "./sitesAuthUi";

const SESSION_TIMEOUT_MS = 10_000;
const TIMING_KEY = "lct.sites_session_check_timing.v1";
const TIMING_OUTCOMES = new Set(["guest", "signed-in", "error", "timeout", "cancelled"]);
const DISMISSED_KEY = "lct.sites_access_dismissed.v1";

function wasDismissed() {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

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
  const { pathname, search, hash } = useLocation();
  const inPrivateFiles = pathname === "/private-files" || pathname === "/private-files/";
  const inRecording = pathname === "/new" || pathname === "/new/";
  const [expanded, setExpanded] = useState(() => !wasDismissed() || hash === "#site-access");
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const panelRef = useRef(null);
  const focusOnOpen = useRef(false);
  const focusOnDismiss = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState("checking");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const [signOutElapsed, setSignOutElapsed] = useState(0);
  const signOutRef = useRef(null);
  const signOutRetries = useRef(0);
  const mountedRef = useRef(true);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const openPanel = useCallback(() => {
    if (expandedRef.current) {
      panelRef.current?.focus();
      return;
    }
    focusOnOpen.current = true;
    setExpanded(true);
  }, []);

  useEffect(() => {
    if (expanded && focusOnOpen.current) {
      panelRef.current?.focus();
      focusOnOpen.current = false;
    } else if (!expanded && focusOnDismiss.current) {
      panelRef.current?.querySelector("button")?.focus();
      focusOnDismiss.current = false;
    }
  }, [expanded]);

  function dismissPanel() {
    focusOnDismiss.current = true;
    setExpanded(false);
    try {
      window.localStorage.setItem(DISMISSED_KEY, "true");
    } catch {
      // A storage refusal affects this browser preference only.
    }
  }

  useEffect(() => {
    if (hash === "#site-access") openPanel();
  }, [hash, openPanel]);

  useEffect(() => {
    // Repeated clicks on an unchanged hash do not fire hashchange.
    const onAccessLink = (event) => {
      const link = event.target.closest?.('a[href="#site-access"]');
      if (link) openPanel();
    };
    document.addEventListener("click", onAccessLink);
    return () => document.removeEventListener("click", onAccessLink);
  }, [openPanel]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (signOutRef.current) {
        const pending = signOutRef.current;
        pending.controller.abort();
        recordAuthUiTiming("signout", Date.now() - pending.started, "cancelled", pending.retries);
        signOutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!signingOut) return undefined;
    const timer = window.setInterval(() => {
      if (signOutRef.current) setSignOutElapsed(Math.floor((Date.now() - signOutRef.current.started) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [signingOut]);

  function finishSignOut(pending, outcome) {
    if (signOutRef.current !== pending) return false;
    recordAuthUiTiming("signout", Date.now() - pending.started, outcome, pending.retries);
    signOutRef.current = null;
    if (mountedRef.current) setSigningOut(false);
    return true;
  }

  function cancelSignOut() {
    const pending = signOutRef.current;
    if (!pending) return;
    pending.controller.abort();
    finishSignOut(pending, "cancelled");
    setSignOutError("");
  }

  async function signOut() {
    if (signOutRef.current) return;
    const pending = { controller: new AbortController(), started: Date.now(), retries: ++signOutRetries.current };
    signOutRef.current = pending;
    setSigningOut(true);
    setSignOutElapsed(0);
    setSignOutError("");
    try {
      await requestWithin("/api/auth/logout", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", "x-lct-auth-write": "1" },
        body: "{}", signal: pending.controller.signal,
      });
      if (!mountedRef.current || !finishSignOut(pending, "complete")) return;
      const safePath = pathname.startsWith("/") && !pathname.startsWith("//") ? pathname + search : "/";
      const link = document.createElement("a");
      link.href = `/signout-with-chatgpt?return_to=${encodeURIComponent(safePath)}`;
      link.target = "_top";
      link.click();
    } catch (cause) {
      if (mountedRef.current && signOutRef.current === pending) {
        finishSignOut(pending, cause.message.includes("timed out") ? "timeout" : "error");
        setSignOutError(cause.name === "AbortError" ? "" : "Sign-out could not finish. Please try again.");
      }
    }
  }

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
    <aside ref={panelRef} id="site-access" tabIndex={-1} className={`${inPrivateFiles ? "mx-auto my-4" : inRecording ? `fixed ${expanded ? "top-14" : "top-3"} right-3 z-50` : "fixed bottom-4 right-4 z-50"} ${expanded && !inPrivateFiles ? "max-h-[45dvh] overflow-y-auto" : ""} ${expanded ? "w-[min(22rem,calc(100vw-2rem))] px-4 py-3" : "w-fit px-3 py-2"} rounded-xl bg-white text-sm text-slate-700 shadow-[0_8px_28px_rgba(15,23,42,0.16)]`} aria-label="Site access">
      {!expanded ? <button type="button" className="text-sm font-medium text-slate-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700" onClick={openPanel}>{status === "guest" ? "Sign in" : "Account"}</button> : <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-slate-800">Public access</p>
        <button type="button" className="text-xs text-slate-600 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700" aria-label="Close site access" onClick={dismissPanel}>Close</button>
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
        Sign-in is optional for private files and history. Browse public conversations without an account. Cloud recording and personal uploads are still being connected. Opening browser-local files does not publish them.
      </p>
      <a className="mt-2 inline-flex min-h-8 items-center text-xs font-medium text-slate-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700" href="/privacy">Privacy and data use</a>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-medium">
        {status !== "signed-in" && (
          <a className="text-slate-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700" href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a>
        )}
        {(status === "signed-in" || status === "guest") && (
          <button type="button" disabled={signingOut} className="text-slate-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:opacity-50" onClick={signOut}>{status === "guest" ? "Reset sign-in" : "Sign out"}</button>
        )}
        {status === "error" && (
          <button type="button" className="text-slate-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700" onClick={retry}>Retry sign-in check</button>
        )}
      </div>
      <SitesGoogleSignIn available={status === "guest" && !signingOut} />
      {signingOut && <div className="mt-2 text-xs">
        <p role="status" className="text-slate-600">Signing out · {signOutElapsed}s elapsed · Time remaining unknown</p>
        <button type="button" className="mt-1 text-slate-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700" onClick={cancelSignOut}>Cancel sign-out</button>
      </div>}
      {signOutError && <p role="alert" className="mt-2 text-xs text-rose-700">{signOutError}</p>}
      {status === "error" && <p className="mt-2 text-xs text-slate-600">You can keep browsing public content and browser-local files.</p>}
      </>}
    </aside>
  );
}
