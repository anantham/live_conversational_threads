import { useCallback, useEffect, useState, useMemo } from "react";
import { BrowserRouter } from "react-router-dom";
import AppRoutes from "./routes/AppRoutes";
import { ByokProvider } from "./contexts/ByokContext.jsx";
import { UploadProvider } from "./contexts/UploadContext";
import UploadToast from "./components/upload/UploadToast";
import BetaGate from "./components/BetaGate";
import ServerlessGate from "./components/ServerlessGate";
import { apiFetch } from "./services/apiClient";
import { DataProviderContext } from "./services/dataProvider";
import { BackendDataProvider } from "./services/BackendDataProvider";
import { ServerlessDataProvider } from "./services/ServerlessDataProvider";
import { isTrialActive, startTrial, trialMsRemaining } from "./services/serverless/serverlessAuth";

export default function App() {
  // Backend reachability gate. The frontend is public (Vercel) but the
  // backend is served over a private Tailscale network — off-network
  // visitors can load the page but can't reach the API. Probe the health
  // endpoint once on load; show a private-beta message instead of a
  // broken app full of fetch errors.
  const [backendState, setBackendState] = useState("checking");
  const [serverlessKey, setServerlessKey] = useState(() => localStorage.getItem("lct_serverless_key") || "");
  const [serverlessForced, setServerlessForced] = useState(() => localStorage.getItem("lct_serverless_mode_enabled") === "true");
  // Free "taste" trial: run on the owner's capped key for a short window before
  // asking for the visitor's own key. Gated on VITE_TRIAL_ENABLED so it only
  // appears once the owner has provisioned a capped OPENAI_TRIAL_KEY in the
  // Vercel proxy env — otherwise trial calls would 401. Active when enabled and
  // the window hasn't elapsed.
  const trialEnabled = import.meta.env.VITE_TRIAL_ENABLED === "true";
  const [trialActive, setTrialActive] = useState(() => trialEnabled && isTrialActive());

  const activeDataProvider = useMemo(() => {
    const isOffline = backendState === "offline" || backendState === "unreachable";
    // Serverless is active with a real key OR during an in-window free trial.
    if ((serverlessKey || trialActive) && (serverlessForced || isOffline)) {
      return new ServerlessDataProvider(serverlessKey);
    }
    return new BackendDataProvider();
  }, [serverlessKey, trialActive, serverlessForced, backendState]);

  // The .threads viewer (/view) is independent of the LCT backend: it renders a
  // self-contained artifact client-side and must work with the backend down. It
  // makes ZERO LCT /api/ calls; a driveFile link may fetch from Google Drive after
  // recipient authorization. /browse is also exempt: it is a stable local-first library
  // whose server-history section may be unavailable without replacing the route.
  // /debate/s is the encrypted-snapshot
  // debate report: it fetches one static ciphertext file and decrypts client-side, so
  // it must render for recipients with no backend (the dynamic /debate/:id stays gated —
  // it reads the conversation API). /share/:token genuinely needs the backend and
  // stays gated.
  const isStaticViewer =
    typeof window !== "undefined" &&
    (window.location.pathname.startsWith("/view") ||
      window.location.pathname.startsWith("/browse") ||
      window.location.pathname === "/debate/s" ||
      window.location.pathname === "/debate/s/");

  const probeBackend = useCallback(async () => {
    setBackendState("checking");
    // A cold Tailscale (DERP) handshake can take several seconds on the first hit,
    // so a single short probe false-negatives into the BetaGate; a retry succeeds
    // once the path is warm. Probe up to 3× — a generous first timeout for the cold
    // handshake, then quick backoff retries — before showing the gate.
    const attempts = [
      { timeout: 12000, delayBefore: 0 },
      { timeout: 6000, delayBefore: 700 },
      { timeout: 6000, delayBefore: 1500 },
    ];
    let lastReason = "unreachable";
    for (const { timeout, delayBefore } of attempts) {
      if (delayBefore) {
        await new Promise((resolve) => setTimeout(resolve, delayBefore));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const resp = await apiFetch("/api/import/health", {
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (resp.ok) {
          setBackendState("online");
          return;
        }
        // Reachable but health not OK (e.g. mid-restart 5xx) — retry, then gate.
        lastReason = "offline";
      } catch (err) {
        clearTimeout(timer);
        // AbortError = our timeout fired → host still cold/unreachable (off
        // Tailscale). Any other error = fast TCP failure → backend process down.
        lastReason = err.name === "AbortError" ? "unreachable" : "offline";
      }
    }
    setBackendState(lastReason);
  }, []);

  useEffect(() => {
    if (isStaticViewer) return;
    void probeBackend();
  }, [probeBackend, isStaticViewer]);

  // When a keyless free trial runs out, drop back to the key gate.
  useEffect(() => {
    if (!trialActive || serverlessKey) return;
    const remaining = trialMsRemaining();
    if (remaining <= 0) {
      setTrialActive(false);
      return;
    }
    const timer = setTimeout(() => setTrialActive(false), remaining + 500);
    return () => clearTimeout(timer);
  }, [trialActive, serverlessKey]);

  if (!isStaticViewer && backendState === "checking") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
      </div>
    );
  }

  const serverlessEligible =
    serverlessForced || backendState === "offline" || backendState === "unreachable";
  if (!isStaticViewer && serverlessEligible && !serverlessKey && !trialActive) {
    return (
      <ServerlessGate
        onEnableServerless={(key) => {
          localStorage.setItem("lct_serverless_key", key);
          localStorage.setItem("lct_serverless_mode_enabled", "true");
          setServerlessKey(key);
          setServerlessForced(true);
        }}
        onStartTrial={trialEnabled ? () => {
          startTrial();
          localStorage.setItem("lct_serverless_mode_enabled", "true");
          setTrialActive(true);
          setServerlessForced(true);
        } : undefined}
      />
    );
  }

  return (
    <BrowserRouter>
      <DataProviderContext.Provider value={activeDataProvider}>
        <ByokProvider>
          <UploadProvider>
            <AppRoutes />
            <UploadToast />
          </UploadProvider>
        </ByokProvider>
      </DataProviderContext.Provider>
    </BrowserRouter>
  );
}
