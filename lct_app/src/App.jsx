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

export default function App() {
  // Backend reachability gate. The frontend is public (Vercel) but the
  // backend is served over a private Tailscale network — off-network
  // visitors can load the page but can't reach the API. Probe the health
  // endpoint once on load; show a private-beta message instead of a
  // broken app full of fetch errors.
  const [backendState, setBackendState] = useState("checking");
  const [serverlessKey, setServerlessKey] = useState(() => localStorage.getItem("lct_serverless_key") || "");
  const [serverlessForced, setServerlessForced] = useState(() => localStorage.getItem("lct_serverless_mode_enabled") === "true");

  const activeDataProvider = useMemo(() => {
    const isOffline = backendState === "offline" || backendState === "unreachable";
    if (serverlessKey && (serverlessForced || isOffline)) {
      return new ServerlessDataProvider(serverlessKey);
    }
    return new BackendDataProvider();
  }, [serverlessKey, serverlessForced, backendState]);

  // The .threads viewer (/view) is a fully static, server-free page: it renders a
  // self-contained file client-side and must work with the backend down — and make
  // ZERO /api/ calls. /browse is also exempt: on the public deploy it self-detects
  // the unreachable backend and becomes the .threads opener (see Browse.jsx), so it
  // must render instead of the BetaGate. /share/:token genuinely needs the backend
  // and stays gated.
  const isStaticViewer =
    typeof window !== "undefined" &&
    (window.location.pathname.startsWith("/view") ||
      window.location.pathname.startsWith("/browse"));

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

  if (!isStaticViewer && backendState === "checking") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
      </div>
    );
  }

  if (!isStaticViewer && !serverlessForced && (backendState === "offline" || backendState === "unreachable")) {
    if (!serverlessKey) {
      return (
        <ServerlessGate 
          onEnableServerless={(key) => {
            localStorage.setItem("lct_serverless_key", key);
            localStorage.setItem("lct_serverless_mode_enabled", "true");
            setServerlessKey(key);
            setServerlessForced(true);
          }} 
        />
      );
    }
    // If we have a key but it wasn't forced, an offline backend implicitly forces it below
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
