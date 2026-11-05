import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { recordAuthUiTiming, requestWithin } from "./sitesAuthUi";

const GOOGLE_SCRIPT = "https://accounts.google.com/gsi/client";
const STEP_TIMEOUT_MS = 10_000;
const MEASURED = new Set(["config", "challenge", "loading", "google", "verifying"]);

function googleScript(signal) {
  if (signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let finished = false;
    const script = document.createElement("script");
    const finish = (error) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
      signal.removeEventListener("abort", onAbort);
      if (error) { script.remove(); reject(error); } else resolve();
    };
    const onAbort = () => finish(new DOMException("Cancelled", "AbortError"));
    const timeout = window.setTimeout(() => finish(new Error("Google sign-in did not load.")), STEP_TIMEOUT_MS);
    script.src = GOOGLE_SCRIPT;
    script.async = true;
    script.onload = () => window.google?.accounts?.id ? finish() : finish(new Error("Google sign-in is unavailable."));
    script.onerror = () => finish(new Error("Google sign-in could not load."));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    document.head.appendChild(script);
  });
}

export default function SitesGoogleSignIn({ available }) {
  const [clientId, setClientId] = useState("");
  const [stage, setStage] = useState("config");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [configRetry, setConfigRetry] = useState(0);
  const buttonRef = useRef(null);
  const attemptRef = useRef(null);
  const mountedRef = useRef(true);
  const stageRef = useRef("idle");
  const stageStartedRef = useRef(Date.now());
  const retryRef = useRef(0);

  function move(next, outcome = "complete") {
    if (MEASURED.has(stageRef.current)) {
      recordAuthUiTiming(stageRef.current, Date.now() - stageStartedRef.current, outcome, retryRef.current);
    }
    stageRef.current = next;
    stageStartedRef.current = Date.now();
    setStage(next);
  }

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    async function checkConfig() {
      stageRef.current = "config";
      stageStartedRef.current = Date.now();
      setStage("config");
      try {
        const config = await requestWithin("/api/auth/config", { signal: controller.signal });
        if (!mountedRef.current || controller.signal.aborted) return;
        if (config?.google?.enabled === true && config.google.configured === true &&
          typeof config.google.client_id === "string" && config.google.client_id) {
          setClientId(config.google.client_id);
          move("ready");
        } else move("inactive", "inactive");
      } catch (cause) {
        if (mountedRef.current && !controller.signal.aborted) {
          setError(cause.message);
          move("config-error", cause.message.includes("timed out") ? "timeout" : "error");
        }
      }
    }
    if (available) void checkConfig();
    return () => { controller.abort(); attemptRef.current?.abort(); };
  }, [available, configRetry]);

  useEffect(() => () => {
    mountedRef.current = false;
    if (MEASURED.has(stageRef.current)) {
      recordAuthUiTiming(stageRef.current, Date.now() - stageStartedRef.current, "cancelled", retryRef.current);
      stageRef.current = "unmounted";
    }
  }, []);

  useEffect(() => {
    if (!["config", "challenge", "loading", "google", "verifying"].includes(stage) || !available) return undefined;
    const started = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [stage, available]);

  const current = (controller) => mountedRef.current && !controller.signal.aborted && attemptRef.current === controller;

  function cancel() {
    attemptRef.current?.abort();
    attemptRef.current = null;
    window.google?.accounts?.id?.cancel?.();
    buttonRef.current?.replaceChildren();
    move("ready", "cancelled");
    setError("");
  }

  async function begin() {
    if (attemptRef.current && !attemptRef.current.signal.aborted) return;
    const controller = new AbortController();
    attemptRef.current = controller;
    retryRef.current += 1;
    setError("");
    try {
      move("challenge");
      const challenge = await requestWithin("/api/auth/google/challenge", { signal: controller.signal });
      if (!current(controller)) return;
      if (typeof challenge?.nonce !== "string" || !challenge.nonce) throw new Error("Sign-in could not start. Please try again.");
      move("loading");
      await googleScript(controller.signal);
      if (!current(controller)) return;
      const google = window.google.accounts.id;
      google.initialize({ client_id: clientId, nonce: challenge.nonce, callback: async ({ credential }) => {
        if (!current(controller)) return;
        if (typeof credential !== "string" || !credential) {
          setError("Google did not return an identity response. Please try again.");
          move("error", "error");
          attemptRef.current = null;
          return;
        }
        try {
          move("verifying");
          const session = await requestWithin("/api/auth/google", {
            method: "POST", signal: controller.signal,
            headers: { "Content-Type": "application/json", "x-lct-auth-write": "1" },
            body: JSON.stringify({ credential }),
          });
          if (!current(controller)) return;
          if (session?.authenticated !== true || session.user?.provider !== "google") throw new Error("Sign-in was not confirmed. Please try again.");
          move("complete");
          attemptRef.current = null;
          window.location.reload();
        } catch (cause) {
          if (current(controller)) {
            setError(cause.message);
            move("error", cause.message.includes("timed out") ? "timeout" : "error");
            attemptRef.current = null;
          }
        }
      } });
      if (!current(controller) || !buttonRef.current) return;
      buttonRef.current.replaceChildren();
      google.renderButton(buttonRef.current, { theme: "outline", size: "large", text: "signin_with",
        width: Math.min(280, buttonRef.current.parentElement?.clientWidth || 280) });
      move("google");
    } catch (cause) {
      if (current(controller)) {
        setError(cause.message);
        move("error", cause.message.includes("timed out") ? "timeout" : "error");
        attemptRef.current = null;
      }
    }
  }

  if (!available || stage === "inactive") return null;
  if (stage === "config") return <p role="status" className="mt-2 text-xs text-slate-600">Checking Google sign-in availability · {elapsed}s elapsed · Time remaining unknown</p>;
  if (stage === "config-error") return (
    <div className="mt-2 text-xs">
      <p role="alert" className="text-rose-700">Google sign-in availability could not be checked. {error}</p>
      <button type="button" className="mt-1 text-slate-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700" onClick={() => setConfigRetry((value) => value + 1)}>Retry Google availability</button>
    </div>
  );
  const busy = ["challenge", "loading", "google", "verifying"].includes(stage);
  return (
    <div className="min-w-0 w-full">
      {(stage === "ready" || stage === "error") && <button type="button" className="inline-flex min-h-11 w-full items-center justify-center gap-3 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700" onClick={begin}>
        <svg width="20" height="20" viewBox="0 0 24 24" className="shrink-0" aria-hidden="true" focusable="false">
          <path fill="#4285F4" d="M21.6 12.227c0-.709-.064-1.391-.182-2.045H12v3.868h5.382a4.6 4.6 0 0 1-1.996 3.018v2.509h3.232c1.891-1.741 2.982-4.305 2.982-7.35Z" />
          <path fill="#34A853" d="M12 22c2.7 0 4.964-.895 6.618-2.423l-3.232-2.509c-.895.6-2.041.955-3.386.955-2.605 0-4.81-1.759-5.596-4.123H3.063v2.591A10 10 0 0 0 12 22Z" />
          <path fill="#FBBC05" d="M6.404 13.9A6 6 0 0 1 6.09 12c0-.659.114-1.3.314-1.9V7.509H3.063A10 10 0 0 0 2 12c0 1.614.386 3.141 1.063 4.491L6.404 13.9Z" />
          <path fill="#EA4335" d="M12 5.977c1.468 0 2.786.505 3.823 1.496l2.868-2.868C16.959 2.991 14.695 2 12 2a10 10 0 0 0-8.937 5.509L6.404 10.1C7.19 7.736 9.395 5.977 12 5.977Z" />
        </svg><span>Sign in with Google</span>
      </button>}
      <div ref={buttonRef} className={stage === "google" ? "mt-2 max-w-full" : "hidden"} />
      {busy && <div role="status" className="mt-1 text-xs text-slate-600">
        {stage === "challenge" ? "Starting Google sign-in" : stage === "loading" ? "Loading Google sign-in" : stage === "google" ? "Waiting for Google" : "Verifying sign-in"} · {elapsed}s elapsed · Time remaining unknown
        {elapsed >= 15 && <span className="block">This is taking longer than expected. You can cancel and try again.</span>}
      </div>}
      {busy && <button type="button" className="mt-1 text-xs text-slate-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700" onClick={cancel}>Cancel Google sign-in</button>}
      {stage === "error" && <p role="alert" className="mt-1 text-xs text-rose-700">{error}</p>}
    </div>
  );
}

SitesGoogleSignIn.propTypes = { available: PropTypes.bool.isRequired };
